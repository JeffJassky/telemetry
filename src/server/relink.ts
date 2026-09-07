import type { Model } from 'mongoose';
import type { Registry } from './registry.js';
import type { LinkSubjects } from './emit.js';
import { recordRollup } from './rollups.js';
import type { Logger, TelemetryCounters } from './types.js';

/**
 * The backfill for write-time subject linking (0.5.0) — the operation a host
 * runs ONCE, on the day it configures a `subjectLinker`, to make the records it
 * already has answer the question the new ones can.
 *
 * `subjectLinker` links on the way to disk. That is not an implementation
 * detail, it is the whole reason the hook exists: a lifetime `by:['subject']`
 * rollup is keyed on the subject the record was written WITH, permanently, so a
 * read-time join can reach the raw rows and never the aggregates. Which means a
 * host that adopts linking on a Tuesday has two populations. Records after
 * Tuesday carry `user:u_1` on the row and in a `subjects:['user']` family.
 * Records before it carry `machine:m1` and nothing else, and the family has no
 * member for any of them — so a lifetime milestone is missing every one, and a
 * cohort funnel anchored on `user` reads ZERO for every stage those events
 * feed, while the events sit right there, real and correctly timestamped.
 *
 * Nothing at read time closes that. The aggregate is already written. The rows
 * have to be relinked and the affected rollups replayed, which is this file.
 *
 * Two properties carry the whole design:
 *
 *   1. It reuses `createSubjectLinking()` — the SAME merge `emit()` and
 *      `ingest.ts` run. Dedupe on `type:id`, the declared ref winning whole,
 *      `SUBJECT_MAX`, the timeout, the six counters. A backfill with its own
 *      merge rules would be a second policy that quietly disagrees with the
 *      write path about what a linked row looks like, and the disagreement
 *      would show up as an aggregate nobody can reconcile.
 *
 *   2. It is idempotent BY CONSTRUCTION rather than by bookkeeping. A row that
 *      already carries the linked subject offers it to the merge, the merge
 *      dedupes it, and NOTHING is new — so nothing is written and nothing is
 *      replayed. There is no watermark to corrupt and no marker field to
 *      forget. That matters more here than anywhere else in the package,
 *      because `recordRollup` `$add`s 1 per call: a replay that runs twice
 *      inflates a historical `count` that no reader can distinguish from a real
 *      one. An aggregate that is merely missing data announces itself. An
 *      aggregate that is 1.3× too big does not.
 */

export interface RelinkOptions {
  /**
   * Restrict to these event names. Default: every stored record, whatever its
   * name — including names the registry no longer declares, which are counted
   * in `skipped` (see below) rather than quietly relinked.
   *
   * A name that is not in the registry THROWS, before any I/O. A typo that
   * silently relinks nothing is exactly the failure this package tests for
   * elsewhere: it looks like a clean run.
   */
  names?: string[];
  /** only records at/after this instant (`occurredAt`) */
  since?: Date;
  /**
   * Stop after this many records are EXAMINED — not linked. A cap on work, so
   * an operator can probe a huge collection cheaply; it says nothing about how
   * many rows changed. Default unbounded.
   */
  limit?: number;
  /**
   * Report what would change and write NOTHING. **Defaults to `true`.**
   *
   * This operation mutates historical aggregates, so the short call has to be
   * the safe one — `await t.relink()` tells you what it would do. Writing is
   * the thing you opt into, with `{ dryRun: false }`.
   *
   * A dry run still ASKS the host's linker (there is no other way to know what
   * would link), so `t.counters.subjectsLinked` and its five siblings move.
   * Nothing on disk does.
   */
  dryRun?: boolean;
  /** records fetched per batch, and the `onProgress` cadence. Default 500. */
  batchSize?: number;
  /**
   * Called after each batch with the CUMULATIVE result so far, for progress
   * output on a run that may take hours. Guarded: a printer that throws does
   * not kill the backfill.
   */
  onProgress?: (r: RelinkResult) => void;
}

