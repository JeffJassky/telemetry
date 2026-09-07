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
 * config, and the five that can cut an answer short — rollups, distribution,
 * distinctCount, funnel, breakdown — report `truncated` rather than
 * undercounting in silence. What each cap BOUNDS differs, and QueryLimits below
 * says which are output caps and which are scan caps: breakdown's, like
 * series', bounds the groups returned and never the rows read. The slow-query
 * counter is an adapter. Every response reports
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

/**
 * Two kinds of cap live here and the difference is worth stating, because the
 * word "limit" hides it. An OUTPUT cap bounds what the response contains: its
 * `$limit` sits after the `$group`/sort or rides an indexed cursor, so the work
 * behind it is bounded by the range and the indexes, not by the number. A SCAN
 * cap bounds what the primitive reads, which means an answer past it is an
 * undercount — so every scan-capped primitive reports `truncated`.
 */
export interface QueryLimits {
  // ── output caps ──
  records: number;
  series: number;
  rollups: number;
  trace: number;
  journey: number;
  /**
   * Distinct GROUPS one breakdown() returns — the top N by measure, read as
   * cap+1 so truncation is observed. Never a bound on rows scanned: "the top
   * models this quarter" is exactly the question Mongo folds a million rows
   * into in one pass (reports §6).
   */
  breakdown: number;
  /**
   * Distinct VALUES one /values lookup returns — the top N by count, read as
   * cap+1 so truncation is observed. Never a bound on rows scanned: the
   * `$limit` sits after the `$group`, exactly as breakdown's does (reports §5).
   */
  values: number;

  // ── scan caps ──
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
  breakdown: 50, // top groups — a starting point, to be measured on real hosts
  values: 200, // top values of one dimension — a picker, not a table
  distribution: 100_000,
  distinct: 100_000,
  funnel: 5_000,
};

