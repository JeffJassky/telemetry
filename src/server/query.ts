import type { Model } from 'mongoose';
import { isPlatformScope } from './types.js';
import type { Registry, RollupSpec } from './registry.js';
import { findFamily, runFunnel, type FunnelParams, type FunnelResult } from './funnel.js';

/**
 * The six read primitives (dashboards §2). Everything the UI renders comes
 * through these — kind pages never touch Mongo, which is the seam that lets
 * span/event route to a columnar store later without touching a component.
 *
 * Traps §18 is law here, but per primitive rather than blanket. A time range is
 * REQUIRED by records, series, distribution, journey and distinctCount, and a
 * cohort window by funnel; `rollups()`'s range is OPTIONAL because a lifetime
 * family has no time axis to filter on; `trace()` takes NONE — it is pinned by
 * an indexed traceId and bounded by the trace itself.
 *
 * What is universal is the cap: every primitive carries its `$limit` INSIDE the
 * pipeline rather than applying it to a materialised result, the caps are
 * config, and the four that can cut an answer short — rollups, distribution,
 * distinctCount, funnel — report `truncated` rather than undercounting in
 * silence. The slow-query counter is an adapter. Every response reports
 * `dataSource` (recon #2) so a spliced number can always say which store
 * answered.
 *
 * Tenancy: every primitive takes a SCOPE, not a tenant. A scope is a tenantId,
 * or PLATFORM_SCOPE ('*') for a cross-tenant read. `'*'` is only ever reachable
 * because a host's `viewerAdapter` put it on the Viewer — an authorization
 * decision the package does not make and cannot second-guess. The write side
 * treats '*' as reserved (types.ts), so no stored row can ever carry it and
 * "omit the tenant term" is unambiguous.
 *
 * Row-shaped primitives (records/rollups/trace/journey) already return the
 * stored `tenantId` on every row, which is what makes a cross-tenant number
 * attributable — do not project it away.
 */

export interface QueryLimits {
  records: number;
  series: number;
  rollups: number;
  trace: number;
  journey: number;
  /** raw docs distribution will scan before it reports an undercount */
  distribution: number;
  /** rollup docs distinctCount will scan before it reports an undercount */
  distinct: number;
  /** subjects in one funnel cohort */
  funnel: number;
}