export interface RelinkResult {
  /** rows read */
  examined: number;
  /** rows that gained at least one subject */
  linked: number;
  /** subjects added in total — two links on one row count twice */
  subjects: number;
  /** rollup documents written (or, under `dryRun`, that would have been) */
  rollups: number;
  /**
   * Rows where the linker answered `[]`. Not a failure — "no link exists" is an
   * answer, and on a backfill it is the expected answer for most rows.
   */
  misses: number;
  /**
   * Rows where the linker threw, rejected, timed out, or answered with
   * something that is not a list of refs. Counted once per ROW, however many
   * ways it went wrong; `t.counters.subjectLinkErrors` / `subjectLinkTimeouts`
   * keep the finer split, including which of the four it was.
   */
  errors: number;
  /**
   * Rows the run declined to offer the linker at all, plus one standing for a
   * run that declined everything.
   *
   * Two things land here. A stored row whose `name` the registry no longer
   * declares: we cannot know which rollup families it once fed, so we cannot
   * replay them, and relinking the row without them would leave the row and its
   * aggregates disagreeing — which is the exact bug this operation exists to
   * fix, inverted. And a call with no `subjectLinker` configured, which returns
   * `skipped: 1` having read nothing: counting the rows it refused to read
   * would mean reading them.
   */
  skipped: number;
}

/** records fetched per batch, and how often `onProgress` fires */
export const RELINK_BATCH_SIZE = 500;

export interface RelinkCtx {
  registry: Registry;
  /** the BASE model — every kind is a discriminator on one collection */
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  counters: TelemetryCounters;
  logger: Logger;
  /** the guarded 0.5.0 merge, or null when no `subjectLinker` is configured */
  linkSubjects: LinkSubjects | null;
}

type SubjectRef = { type: string; id: string; role?: string };

const refKey = (s: { type: string; id: string }) => `${s.type}:${s.id}`;

