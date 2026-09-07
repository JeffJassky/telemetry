import type { Model } from 'mongoose';
import {
  TelemetryKind, COUNTER_MAP_MAX, RESERVED_TENANT_MESSAGE, SAMPLE_RATE, bumpCounterMap,
  isPlatformScope, newId, traceKeep, plain,
  type TelemetryCounters, type Logger,
} from './types.js';
import type { EventSpec, Registry } from './registry.js';
import { recordRollup, resolveDim } from './rollups.js';

/**
 * Per-kind durability, the aggregate/evidence split, and (dormant) sampling
 * (schema §4.6). A record passes through two independent decisions:
 *
 *   1. Aggregate plane — rollups. See every VALID record, unconditionally.
 *   2. Evidence plane — the raw row. Subject to sampling and the burst cap.
 *
 * Sampling and capping are decisions about storing evidence, not about whether
 * the thing happened — so they must never bend an aggregate. Two inversions
 * exist, and both are the same rule: when the INSERT is the dedupe, the insert
 * must gate aggregation too. `kind=usage` (unique idempotencyKey) and any
 * record carrying a `dedupeKey` therefore save first and roll up after — a
 * retried usage row is the same money, and a redelivered webhook is the same
 * event. Idempotency that still lets rollups run twice does not fix the bug.
 */

export interface EmitCtx {
  registry: Registry;
  byKind: Record<TelemetryKind, Model<any>>;
  RollupModel: Model<any>;
  rejects: () => { insertOne(doc: any): Promise<unknown> };
  counters: TelemetryCounters;
  logger: Logger;
  /** in-flight fire-and-forget writes, awaited by t.flush() */
  track: (p: Promise<unknown>) => void;
  /** write-time subject linking, or null when no `subjectLinker` is configured */
  linkSubjects?: LinkSubjects | null;
}

export interface EmitInput {
  tenantId: string;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  attrs?: Record<string, string>;
  metrics?: Record<string, number>;
  /** keep despite sampling — set automatically for money/errors */
  forceKeep?: boolean;
  /**
   * Caller idempotency for event/state/span/error. Trusted SERVER callers only
   * — the wire path dedupes on the client `_id` instead. Deterministic per
   * logical occurrence, e.g. `stripe:${event.id}` or `lifecycle:${accountId}:${day}`.
   */
  dedupeKey?: string;
  /** await the write with {w:'majority', j:true} and rethrow — overrides EventSpec.durable */
  durable?: boolean;
  [k: string]: unknown;
}

/** What emit() did. `Promise<void>` could not distinguish "written" from "queued". */
export interface EmitResult {
  /** the record _id — usable for correlation even when the row was not stored */
  id: string;
  /**
   * written  — BOTH planes are on disk and awaited: the row, and its rollups.
   *            Readable immediately, with no flush(). One meaning, on every
   *            path that returns it — durable specs, kind=usage, and
   *            insert-gated dedupeKey writes alike.
   *            A rollup that FAILS is quarantined and counted rather than
   *            thrown, as on every other path — awaiting an aggregate must not
   *            turn its failure into a report that the row does not exist.
   * queued   — validated and aggregated; the save is in flight, t.flush() awaits it
   * deduped  — dedupeKey already present: nothing written, nothing aggregated
   * sampled  — evidence plane declined; aggregates were still updated
   * capped   — burst cap declined; aggregates were still updated
   * rejected — unregistered or failed validation; quarantined in the rejects collection
   */
  outcome: 'written' | 'queued' | 'deduped' | 'sampled' | 'capped' | 'rejected';
}

