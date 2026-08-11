import type { Model } from 'mongoose';
import type { Registry } from './registry.js';

/**
 * The five read primitives (dashboards §2). Everything the UI renders comes
 * through these — kind pages never touch Mongo, which is the seam that lets
 * span/event route to a columnar store later without touching a component.
 *
 * Traps §18 is law here: every primitive requires a time range and carries its
 * `$limit` INSIDE the pipeline; the caps are config, the slow-query counter is
 * an adapter. Every response reports `dataSource` (recon #2) so a spliced
 * number can always say which store answered.
 */

export interface QueryLimits {
  records: number;
  series: number;
  rollups: number;
  trace: number;
  journey: number;
}

export const DEFAULT_LIMITS: QueryLimits = {
  records: 200,
  series: 744, // a month of hourly buckets
  rollups: 500,
  trace: 500,
  journey: 500,
};

export interface RecordFilter {
  kind?: string;
  name?: string;
  severity?: string;
  env?: string;
  service?: string;
  release?: string;
  /** pin to one subject: 'user:u_1' */
  subject?: string;
  traceId?: string;
  /** equality on declared attrs */
  attrs?: Record<string, string>;
  /** range on declared metrics */
  metrics?: Record<string, { gte?: number; lte?: number }>;
  /** the customer toggle: exclude these actor TYPES ('admin', 'system') */
  excludeActorTypes?: string[];
}

export interface TimeRange {
  from: Date;
  to: Date;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildMatch(tenantId: string, range: TimeRange, f: RecordFilter): Record<string, unknown> {
  const match: Record<string, any> = {
    tenantId,
    occurredAt: { $gte: range.from, $lt: range.to },
  };
  for (const k of ['kind', 'name', 'severity', 'env', 'service', 'release', 'traceId'] as const) {
    if (f[k]) match[k] = f[k];
  }
  if (f.subject) match.subjectKeys = f.subject;
  for (const [k, v] of Object.entries(f.attrs ?? {})) match[`attrs.${k}`] = v;
  for (const [k, r] of Object.entries(f.metrics ?? {})) {
    const term: Record<string, number> = {};
    if (r.gte != null) term.$gte = r.gte;
    if (r.lte != null) term.$lte = r.lte;
    if (Object.keys(term).length) match[`metrics.${k}`] = term;
  }
  if (f.excludeActorTypes?.length) {
    // a record with NO actor is a customer fact; only typed actors are excludable
    match.$and = [
      ...(match.$and ?? []),
      {
        $or: [
          { actor: { $exists: false } },
          { actor: { $not: new RegExp(`^(${f.excludeActorTypes.map(esc).join('|')}):`) } },
        ],
      },
    ];
  }
  return match;
}

/** simple TTL cache with in-flight coalescing — proven shape in maxed */
class QueryCache {
  private store = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(private ttlMs: number, private cap: number) {}
  get<T>(key: string, produce: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = produce();
    // a failed query must not be cached as the answer for ten minutes
    value.catch(() => this.store.delete(key));
    if (this.store.size >= this.cap) {
      const oldest = [...this.store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.store.delete(oldest[0]);
    }
    this.store.set(key, { at: Date.now(), value });
    return value;
  }
}

export interface QueryCtx {
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  registry: Registry;
  limits?: Partial<QueryLimits>;
  /** called with { op, ms, params } when a read exceeds slowMs (default 500) */
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  slowMs?: number;
  cacheTtlMs?: number;
  cacheSize?: number;
}

export function createQueries(ctx: QueryCtx) {
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  const slowMs = ctx.slowMs ?? 500;
  const cache = new QueryCache(ctx.cacheTtlMs ?? 10 * 60_000, ctx.cacheSize ?? 60);

  const timed = async <T>(op: string, params: unknown, run: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await run();
    } finally {
      const ms = Date.now() - t0;
      if (ms > slowMs) ctx.onSlowQuery?.({ op, ms, params });
    }
  };