export function createRelink(ctx: RelinkCtx) {
  const { registry, TelemetryModel, RollupModel, counters, logger, linkSubjects } = ctx;

  return async function relink(opts: RelinkOptions = {}): Promise<RelinkResult> {
    const dryRun = opts.dryRun !== false;
    const batchSize = opts.batchSize ?? RELINK_BATCH_SIZE;
    const result: RelinkResult = {
      examined: 0, linked: 0, subjects: 0, rollups: 0, misses: 0, errors: 0, skipped: 0,
    };

    if (opts.names) {
      const unknown = opts.names.filter((n) => !registry[n]);
      if (unknown.length) {
        throw new Error(
          `telemetry: relink() was given names this registry does not declare: ${unknown.join(', ')}. ` +
          'A name with no spec has no rollup families to replay, so relinking it could only ' +
          'desynchronize its rows from its aggregates. Omit `names` to sweep everything.',
        );
      }
    }

    // Nothing to do, and nothing worth throwing about: a host may call this
    // from a boot path or a cron that does not know how the instance was
    // configured, and "you have no linker" is a fact, not an exception.
    if (!linkSubjects) {
      logger.warn(
        '[telemetry] relink() has no subjectLinker to ask — nothing was read and nothing was ' +
        'written. Configure createTelemetry({ subjectLinker }) first; relink() backfills what ' +
        'that hook would have done, it does not replace it.',
      );
      result.skipped = 1;
      return result;
    }

    // Mongo reads `limit: 0` as NO LIMIT, so a caller asking for zero records
    // would get the entire collection — the one arithmetic mistake in this file
    // that could not be undone. Handled before the query is built.
    if (opts.limit != null && opts.limit <= 0) return result;

    const filter: Record<string, unknown> = {};
    if (opts.names) filter.name = { $in: opts.names };
    if (opts.since) filter.occurredAt = { $gte: opts.since };

    const query = TelemetryModel.find(filter)
      // Pinned to the `_id` index on purpose, and NOT sorted.
      //
      // This cursor updates the very documents it is walking. Left to the
      // planner, a filter on `name` invites an index that a relink MOVES the
      // document within — `{tenantId, subjectKeys, occurredAt}` is multikey on
      // the array we are adding to, so a row could be delivered a second time
      // under its new key. `_id` is the one key our writes never touch, so the
      // scan cannot re-deliver. (A re-delivery would be harmless — the merge
      // dedupes — but it would eat `limit` and inflate `examined`, and a
      // backfill whose progress numbers lie is a backfill nobody trusts.)
      //
      // A `sort({_id: 1})` would express the same thing and risk a blocking
      // in-memory sort on a collection too big for one, which is precisely the
      // collection this operation exists for.
      .hint({ _id: 1 })
      .batchSize(batchSize);
    if (opts.limit != null) query.limit(opts.limit);

    const progress = () => {
      if (!opts.onProgress) return;
      try {
        opts.onProgress({ ...result });
      } catch (e) {
        logger.warn(`[telemetry] relink() onProgress threw — ignored, the backfill continues: ${e}`);
      }
    };

    const cursor = query.cursor();
    let sinceProgress = 0;
    try {
      for await (const doc of cursor) {
        result.examined++;
        sinceProgress++;
        if (sinceProgress >= batchSize) {
          sinceProgress = 0;
          progress();
        }

        const spec = registry[doc.name];
        if (!spec) {
          result.skipped++;
          continue;
        }

        // The host is asked about PLAIN refs, not the mongoose subdocuments —
        // the same shape the write path hands it, so a linker cannot tell a
        // backfill from a live write and cannot behave differently on one.
        const declared: SubjectRef[] = (doc.subjects ?? []).map((s: any) =>
          (s.role ? { type: s.type, id: s.id, role: s.role } : { type: s.type, id: s.id }),
        );

        // Why the counters and not the return value: `LinkSubjects` answers
        // `null` for every outcome that changes nothing — a miss, a throw, a
        // timeout, garbage, and a link the merge deduped away. They are the
        // same value and they are not the same event, so the split is read off
        // the deltas the shared implementation already records. Errors are
        // folded to one per ROW here (a single row can produce several, one per
        // junk entry) because this result counts rows.
        const m0 = counters.subjectLinkMisses;
        const e0 = counters.subjectLinkErrors + counters.subjectLinkTimeouts;
        const merged = await linkSubjects(doc.name, spec, doc.tenantId, declared);
        result.misses += counters.subjectLinkMisses - m0;
        if (counters.subjectLinkErrors + counters.subjectLinkTimeouts > e0) result.errors++;

        if (!merged) continue;

        const had = new Set<string>(declared.map(refKey));
        const mergedKeys: string[] = [];
        const newKeys: string[] = [];
        for (const s of merged) {
          const key = refKey(s);
          if (mergedKeys.includes(key)) continue;
          mergedKeys.push(key);
          if (!had.has(key)) newKeys.push(key);
        }
        // The merge already guarantees this, and asserting it costs nothing: a
        // replay over zero new refs is the one thing that must never happen
        // twice.
        if (!newKeys.length) continue;

        result.linked++;
        result.subjects += newKeys.length;

        // ── the row FIRST, then its aggregates ──
        //
        // The order is the crash policy, and it is not symmetric. Replay first
        // and die before the row is updated, and the re-run finds a row that
        // still looks unlinked, links it again, and adds a SECOND 1 to every
        // count it already moved. Update the row first and die before the
        // replay, and the re-run finds the ref already present, adds nothing,
        // and one record is missing from one rollup.
        //
        // So the second one, always: this operation fails toward an aggregate
        // that is short, never one that is long. A short aggregate can be
        // spotted against the rows it came from. A long one cannot be spotted
        // at all.
        //
        // Written through `updateOne` rather than `doc.save()` deliberately —
        // saving would re-run `pre('validate')`, which re-parses `attrs` and
        // `data` against TODAY's registry. A registry that has tightened since
        // these rows were written would quarantine historical records that were
        // valid when they landed, and a backfill has no business deleting the
        // history it was asked to repair. `subjectKeys` is derived here by the
        // same rule that hook uses, because the rollup fan-out reads
        // `subjectKeys` and a row updated without it relinks and still
        // aggregates to nothing.
        if (!dryRun) {
          await TelemetryModel.updateOne(
            { _id: doc._id },
            { $set: { subjects: merged, subjectKeys: mergedKeys } },
          );
        }

        // In memory only, and never saved: the fan-out must see the NEW refs
        // and nothing else. `recordRollup` adds 1 per (document, subject) it is
        // handed, so handing it the merged list would re-count every subject
        // the original write already counted — the double that this whole file
        // is arranged to prevent.
        doc.subjectKeys = newKeys;

        for (const r of spec.rollups ?? []) {
          // A family that does not group by `subject` counted this record once
          // at write time and cannot gain a group from a new one — its dims are
          // attrs and fields that have not changed. Replaying it would be a
          // straight double. This one line is the exactly-once condition;
          // everything else follows from the merge.
          if (!r.by.includes('subject')) continue;
          // A `subjects` filter that does not admit any of the new refs leaves
          // recordRollup with an empty fan-out, which it declines. That is what
          // keeps a family the ORIGINAL subjects already satisfied untouched:
          // it is never handed those subjects again.
          result.rollups += await recordRollup(RollupModel, doc, doc.name, r, counters, { dryRun });
        }
      }
    } finally {
      await cursor.close().catch(() => {});
    }

    if (sinceProgress) progress();
    return result;
  };
}