export const DEFAULT_LIMITS: QueryLimits = {
  records: 200,
  series: 744, // a month of hourly buckets
  rollups: 500,
  trace: 500,
  journey: 500,
  distribution: 100_000,
  distinct: 100_000,
  funnel: 5_000,
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

function buildMatch(scope: string, range: TimeRange, f: RecordFilter): Record<string, unknown> {
  const match: Record<string, any> = {
    // the ONLY place the tenant term is optional. Omitted under '*' — every
    // other term still applies, and the time range is still mandatory (§18).
    ...(isPlatformScope(scope) ? {} : { tenantId: scope }),
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
      scope: string,
      range: TimeRange,
      filter: RecordFilter = {},
      opts: { limit?: number; cursor?: string } = {},
    ) {
      const limit = Math.min(Math.max(1, opts.limit ?? limits.records), limits.records);
      const match = buildMatch(scope, range, filter);
      if (opts.cursor) {
        // keyset on (occurredAt desc, _id desc) — never $skip
        const [atIso, id] = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString());
        const at = new Date(atIso);
        match.$and = [
          ...((match.$and as unknown[]) ?? []),
          { $or: [{ occurredAt: { $lt: at } }, { occurredAt: at, _id: { $lt: id } }] },
        ];
      }
      return timed('records', { scope, filter }, async () => {
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
     *  exact while rates sit at 1, still honest the day one drops.
     *
     *  Under PLATFORM_SCOPE this aggregates ACROSS tenants into one bucket per
     *  interval. That is the platform-wide chart, not a bug — the sum of every
     *  tenant is the number a platform operator came for. A per-tenant
     *  breakdown is a different question; ask it with rollups() or by scoping
     *  to a tenant. Same for distribution() below. */
    series(
      scope: string,
      range: TimeRange,
      filter: RecordFilter,
      opts: { measure?: string; interval?: 'hour' | 'day' | 'week' | 'month' } = {},
    ) {
      const { measure = 'count', interval = 'day' } = opts;
      const key = JSON.stringify(['series', scope, range.from, range.to, filter, measure, interval]);
      return cache.get(key, () =>
        timed('series', { scope, filter, measure, interval }, async () => {
          const m = /^(sum|avg):(.+)$/.exec(measure);
          const value = !m
            ? { $sum: { $divide: [1, { $ifNull: ['$sampleRate', 1] }] } }
            : m[1] === 'sum'
              ? { $sum: `$metrics.${m[2]}` }
              : { $avg: `$metrics.${m[2]}` };
          const buckets = await ctx.TelemetryModel.aggregate([
            { $match: buildMatch(scope, range, filter) },
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

    /**
     * Percentiles + histogram off raw. Keep-all makes the SAMPLE complete —
     * no sampling stands between the match and the math (§5.3) — but the
     * computation is not exact and this comment used to claim it was:
     * `$percentile` runs `method: 'approximate'` (t-digest), and the scan stops
     * at `limits.distribution`.
     *
     * So the ceiling is read as cap+1 and `truncated` reports whether it was
     * actually reached, the same way rollups/distinctCount/funnel do. A match
     * wider than the ceiling is an undercount, and an undercount the response
     * does not mention is the silent cap this package refuses everywhere else.
     * Mongo 7+.
     */
    distribution(
      scope: string,
      range: TimeRange,
      filter: RecordFilter,
      opts: { measure?: string } = {},
    ) {
      const measure = opts.measure ?? 'durationMs';
      const path = measure === 'durationMs' ? '$durationMs' : `$metrics.${measure.replace(/^metric:/, '')}`;
      const key = JSON.stringify(['distribution', scope, range.from, range.to, filter, measure]);
      return cache.get(key, () =>
        timed('distribution', { scope, filter, measure }, async () => {
          const match = {
            ...buildMatch(scope, range, filter),
            [path.slice(1)]: { $exists: true },
          };
          // one scan ceiling, shared by both pipelines — and cap+1 so the
          // response can SAY it was truncated instead of quietly undercounting
          const cap = limits.distribution;
          const [summary] = await ctx.TelemetryModel.aggregate([
            { $match: match },
            { $limit: cap + 1 },
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
          // `truncated` is always present, empty match included — a caller that
          // has to check whether the key exists before trusting it is back to
          // inferring the cap
          if (!summary) return { n: 0, truncated: false, dataSource: 'raw' as const };
          const [p50, p90, p95, p99] = summary.p;
          const histogram = await ctx.TelemetryModel.aggregate([
            { $match: match },
            { $limit: cap + 1 },
            { $bucketAuto: { groupBy: path, buckets: 20 } },
          ] as any[]);
          return {
            p50, p90, p95, p99,
            min: summary.min, max: summary.max, avg: summary.avg, n: summary.n,
            histogram: histogram.map((h: any) => ({ min: h._id.min, max: h._id.max, n: h.count })),
            truncated: summary.n > cap,
            dataSource: 'raw' as const,
          };
        }),
      );
    },

    /** rollup family reads — issues, spend, activity, milestones, funnels */
    rollups(
      scope: string,
      params: {
        as: string;
        /**
         * One dimension value, or several as an `$in`. The array form exists
         * because building an index for N subjects otherwise costs N queries or
         * an unfiltered family scan that the cap truncates — plausible, wrong,
         * and silent (cohort-math G3).
         */
        dims?: string | string[];
        subjectType?: string;
        /** the field `range` filters. Default: bucketAt when bucketed, lastAt otherwise. */
        on?: 'firstAt' | 'lastAt' | 'bucketAt';
        /**
         * Half-open (`$gte`/`$lt`), always. Applied to `on`.
         *
         * The default is today's behaviour and deliberately unchanged, but
         * `lastAt` is the MOST RECENT occurrence — cohort selection wants
         * `firstAt`, and on a once-per-subject milestone the two are equal only
         * until something re-emits it (cohort-math G1). `on: 'firstAt'` makes
         * that choice explicit rather than lucky; there is already an index for
         * it ({tenantId, as, subjectType, firstAt}).
         */
        range?: TimeRange;
        sort?: 'count' | 'lastAt' | 'firstAt' | 'bucketAt';
        limit?: number;
      },
    ) {
      const key = JSON.stringify(['rollups', scope, params]);
      return cache.get(key, () =>
        timed('rollups', { scope, params }, async () => {
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
          // rollup rows carry their own tenantId, so a '*' read stays attributable
          const match: Record<string, any> = {
            ...(isPlatformScope(scope) ? {} : { tenantId: scope }),
            as: params.as,
          };
          if (params.dims) {
            match.dims = Array.isArray(params.dims) ? { $in: params.dims } : params.dims;
          }
          if (params.subjectType) match.subjectType = params.subjectType;
          if (params.range) {
            const on = params.on ?? (bucketed ? 'bucketAt' : 'lastAt');
            match[on] = { $gte: params.range.from, $lt: params.range.to };
          }
          const sortKey = params.sort ?? (bucketed ? 'bucketAt' : 'count');
          const limit = Math.min(Math.max(1, params.limit ?? limits.rollups), limits.rollups);
          // limit+1 so truncation is observed, not inferred from an exact match
          const rows = await ctx.RollupModel.find(match)
            .sort({ [sortKey]: sortKey === 'firstAt' || sortKey === 'bucketAt' ? 1 : -1 })
            .limit(limit + 1)
            .lean();
          const truncated = rows.length > limit;
          if (truncated) rows.pop();
          return { rows, bucketed, truncated, dataSource: 'rollups' as const };
        }),
      );
    },

    /** one trace, every kind, one time axis — the first join view */
    trace(scope: string, traceId: string) {
      return timed('trace', { scope, traceId }, async () => {
        const items = await ctx.TelemetryModel.find({
          ...(isPlatformScope(scope) ? {} : { tenantId: scope }),
          traceId,
        })
          .sort({ occurredAt: 1 })
          .limit(limits.trace)
          .lean();
        return { items, dataSource: 'raw' as const };
      });
    },

    /** one subject's whole story — records interleaved, milestones as markers */
    journey(scope: string, subjectRef: string, range: TimeRange, opts: { limit?: number } = {}) {
      return timed('journey', { scope, subjectRef }, async () => {
        const limit = Math.min(Math.max(1, opts.limit ?? limits.journey), limits.journey);
        // a subject ref is only unique WITHIN a tenant, so a '*' journey can
        // legitimately braid two tenants' 'user:u_1' together — every row and
        // milestone carries its tenantId, which is what keeps that readable
        const pin = isPlatformScope(scope) ? {} : { tenantId: scope };
        const [records, milestones] = await Promise.all([
          ctx.TelemetryModel.find({
            ...pin,
            subjectKeys: subjectRef,
            occurredAt: { $gte: range.from, $lt: range.to },
          })
            .sort({ occurredAt: -1 })
            .limit(limit)
            .lean(),
          // lifetime families only — bucketed activity rows would drown the markers
          ctx.RollupModel.find({ ...pin, dims: subjectRef, bucketAt: { $exists: false } })
            .sort({ firstAt: 1 })
            .limit(100)
            .lean(),
        ]);
        return { records, milestones, dataSource: 'raw+rollups' as const };
      });
    },

    /**
     * Distinct subjects per bucket, and over the whole range — DAU/MAU/WAU,
     * EXACTLY, with no sketch and no write-path change.
     *
     * The trick is that there is no trick. A family declared `by: ['subject']`
     * with a bucket already writes exactly ONE doc per (subject, bucket), which
     * is what the deterministic `_id` guarantees. So distinct-subjects-in-bucket
     * IS the doc count, and distinct-over-a-range is one `$group` on `dims`. An
     * HLL sketch would buy approximation we do not need and storage we would
     * have to maintain.
     *
     * `interval` may be COARSER than the family's own bucket (daily rows →
     * monthly MAU) — re-truncating bucket starts cannot split a bucket across
     * two periods, so the roll-up stays exact. Asking for finer than the family
     * writes cannot invent detail: it returns the family's own grain.
     */
    distinctCount(
      scope: string,
      params: {
        as: string;
        subjectType?: string;
        range: TimeRange;
        interval?: 'hour' | 'day' | 'week' | 'month';
      },
    ) {
      // A family with no subject dim or no bucket cannot answer this, and the
      // failure mode is a confident wrong number rather than an empty result —
      // so it throws, loudly, naming the family and the fix.
      const spec = requireDistinctFamily(ctx.registry, params.as);
      const interval = params.interval ?? spec.bucket!;
      const key = JSON.stringify(['distinctCount', scope, params]);
      return cache.get(key, () =>
        timed('distinctCount', { scope, params }, async () => {
          const match: Record<string, any> = {
            ...(isPlatformScope(scope) ? {} : { tenantId: scope }),
            as: params.as,
            bucketAt: { $gte: params.range.from, $lt: params.range.to },
          };
          if (params.subjectType) match.subjectType = params.subjectType;
          const cap = limits.distinct;
          const [out] = await ctx.RollupModel.aggregate([
            { $match: match },
            // one scan ceiling, shared by both branches — and cap+1 so the
            // response can SAY it was truncated instead of quietly undercounting
            { $limit: cap + 1 },
            {
              $facet: {
                buckets: [
                  {
                    $group: {
                      _id: {
                        at: { $dateTrunc: { date: '$bucketAt', unit: interval, ...(interval === 'week' ? { startOfWeek: 'monday' } : {}) } },
                        dims: '$dims',
                      },
                    },
                  },
                  { $group: { _id: '$_id.at', value: { $sum: 1 } } },
                  { $sort: { _id: 1 } },
                  { $limit: limits.series },
                ],
                distinct: [{ $group: { _id: '$dims' } }, { $count: 'n' }],
                scanned: [{ $count: 'n' }],
              },
            },
          ] as any[]);
          const scanned = out?.scanned?.[0]?.n ?? 0;
          return {
            buckets: (out?.buckets ?? []).map((b: any) => ({ at: b._id, value: b.value })),
            /** distinct subjects across the WHOLE range — never the sum of the buckets */
            distinct: out?.distinct?.[0]?.n ?? 0,
            interval,
            truncated: scanned > cap,
            dataSource: 'rollups' as const,
          };
        }),
      );
    },

    /**
     * Cohort funnel over lifetime milestone families — stage counts, conversion,
     * and median time-to-step. See funnel.ts; the math lives there so it can be
     * unit-pinned without a database.
     */
    funnel(scope: string, params: FunnelParams): Promise<FunnelResult> {
      return timed('funnel', { scope, params }, () =>
        runFunnel(
          {
            RollupModel: ctx.RollupModel,
            registry: ctx.registry,
            cohortCap: limits.funnel,
            scopeMatch: (s) => (isPlatformScope(s) ? {} : { tenantId: s }),
          },
          scope,
          params,
        ),
      );
    },
  };
}

/**
 * distinctCount's precondition. The exactness argument rests entirely on the
 * family writing one doc per (subject, bucket), so each way of breaking that
 * gets its own message with its own fix — a registry mistake here would
 * otherwise surface as a number that looks like DAU and is not.
 */
function requireDistinctFamily(registry: Registry, as: string): RollupSpec {
  const found = findFamily(registry, as);
  if (!found) {
    throw new Error(
      `telemetry: distinctCount() — no rollup family "${as}" is declared. Add ` +
        `\`rollups: [{ as: '${as}', by: ['subject'], subjects: [...], bucket: 'day' }]\` to the events that count as activity.`,
    );
  }
  const { name, spec } = found;
  const by = `by: [${spec.by.map((d) => `'${d}'`).join(', ')}]`;
  if (!spec.bucket) {
    throw new Error(
      `telemetry: distinctCount() — rollup family "${as}" (declared on "${name}") has no \`bucket\`. ` +
        `Distinct-per-period needs one doc per (subject, period); a lifetime family has one doc per subject ` +
        `forever, so every period would report the same number. Add \`bucket: 'day'\`, or ask this with rollups().`,
    );
  }
  if (!spec.by.includes('subject')) {
    throw new Error(
      `telemetry: distinctCount() — rollup family "${as}" (declared on "${name}") is keyed ${by} with no ` +
        `\`subject\` dim, so its docs count OCCURRENCES, not subjects. Add 'subject' to \`by\` (with \`subjects: [...]\`).`,
    );
  }
  if (spec.by.length !== 1) {
    throw new Error(
      `telemetry: distinctCount() — rollup family "${as}" (declared on "${name}") is keyed ${by}. Extra dims ` +
        `split one subject across several docs per period, so the count would exceed the true distinct total. ` +
        `Declare a second family with \`by: ['subject']\` for the distinct question.`,
    );
  }
  return spec;
}

export type Queries = ReturnType<typeof createQueries>;