  return {
    /** cursor-paged raw envelope reads — tables, lists, detail drawers */
    async records(
      tenantId: string,
      range: TimeRange,
      filter: RecordFilter = {},
      opts: { limit?: number; cursor?: string } = {},
    ) {
      const limit = Math.min(Math.max(1, opts.limit ?? limits.records), limits.records);
      const match = buildMatch(tenantId, range, filter);
      if (opts.cursor) {
        // keyset on (occurredAt desc, _id desc) — never $skip
        const [atIso, id] = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString());
        const at = new Date(atIso);
        match.$and = [
          ...((match.$and as unknown[]) ?? []),
          { $or: [{ occurredAt: { $lt: at } }, { occurredAt: at, _id: { $lt: id } }] },
        ];
      }
      return timed('records', { tenantId, filter }, async () => {
        const items = await ctx.TelemetryModel.find(match)
          .sort({ occurredAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        const more = items.length > limit;
        if (more) items.pop();
        const last: any = items[items.length - 1];
        return {
          items,
          nextCursor: more
            ? Buffer.from(JSON.stringify([new Date(last.occurredAt).toISOString(), last._id])).toString('base64url')
            : null,
          dataSource: 'raw' as const,
        };
      });
    },

    /** time-series at query time. count extrapolates by 1/sampleRate (§5.3) —
     *  exact while rates sit at 1, still honest the day one drops. */
    series(
      tenantId: string,
      range: TimeRange,
      filter: RecordFilter,
      opts: { measure?: string; interval?: 'hour' | 'day' | 'week' | 'month' } = {},
    ) {
      const { measure = 'count', interval = 'day' } = opts;
      const key = JSON.stringify(['series', tenantId, range.from, range.to, filter, measure, interval]);
      return cache.get(key, () =>
        timed('series', { tenantId, filter, measure, interval }, async () => {
          const m = /^(sum|avg):(.+)$/.exec(measure);
          const value = !m
            ? { $sum: { $divide: [1, { $ifNull: ['$sampleRate', 1] }] } }
            : m[1] === 'sum'
              ? { $sum: `$metrics.${m[2]}` }
              : { $avg: `$metrics.${m[2]}` };
          const buckets = await ctx.TelemetryModel.aggregate([
            { $match: buildMatch(tenantId, range, filter) },
            {
              $group: {
                _id: { $dateTrunc: { date: '$occurredAt', unit: interval, ...(interval === 'week' ? { startOfWeek: 'monday' } : {}) } },
                value,
              },
            },
            { $sort: { _id: 1 } },
            { $limit: limits.series },
          ] as any[]);
          return { buckets: buckets.map((b: any) => ({ at: b._id, value: b.value })), dataSource: 'raw' as const };
        }),
      );
    },

    /** percentiles + histogram off raw — keep-all makes this exact (§5.3). Mongo 7+. */
    distribution(
      tenantId: string,
      range: TimeRange,
      filter: RecordFilter,
      opts: { measure?: string } = {},
    ) {
      const measure = opts.measure ?? 'durationMs';
      const path = measure === 'durationMs' ? '$durationMs' : `$metrics.${measure.replace(/^metric:/, '')}`;
      const key = JSON.stringify(['distribution', tenantId, range.from, range.to, filter, measure]);
      return cache.get(key, () =>
        timed('distribution', { tenantId, filter, measure }, async () => {
          const match = {
            ...buildMatch(tenantId, range, filter),
            [path.slice(1)]: { $exists: true },
          };
          const [summary] = await ctx.TelemetryModel.aggregate([
            { $match: match },
            { $limit: 100_000 }, // a hard scan ceiling even here — §18
            {
              $group: {
                _id: null,
                p: { $percentile: { input: path, p: [0.5, 0.9, 0.95, 0.99], method: 'approximate' } },
                min: { $min: path },
                max: { $max: path },
                avg: { $avg: path },
                n: { $sum: 1 },
              },
            },
          ] as any[]);
          if (!summary) return { n: 0, dataSource: 'raw' as const };
          const [p50, p90, p95, p99] = summary.p;
          const histogram = await ctx.TelemetryModel.aggregate([
            { $match: match },
            { $limit: 100_000 },
            { $bucketAuto: { groupBy: path, buckets: 20 } },
          ] as any[]);
          return {
            p50, p90, p95, p99,
            min: summary.min, max: summary.max, avg: summary.avg, n: summary.n,
            histogram: histogram.map((h: any) => ({ min: h._id.min, max: h._id.max, n: h.count })),
            dataSource: 'raw' as const,
          };
        }),
      );
    },

    /** rollup family reads — issues, spend, activity, milestones, funnels */
    rollups(
      tenantId: string,
      params: {
        as: string;
        dims?: string;
        subjectType?: string;
        /** on bucketAt for bucketed families, lastAt for lifetime ones */
        range?: TimeRange;
        sort?: 'count' | 'lastAt' | 'firstAt' | 'bucketAt';
        limit?: number;
      },
    ) {
      const key = JSON.stringify(['rollups', tenantId, params]);
      return cache.get(key, () =>
        timed('rollups', { tenantId, params }, async () => {
          // family shape is pinned by validateRegistry, so the first declaration speaks for all
          let bucketed = false;
          outer: for (const [name, s] of Object.entries(ctx.registry)) {
            for (const r of s.rollups ?? []) {
              if ((r.as ?? name) === params.as) {
                bucketed = !!r.bucket;
                break outer;
              }
            }
          }
          const match: Record<string, any> = { tenantId, as: params.as };
          if (params.dims) match.dims = params.dims;
          if (params.subjectType) match.subjectType = params.subjectType;
          if (params.range) {
            match[bucketed ? 'bucketAt' : 'lastAt'] = { $gte: params.range.from, $lt: params.range.to };
          }
          const sortKey = params.sort ?? (bucketed ? 'bucketAt' : 'count');
          const limit = Math.min(Math.max(1, params.limit ?? limits.rollups), limits.rollups);
          const rows = await ctx.RollupModel.find(match)
            .sort({ [sortKey]: sortKey === 'firstAt' || sortKey === 'bucketAt' ? 1 : -1 })
            .limit(limit)
            .lean();
          return { rows, bucketed, dataSource: 'rollups' as const };
        }),
      );
    },

    /** one trace, every kind, one time axis — the first join view */
    trace(tenantId: string, traceId: string) {
      return timed('trace', { tenantId, traceId }, async () => {
        const items = await ctx.TelemetryModel.find({ tenantId, traceId })
          .sort({ occurredAt: 1 })
          .limit(limits.trace)
          .lean();
        return { items, dataSource: 'raw' as const };
      });
    },

    /** one subject's whole story — records interleaved, milestones as markers */
    journey(tenantId: string, subjectRef: string, range: TimeRange, opts: { limit?: number } = {}) {
      return timed('journey', { tenantId, subjectRef }, async () => {
        const limit = Math.min(Math.max(1, opts.limit ?? limits.journey), limits.journey);
        const [records, milestones] = await Promise.all([
          ctx.TelemetryModel.find({
            tenantId,
            subjectKeys: subjectRef,
            occurredAt: { $gte: range.from, $lt: range.to },
          })
            .sort({ occurredAt: -1 })
            .limit(limit)
            .lean(),
          // lifetime families only — bucketed activity rows would drown the markers
          ctx.RollupModel.find({ tenantId, dims: subjectRef, bucketAt: { $exists: false } })
            .sort({ firstAt: 1 })
            .limit(100)
            .lean(),
        ]);
        return { records, milestones, dataSource: 'raw+rollups' as const };
      });
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;