export interface RecordFilter {
  kind?: string;
  /**
   * One event name, or a SET of them as an `$in`. The set form exists because a
   * namespace or a rollup family is several names, and without it the only
   * honest read for one was "every record of that kind in the range" — a scan
   * sold as a filter (reports §6). An empty array is treated as absent, never
   * as a term that matches nothing.
   */
  name?: string | string[];
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

/** one group of a breakdown; `at` only when an `interval` was asked for */
export interface BreakdownRow {
  dims: (string | null)[];
  at?: Date;
  value: number;
}

export interface BreakdownResult {
  rows: BreakdownRow[];
  /** distinct groups RETURNED — never more than the cap */
  groups: number;
  /** more groups existed than the cap; the ones kept are the top by measure */
  truncated: boolean;
  /**
   * The per-bucket pass hit ITS ceiling (`limits.series` buckets per returned
   * group), so some group is missing buckets. Always false without an
   * `interval`, and separate from `truncated` because they cut different axes:
   * one drops groups, the other drops periods of a group that IS shown.
   */
  bucketsTruncated: boolean;
  dataSource: 'raw';
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** exported for values.ts — the raw step must match rows exactly as the primitives do */
export function buildMatch(scope: string, range: TimeRange, f: RecordFilter): Record<string, unknown> {
  const match: Record<string, any> = {
    // the ONLY place the tenant term is optional. Omitted under '*' — every
    // other term still applies, and the time range is still mandatory (§18).
    ...(isPlatformScope(scope) ? {} : { tenantId: scope }),
    occurredAt: { $gte: range.from, $lt: range.to },
  };
  for (const k of ['kind', 'name', 'severity', 'env', 'service', 'release', 'traceId'] as const) {
    const v = f[k];
    // only `name` is ever a set; an empty one is an absent term rather than an
    // `$in: []` that silently matches nothing
    if (Array.isArray(v)) {
      if (v.length) match[k] = { $in: v };
    } else if (v) match[k] = v;
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

export type Interval = 'hour' | 'day' | 'week' | 'month';

const INTERVALS: readonly Interval[] = ['hour', 'day', 'week', 'month'];

/** weeks start Monday, UTC — the same truncation everywhere it is asked for */
const truncTo = (path: string, unit: Interval) => ({
  $dateTrunc: { date: path, unit, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) },
});

/**
 * The measure grammar, in ONE place: `count` (default), `sum:<metric>`,
 * `avg:<metric>`. series() and breakdown() must agree on what a measure means
 * — two copies of this regex is two chances for "sum:cost_usd" to mean
 * different things on a chart and in the table beside it.
 *
 * `count` sums 1/sampleRate rather than counting documents, so it extrapolates
 * correctly the day a rate drops below 1 (§5.3).
 *
 * `durationMs` is the one metric name that is not in `metrics`: a span's
 * duration lives on the ENVELOPE, which is where distribution() has always read
 * it from. Resolving it to `$metrics.durationMs` here would have aggregated a
 * path no record carries and reported 0 — a number, confidently wrong — so the
 * branch is in the shared accumulator rather than in either caller.
 */
function measureAccumulator(measure: string): Record<string, unknown> {
  const m = /^(sum|avg):(.+)$/.exec(measure);
  if (!m) return { $sum: { $divide: [1, { $ifNull: ['$sampleRate', 1] }] } };
  const path = m[2] === 'durationMs' ? '$durationMs' : `$metrics.${m[2]}`;
  return m[1] === 'sum' ? { $sum: path } : { $avg: path };
}

const badRequest = (message: string) =>
  Object.assign(new Error(`telemetry: breakdown() — ${message}`), { status: 400 });

/**
 * The envelope paths breakdown() will `$group` on. An ALLOWLIST, not a
 * passthrough: every one of these is either indexed or low-cardinality
 * enveloped metadata. `data.*` and `body` are deliberately absent — they are
 * free-form user content with no index behind them, and a `$group` over an
 * arbitrary path is an unbounded scan of exactly the payloads the rest of this
 * package works to keep out of aggregates.
 */
const BREAKDOWN_FIELDS: readonly string[] = [
  'kind', 'name', 'severity', 'env', 'service', 'release', 'origin',
  'client.platform', 'client.appVersion',
  'usage.meter', 'usage.billedTo', 'usage.unit',
  'state.key', 'state.to',
  'error.type', 'error.handled',
];

/** 'user:u_1' → 'user'; null for an absent ref, never a thrown $split */
const typePrefix = (ref: unknown) => ({
  $let: {
    vars: { ref },
    in: {
      $cond: [
        { $eq: [{ $type: '$$ref' }, 'string'] },
        { $arrayElemAt: [{ $split: ['$$ref', ':'] }, 0] },
        null,
      ],
    },
  },
});

/**
 * One groupBy token → the aggregation expression it groups on. The syntax is
 * the catalog's and the rollup `by` syntax, so a dim key passes straight
 * through from one to the other.
 *
 * Every expression resolves an absent value to an explicit `null` rather than
 * leaving the field missing: a record with no `plan` is a group ("none"), not a
 * row to drop. That is the raw-side analogue of a family's `dimDefault`.
 */
export function dimExpression(dim: string): unknown {
  if (dim.startsWith('attr:')) {
    const key = dim.slice(5);
    if (!key) throw badRequest('`attr:` needs a key, e.g. "attr:plan"');
    return { $ifNull: [`$attrs.${key}`, null] };
  }
  if (dim.startsWith('field:')) {
    const path = dim.slice(6);
    if (!BREAKDOWN_FIELDS.includes(path)) {
      throw badRequest(
        `"field:${path}" is not groupable. Allowed paths: ${BREAKDOWN_FIELDS.join(', ')}. ` +
          'Grouping by `data.*`, `body`, or an arbitrary path is refused — those are unindexed ' +
          'free-form content, and a $group over them scans it all. Use `attr:<key>` for a declared attr.',
      );
    }
    return { $ifNull: [`$${path}`, null] };
  }
  if (dim === 'subjectType') return typePrefix({ $arrayElemAt: ['$subjectKeys', 0] });
  if (dim === 'actorType') return typePrefix('$actor');
  throw badRequest(
    `"${dim}" is not a dimension. Use "attr:<key>", "field:<path>", "subjectType" or "actorType".`,
  );
}

/** simple TTL cache with in-flight coalescing — proven shape in maxed.
 *  Exported so values.ts memoizes on exactly these semantics rather than
 *  keeping a second copy that could drift on eviction or error handling. */
export class QueryCache {
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
      opts: { measure?: string; interval?: Interval } = {},
    ) {
      const { measure = 'count', interval = 'day' } = opts;
      const key = JSON.stringify(['series', scope, range.from, range.to, filter, measure, interval]);
      return cache.get(key, () =>
        timed('series', { scope, filter, measure, interval }, async () => {
          const buckets = await ctx.TelemetryModel.aggregate([
            { $match: buildMatch(scope, range, filter) },
            { $group: { _id: truncTo('$occurredAt', interval), value: measureAccumulator(measure) } },
            { $sort: { _id: 1 } },
            { $limit: limits.series },
          ] as any[]);
          return { buckets: buckets.map((b: any) => ({ at: b._id, value: b.value })), dataSource: 'raw' as const };
        }),
      );
    },

    /**
     * Top groups of a measure by one or two dimensions — "which models cost the
     * most", "errors by release", "events by platform per week". The primitive
     * that replaces a page's client-side grouping of whatever rows it happened
     * to have fetched, which answered "this page" while reading like it
     * answered the range (reports §6).
     *
     * THE CAP IS ON GROUPS RETURNED, NEVER ON ROWS SCANNED. Every `$limit`
     * below sits AFTER a `$group`, exactly as series() does: the scan is bounded
     * by buildMatch — tenant, range, filters, indexes — and nothing else, so a
     * quarter of a million records is one pass and 50 rows. Truncation
     * therefore keeps the TOP groups by measure, which is what a breakdown
     * table means; a cap on documents scanned would return an arbitrary prefix
     * and call it the top.
     *
     * With an `interval` this runs a SECOND aggregate restricted to the top
     * groups, rather than one pipeline that groups by (dims, bucket) and folds.
     * Two reasons: the ranking must be the measure over the WHOLE range (the
     * same number the no-interval call reports), and folding in one pass means
     * `$push`-ing every bucket of every group before the cap can apply — the
     * unbounded intermediate this primitive exists to avoid. The restriction is
     * an `$expr`/`$or` over the ≤ cap tuples because a dim can be a computed
     * expression (subjectType), which a plain `$in` on a path cannot address.
     *
     * Under PLATFORM_SCOPE it aggregates ACROSS tenants, like series() — one
     * set of groups with every tenant summed into it, which is the platform-wide
     * table a platform operator came for. Ask for a per-tenant split by scoping
     * to a tenant, or with rollups().
     */
    breakdown(
      scope: string,
      range: TimeRange,
      filter: RecordFilter,
      opts: {
        /** 1–2 of `attr:<key>` | `field:<path>` | `subjectType` | `actorType` */
        groupBy: string[];
        measure?: string;
        interval?: Interval;
        /** groups, clamped to limits.breakdown */
        limit?: number;
      },
    ) {
      const groupBy = opts.groupBy ?? [];
      if (groupBy.length < 1 || groupBy.length > 2) {
        // three dims is a pivot table nobody can read and a group count that
        // multiplies; zero is series() with extra steps
        throw badRequest(`groupBy takes 1 or 2 dimensions, got ${groupBy.length}`);
      }
      const measure = opts.measure ?? 'count';
      const interval = opts.interval;
      if (interval && !INTERVALS.includes(interval)) {
        throw badRequest(`interval must be one of ${INTERVALS.join(', ')}`);
      }
      // resolved (and refused) BEFORE the cache key is built — an invalid dim is
      // a 400 on every call, not a rejection remembered for ten minutes
      const dims = groupBy.map(dimExpression);
      const cap = Math.min(Math.max(1, opts.limit ?? limits.breakdown), limits.breakdown);
      const key = JSON.stringify([
        'breakdown', scope, range.from, range.to, filter, groupBy, measure, interval ?? null, cap,
      ]);
      return cache.get(key, () =>
        timed('breakdown', { scope, filter, groupBy, measure, interval }, async (): Promise<BreakdownResult> => {
          const match = buildMatch(scope, range, filter);
          const dimId = Object.fromEntries(dims.map((expr, i) => [`d${i}`, expr]));
          // cap+1 so truncation is OBSERVED rather than inferred from an exact
          // match, the same read rollups() and distribution() do
          const top = await ctx.TelemetryModel.aggregate([
            { $match: match },
            { $group: { _id: dimId, value: measureAccumulator(measure) } },
            { $sort: { value: -1, _id: 1 } },
            { $limit: cap + 1 },
          ] as any[]);
          const truncated = top.length > cap;
          if (truncated) top.pop();
          const tuples: (string | null)[][] = top.map((g: any) =>
            groupBy.map((_, i) => g._id?.[`d${i}`] ?? null),
          );
          if (!interval) {
            return {
              rows: top.map((g: any, i: number) => ({ dims: tuples[i]!, value: g.value })),
              groups: top.length,
              truncated,
              bucketsTruncated: false,
              dataSource: 'raw' as const,
            };
          }
          if (!tuples.length) {
            return { rows: [], groups: 0, truncated, bucketsTruncated: false, dataSource: 'raw' as const };
          }
          const inTop = {
            $or: tuples.map((t) => ({ $and: dims.map((expr, i) => ({ $eq: [expr, t[i] ?? null] })) })),
          };
          // this pass has a ceiling of its own — buckets × groups — and it used
          // to be the one cap in the file that could cut an answer without
          // saying so. Read as cap+1, like every other one, and reported as
          // `bucketsTruncated`.
          const bucketCap = limits.series * top.length;
          const perBucket = await ctx.TelemetryModel.aggregate([
            { $match: { ...match, $expr: inTop } },
            { $group: { _id: { at: truncTo('$occurredAt', interval), ...dimId }, value: measureAccumulator(measure) } },
            // `at` is the first key of `_id`, so one BSON sort orders by bucket
            // then by dims — deterministic without a second sort key
            { $sort: { _id: 1 } },
            { $limit: bucketCap + 1 },
          ] as any[]);
          const bucketsTruncated = perBucket.length > bucketCap;
          if (bucketsTruncated) perBucket.pop();
          return {
            rows: perBucket.map((b: any) => ({
              dims: groupBy.map((_, i) => b._id?.[`d${i}`] ?? null) as (string | null)[],
              at: b._id.at as Date,
              value: b.value,
            })),
            groups: top.length,
            truncated,
            bucketsTruncated,
            dataSource: 'raw' as const,
          };
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