/**
 * Count attrs keys the record's spec does not declare, BEFORE anything parses
 * them.
 *
 * What actually happens to those keys, so nobody has to guess: model.ts's
 * pre('validate') hook parses `attrs` as `spec.attrs.strict()`, so an
 * undeclared key is a validation FAILURE — the whole record is quarantined and
 * counted in `rejected`. Nothing is silently stripped, and a spec declaring no
 * `attrs` at all refuses any attrs the same way (`"x" declares no attrs`).
 *
 * So this counter is not the only trace of the drop; it is the GROUPING of it.
 * The quarantine lists 41 failed writes one row at a time and a human reads
 * none of them; this says "all 41 carried `codec`", which is a zod line the
 * System page can hand you (see suggest.ts).
 *
 * Keys are sanitized the way the writer sanitizes them (dots → underscores, as
 * mongoose Map keys demand), or a client's `gen_ai.model` would read as
 * undeclared against a perfectly well declared `gen_ai_model`.
 */
export function noteUndeclaredAttrs(
  counters: TelemetryCounters,
  name: string,
  spec: Pick<EventSpec, 'attrs'>,
  attrs: unknown,
): void {
  if (!attrs || typeof attrs !== 'object') return;
  const keys = attrs instanceof Map ? [...attrs.keys()] : Object.keys(attrs);
  const shape = (spec.attrs as { shape?: Record<string, unknown> } | undefined)?.shape;
  for (const raw of keys) {
    const key = String(raw).replace(/\./g, '_');
    if (shape && Object.prototype.hasOwnProperty.call(shape, key)) continue;
    // bounded: the key half is client-controlled, so it folds past the cap
    bumpCounterMap(counters.undeclaredAttrs, `${name}|${key}`);
  }
}

// ── write-time subject linking ───────────────────────────────────────────────

/**
 * The host's answer to "who else is this record about?", asked once per record,
 * on the way to disk.
 *
 * NOT `SubjectAdapter` (dashboard.ts), which labels refs at READ time and
 * changes nothing about what is stored. This one changes the row.
 *
 * The failure mode it exists for: a desktop client knows its install and
 * nothing else, so every record it sends carries `machine:<installId>` and no
 * `user`. The host can map most of those to an account — but doing that at read
 * time leaves a cohort funnel anchored on `user` reading zero for every desktop
 * stage. `import.completed` is there in volume and invisible to the only
 * question anyone asked of it. Joining at write time puts the party on the row
 * AND on its rollups, and the rollups are the half a read-time join can never
 * reach: a lifetime `by:['subject']` family is keyed on the subject the record
 * was written with, forever.
 */
export interface SubjectLinker {
  /**
   * Additional subjects to attach to a record being written. Return `[]` when
   * nothing links — that is an answer, and it is counted as one.
   *
   * MUST be fast, and is expected to be CACHED. It runs on the ingest hot path,
   * once per record, and the package bounds it rather than trusting it: a throw
   * or an overrun writes the record unlinked. It should not throw; the package
   * guards anyway.
   */
  link(
    subjects: Array<{ type: string; id: string; role?: string }>,
    ctx: { name: string; tenantId: string },
  ):
    | Array<{ type: string; id: string; role?: string }>
    | Promise<Array<{ type: string; id: string; role?: string }>>;
}

type SubjectRef = { type: string; id: string; role?: string };

/**
 * Total subjects one record may carry once linking has run. The envelope is
 * multi-party by design, but `subjectKeys` is a multikey index term and every
 * subject fans a `by:['subject']` rollup out one more time — so an unbounded
 * array is an unbounded write amplification with a host's cache bug behind it.
 */
export const SUBJECT_MAX = 8;

/** what link() gets before the record is written unlinked */
export const SUBJECT_LINK_TIMEOUT_MS = 50;

/** merged subjects to write, or null when nothing changed */
export type LinkSubjects = (
  name: string,
  spec: Pick<EventSpec, 'subjects'>,
  tenantId: string,
  declared: unknown,
) => Promise<SubjectRef[] | null>;

/** the race token — a Symbol so no host error can ever impersonate a timeout */
const LINK_TIMEOUT = Symbol('telemetry.subjectLink.timeout');

