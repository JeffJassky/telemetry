import type { Model } from 'mongoose';
import {
  TelemetryKind, RESERVED_TENANT_MESSAGE, SAMPLE_RATE, isPlatformScope, newId, traceKeep, plain,
  type TelemetryCounters, type Logger,
} from './types.js';
import type { Registry } from './registry.js';
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
      sampleRate: forced ? 1 : baseRate,
      forced,
      attrs: safe(doc.attrs),
      metrics: safe(doc.metrics),
    };

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
