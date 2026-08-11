import type { Model } from 'mongoose';
import {
  TelemetryKind, SAMPLE_RATE, newId, traceKeep, plain,
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
 * the thing happened — so they must never bend an aggregate. Usage is the one
 * inversion: its rollups run AFTER the durable write, because the idempotency
 * dedupe must also gate aggregation (a retried usage row is the same money).
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
  [k: string]: unknown;
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

  return async function emit(name: string, doc: EmitInput): Promise<void> {
    const spec = registry[name];
    if (!spec) {
      // unregistered names quarantine rather than throw — the caller may be a
      // stale client; the operator finds it in rejects + counters
      counters.rejected++;
      ctx.track(
        rejects()
          .insertOne({ at: new Date(), name, reason: 'unregistered event', raw: plain(doc) })
          .catch(() => {}),
      );
      return;
    }
    const kind = spec.kind;
    const baseRate = spec.sampleRate ?? SAMPLE_RATE[kind];

    // a span carrying money or an error must survive, or the usage→span join dangles
    const forced =
      !!doc.forceKeep ||
      kind === TelemetryKind.Usage ||
      !!doc.error ||
      (doc.metrics as any)?.cost_usd != null;

    const Model = byKind[kind];
    const { forceKeep: _drop, ...rest } = doc;

    // `...rest` FIRST. Spreading it last would let a caller override `forced`,
    // `sampleRate`, `name`, or `_id` — and a cost-bearing span passed
    // forced:false gets sampled away, dangling the usage→span join (ops rule 6).
    // Dotted keys sanitized HERE, not just in the hook — mongoose Map casting
    // rejects "." keys at assignment, which is before pre('validate') runs.
    const safe = (o?: Record<string, unknown>) =>
      new Map(Object.entries(o ?? {}).map(([k, v]) => [k.replace(/\./g, '_'), v]));
    const payload = {
      ...rest,
      _id: newId(),
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
      return;
    }

    const rollup = () => {
      for (const r of spec.rollups ?? []) {
        ctx.track(recordRollup(RollupModel, d, name, r, counters).catch(onFail));
      }
    };

    // Usage: durable first, rollup after — the idempotency dedupe must gate
    // aggregation, or a retried usage row counts the same money twice.
    if (kind === TelemetryKind.Usage) {
      try {
        await d.save({ writeConcern: { w: 'majority', j: true } } as any); // durable. money.
        rollup();
      } catch (e: any) {
        if (isDuplicateKey(e)) return; // dedupe working — no re-count
        await onFail(e);
        throw e;
      }
      return;
    }

    // ── aggregate plane: unconditional ──
    rollup();

    // ── evidence plane: sampling verdict, then burst cap ──
    if (!forced && !traceKeep(doc.traceId as string | undefined, baseRate)) {
      counters.sampled++;
      return;
    }

    // Cost-bearing records are exempt from the cap — the usage→span join
    // outranks storm control, and money volume is bounded by spend anyway.
    const burst = spec.burst;
    if (burst && (doc.metrics as any)?.cost_usd == null) {
      const v = burst.key ? resolveDim(burst.key, d) : '';
      if (!burstAllow(`${doc.tenantId}|${name}|${v ?? ''}`, burst.maxPerMinute)) {
        counters.capped++;
        return;
      }
    }

    // hook already ran; skip the re-validate on save. Fire-and-forget, but
    // never silent — failures quarantine, and t.flush() awaits stragglers.
    ctx.track(d.save({ validateBeforeSave: false }).catch(onFail));
  };
}

export function isDuplicateKey(e: any): boolean {
  return e?.code === 11000 || e?.cause?.code === 11000;
}