/**
 * Wrap a host `SubjectLinker` in the guarantees the write path needs.
 *
 * Returns `null` — not a pass-through — when no linker is configured, so a host
 * without one runs the code 0.4.0 ran rather than an extra `await` per record.
 *
 * Every failure resolves the same way: write the record with the subjects it
 * came with, and count. Ingest is at-least-once and unattended, so a resolver
 * that hangs must cost a record its `user` and never its existence — an
 * unlinked row is a worse row, a dropped row is a lie about what happened.
 */
export function createSubjectLinking(opts: {
  linker?: SubjectLinker;
  timeoutMs?: number;
  counters: TelemetryCounters;
  logger: Logger;
}): LinkSubjects | null {
  const { linker, counters, logger } = opts;
  if (!linker) return null;
  const timeoutMs = opts.timeoutMs ?? SUBJECT_LINK_TIMEOUT_MS;

  // Once per reason, ever. This fires from the write path, so a line per record
  // IS the outage — and none of these are things a human reads twice. The set
  // is bounded for the same reason the counter maps are: one of the keys
  // carries an event name and a subject type.
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string) => {
    if (warned.has(key) || warned.size >= COUNTER_MAP_MAX) return;
    warned.add(key);
    logger.warn(msg);
  };

  return async function linkSubjects(name, spec, tenantId, declared) {
    const have: SubjectRef[] = Array.isArray(declared) ? declared : [];

    // The host is asked about a COPY of the well-formed refs. Handing it the
    // array that is about to be written would make a stray `push` in someone
    // else's memo cache a mutation of this record; malformed entries are left
    // out because validation is about to reject them anyway and the host should
    // not have to defend against them.
    const seen = new Set<string>();
    const view: SubjectRef[] = [];
    for (const s of have) {
      const ref = wellFormed(s);
      if (!ref) continue;
      seen.add(`${ref.type}:${ref.id}`);
      view.push(ref);
    }

    let out: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      out = await Promise.race([
        // the async wrapper turns a SYNCHRONOUS throw into a rejection, so a
        // linker that dies on its first line lands in the same catch as one
        // whose promise rejects
        (async () => linker.link(view, { name, tenantId }))(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(LINK_TIMEOUT), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (e === LINK_TIMEOUT) {
        counters.subjectLinkTimeouts++;
        warnOnce(
          'timeout',
          `[telemetry] subjectLinker.link() exceeded ${timeoutMs}ms — records are being written ` +
          'UNLINKED rather than waiting. The hook is expected to answer from a cache; a resolver ' +
          'that queries per record cannot keep up with ingest. Warned once — the count is ' +
          'counters.subjectLinkTimeouts.',
        );
      } else {
        counters.subjectLinkErrors++;
        warnOnce(
          'threw',
          `[telemetry] subjectLinker.link() threw — records are being written unlinked: ${e}. ` +
          'Warned once — the count is counters.subjectLinkErrors.',
        );
      }
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!Array.isArray(out)) {
      counters.subjectLinkErrors++;
      warnOnce(
        'shape',
        `[telemetry] subjectLinker.link() resolved to ${typeof out}, not an array — records are ` +
        'being written unlinked. Return [] when nothing links. Warned once — the count is ' +
        'counters.subjectLinkErrors.',
      );
      return null;
    }
    if (!out.length) {
      counters.subjectLinkMisses++;
      return null;
    }

    // Room is measured against what the record already declares, so a caller
    // that arrives at the cap loses its LINKS and keeps its own subjects — the
    // host's own refs are never displaced by a derived one.
    let room = Math.max(0, SUBJECT_MAX - have.length);
    let capped = 0;
    const add: SubjectRef[] = [];

    for (const s of out) {
      const ref = wellFormed(s);
      if (!ref) {
        counters.subjectLinkErrors++;
        warnOnce(
          'entry',
          '[telemetry] subjectLinker returned an entry that is not { type, id } — dropped. ' +
          'Warned once — the count is counters.subjectLinkErrors.',
        );
        continue;
      }
      // A ref the record already carries is never doubled, and the DECLARED one
      // survives whole — including its `role`, which the caller knew and the
      // linker is guessing at.
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue;

      // A linked type the registry does not declare is REFUSED, not written.
      // The registry is the description of what rows contain; a write path that
      // can quietly add a type nobody declared makes it a description of what
      // rows used to contain.
      if (!spec.subjects.includes(ref.type)) {
        counters.subjectLinkUndeclared++;
        warnOnce(
          `undeclared|${name}|${ref.type}`,
          `[telemetry] subjectLinker returned subject type "${ref.type}" for "${name}", which ` +
          'does not declare it — the subject was dropped and the record written with what it ' +
          'came with. Read this before "fixing" it: `EventSpec.subjects` is a REQUIRED list, so ' +
          `adding "${ref.type}" there also makes it mandatory, and every record of this name ` +
          'whose link MISSES would then fail validation and be quarantined. Declare it only ' +
          'where the link is total. Warned once per event and type — the count is ' +
          'counters.subjectLinkUndeclared.',
        );
        continue;
      }
      if (room <= 0) {
        capped++;
        continue;
      }
      seen.add(key);
      room--;
      add.push(ref);
    }

    counters.subjectLinkCapped += capped;
    // Nothing survived. Deliberately NOT counted as a miss: a miss is the host
    // saying no link exists, which is a different fact from a link it named and
    // the package refused.
    if (!add.length) return null;
    counters.subjectsLinked += add.length;
    return [...have, ...add];
  };
}

/** a ref the envelope can actually store, copied — or null */
function wellFormed(s: unknown): SubjectRef | null {
  if (!s || typeof s !== 'object') return null;
  const { type, id, role } = s as SubjectRef;
  if (typeof type !== 'string' || !type) return null;
  if (typeof id !== 'string' || !id) return null;
  return typeof role === 'string' && role ? { type, id, role } : { type, id };
}

export function createEmitter(ctx: EmitCtx) {
  const { registry, byKind, RollupModel, rejects, counters } = ctx;

  /** per-process token buckets — a storm cap, approximate on purpose, not an SLA */
  const burstBuckets = new Map<string, { n: number; resetAt: number }>();
  const burstAllow = (key: string, maxPerMinute: number): boolean => {
    const now = Date.now();
    let b = burstBuckets.get(key);
    if (!b || now >= b.resetAt) {
      if (burstBuckets.size > 10_000) burstBuckets.clear(); // storm of DISTINCT keys
      b = { n: 0, resetAt: now + 60_000 };
      burstBuckets.set(key, b);
    }
    return ++b.n <= maxPerMinute;
  };

  return async function emit(name: string, doc: EmitInput): Promise<EmitResult> {
    // minted up front so every return path — including the ones that store
    // nothing — can hand the caller an id to correlate on
    const id = newId();

    /** quarantine + count, without the document (nothing is hydrated yet) */
    const reject = (reason: string): EmitResult => {
      counters.rejected++;
      ctx.track(
        rejects().insertOne({ at: new Date(), name, reason, raw: plain(doc) }).catch(() => {}),
      );
      return { id, outcome: 'rejected' };
    };

    // '*' is the dashboard's cross-tenant READ scope; a row carrying it would
    // turn a tenant name into a privilege escalation. Quarantined rather than
    // thrown for the same reason everything else here is: hosts call emit()
    // fire-and-forget, and an unhandled rejection on attacker-shaped input is a
    // way to stop the process. The refusal is loud where it counts — counters,
    // quarantine, the System page — and nothing is written either way.
    if (isPlatformScope(doc.tenantId)) return reject(RESERVED_TENANT_MESSAGE);

    const spec = registry[name];
    // unregistered names quarantine rather than throw — the caller may be a
    // stale client; the operator finds it in rejects + counters
    if (!spec) return reject('unregistered event');

    const dedupeKey = doc.dedupeKey;
    if (dedupeKey !== undefined && (typeof dedupeKey !== 'string' || !dedupeKey || dedupeKey.length > 200)) {
      return reject('dedupeKey must be a non-empty string of at most 200 chars');
    }

    const kind = spec.kind;
    const baseRate = spec.sampleRate ?? SAMPLE_RATE[kind];

    // A span carrying money or an error must survive, or the usage→span join
    // dangles. A record with a dedupeKey must survive for a subtler reason: its
    // AGGREGATION is gated on its own insert (below), so sampling or capping the
    // evidence away would take the rollup with it — the aggregate would silently
    // lose the record instead of merely losing the row. dedupeKey therefore
    // implies forced: never sampled, never burst-capped.
    const forced =
      !!doc.forceKeep ||
      kind === TelemetryKind.Usage ||
      !!doc.error ||
      dedupeKey != null ||
      (doc.metrics as any)?.cost_usd != null;

    // per-call override beats the spec; usage is durable either way
    const durable = kind === TelemetryKind.Usage || (doc.durable ?? spec.durable ?? false);

    const Model = byKind[kind];
    // `durable` is a routing instruction, not data — destructured out the same
    // way forceKeep is, so it never lands on the document. `dedupeKey` is NOT:
    // it is a stored, indexed field and rides through in `rest`.
    const { forceKeep: _drop, durable: _durable, ...rest } = doc;

    // ── write-time subject linking ──
    // HERE, and not after hydration, because the merged subjects have to be on
    // the document before pre('validate') derives `subjectKeys` — and
    // subjectKeys is what recordRollup fans a `by:['subject']` family out over.
    // Link any later and the row carries a party its own milestone rollup has
    // never heard of, which is the read/write split this feature exists to
    // close.
    //
    // Bounded, guarded, and never fatal: see createSubjectLinking(). One
    // ordering consequence is worth stating rather than discovering — on the
    // insert-gated path below, the INSERT is the dedupe verdict, so a record
    // that turns out to be a redelivery has already asked the linker by the
    // time it learns nothing will be written. It writes nothing and aggregates
    // nothing, as before; the cost of the duplicate is one cached lookup.
    const linked = ctx.linkSubjects
      ? await ctx.linkSubjects(name, spec, doc.tenantId, doc.subjects)
      : null;

    // `...rest` FIRST. Spreading it last would let a caller override `forced`,
    // `sampleRate`, `name`, or `_id` — and a cost-bearing span passed
    // forced:false gets sampled away, dangling the usage→span join (ops rule 6).
    // Dotted keys sanitized HERE, not just in the hook — mongoose Map casting
    // rejects "." keys at assignment, which is before pre('validate') runs.
    const safe = (o?: Record<string, unknown>) =>
      new Map(Object.entries(o ?? {}).map(([k, v]) => [k.replace(/\./g, '_'), v]));
    const payload = {
      ...rest,
      _id: id,
      name,
      // computed like everything below it, and absent when nothing linked, so a
      // host with no linker hands the model the exact object 0.4.0 did
      ...(linked ? { subjects: linked } : {}),
      sampleRate: forced ? 1 : baseRate,
      forced,
      attrs: safe(doc.attrs),
      metrics: safe(doc.metrics),
    };

    // Observed before hydration, because the hook below is where they die.
    noteUndeclaredAttrs(counters, name, spec, doc.attrs);

    const onFail = async (e: unknown) => {
      counters.rejected++;
      // plain() first — JSON.stringify(Map) is '{}' and would erase every subject
      await rejects()
        .insertOne({ at: new Date(), name, reason: String(e), raw: plain(doc) })
        .catch(() => {});
    };

    // Hydrate + validate ONCE, for every record — kept, sampled, or capped.
    // The pre('validate') hook derives subjectKeys, sanitizes dotted attr keys,
    // and runs the registry checks, so the aggregate plane below never sees an
    // invalid or under-derived record.
    const d = new Model(payload);
    try {
      await d.validate();
    } catch (e) {
      await onFail(e);
      if (kind === TelemetryKind.Usage) throw e; // caller must know
      return { id, outcome: 'rejected' };
    }

    /**
     * Fire the aggregate plane and HAND BACK the writes, so a `durable` emit can
     * await them (below). Still tracked either way — t.flush() drains them for
     * everyone else.
     *
     * A rollup failure stays a quarantine-and-count, never a throw, on every
     * path including durable: the row is already on disk by then, and turning a
     * failed aggregate into an exception would tell the caller nothing was
     * written when something was. Drops are reported through counters and the
     * rejects collection, as everywhere else.
     */
    const rollup = (): Promise<unknown>[] =>
      (spec.rollups ?? []).map((r) => {
        const p = recordRollup(RollupModel, d, name, r, counters).catch(onFail);
        ctx.track(p);
        return p;
      });

    // hook already ran; skip the re-validate on save
    const saveOpts = {
      validateBeforeSave: false,
      ...(durable ? { writeConcern: { w: 'majority', j: true } } : {}),
    } as any;

    // ── insert-gated: the write IS the dedupe, so it must precede the rollup ──
    // Usage (unique idempotencyKey) and any record with a dedupeKey. A
    // duplicate returns having aggregated NOTHING; that is the entire point.
    // The save is awaited here whether or not `durable` was asked for — gating
    // requires it — so the outcome is 'written', never 'queued'; `durable` adds
    // the write concern and the rethrow on top.
    if (kind === TelemetryKind.Usage || dedupeKey != null) {
      try {
        await d.save(saveOpts);
      } catch (e: any) {
        if (isDuplicateKey(e)) {
          counters.deduped++; // dedupe working — no row, no re-count
          return { id, outcome: 'deduped' };
        }
        await onFail(e);
        if (durable) throw e; // money, and anything else the caller chose to await
        return { id, outcome: 'rejected' };
      }
      // Aggregates awaited too, and NOT only when `durable` — because this
      // branch returns 'written', and that outcome has to mean one thing. A
      // gated write whose rollups were still in flight would be 'written' with
      // a weaker guarantee than the durable path's 'written', which is the
      // exact ambiguity Promise<void> had before EmitResult replaced it.
      //
      // The cost is one round trip per rollup family on a write that already
      // awaited its insert, and kind=usage — unconditionally durable, and the
      // case that matters most, since usage rollups are money — was paying it
      // regardless. Callers who do not want to wait have `queued`.
      await Promise.all(rollup());
      return { id, outcome: 'written' };
    }

    // ── aggregate plane: unconditional ──
    const aggregates = rollup();

    // ── evidence plane: sampling verdict, then burst cap ──
    if (!forced && !traceKeep(doc.traceId as string | undefined, baseRate)) {
      counters.sampled++;
      return { id, outcome: 'sampled' };
    }

    // Cost-bearing records are exempt from the cap — the usage→span join
    // outranks storm control, and money volume is bounded by spend anyway.
    const burst = spec.burst;
    if (burst && (doc.metrics as any)?.cost_usd == null) {
      const v = burst.key ? resolveDim(burst.key, d) : '';
      if (!burstAllow(`${doc.tenantId}|${name}|${v ?? ''}`, burst.maxPerMinute)) {
        counters.capped++;
        return { id, outcome: 'capped' };
      }
    }

    // Declared durable: await the row and rethrow, so a host whose cost ledger
    // is a span can await THIS write instead of t.flush(), which drains every
    // in-flight write globally and serializes a busy worker.
    //
    // The ROLLUPS are awaited here too. `durable` exists to remove the race
    // between "the emit resolved" and "the data is readable", and a host that
    // awaited the row and then read the aggregate could otherwise legitimately
    // see a stale one — the same race, one plane over.
    if (durable) {
      try {
        await d.save(saveOpts);
      } catch (e) {
        await onFail(e);
        throw e;
      }
      await Promise.all(aggregates);
      return { id, outcome: 'written' };
    }

    // Fire-and-forget, but never silent — failures quarantine, and t.flush()
    // awaits stragglers.
    ctx.track(d.save(saveOpts).catch(onFail));
    return { id, outcome: 'queued' };
  };
}

export function isDuplicateKey(e: any): boolean {
  return e?.code === 11000 || e?.cause?.code === 11000;
}
