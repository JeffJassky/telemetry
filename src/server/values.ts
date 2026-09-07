import type { Model } from 'mongoose';
import { isPlatformScope } from './types.js';
import type { Catalog, DimFacet } from './catalog.js';
import {
  DEFAULT_LIMITS, QueryCache, buildMatch, dimExpression,
  type QueryLimits, type TimeRange,
} from './query.js';

/**
 * `/values` — the observed domain of one dimension (reports §5).
 *
 * "What values does this dimension actually take?" is the question standing
 * between a report builder and every filter it offers. The answer has four
 * possible sources and they are tried cheapest first, with the response SAYING
 * which one answered — a picker built on a guess is a filter that silently
 * matches nothing:
 *
 *   1. `catalog` — the registry already declared a closed domain (a `z.enum`,
 *      an envelope enum). Verbatim, in schema order, and NO read at all.
 *   2. `rollups` — some family is keyed by this dim, so every value that ever
 *      hit an aggregate is one indexed `$group` away, with its count.
 *   3. `raw`    — an indexed attr (or an envelope/pseudo dim) over a range.
 *   4. `none`   — nothing can answer it. The UI offers free-text equality with
 *      a *scan* badge, exactly as the FilterBar already does.
 *
 * This is NOT a tenth primitive. It is a lookup the report builder makes before
 * it names a value, which is why it lives beside the primitives rather than
 * inside `createQueries` — it reads the catalog, and the primitives deliberately
 * do not.
 *
 * The `none` path never throws, including when the raw step is the only
 * eligible one and no range was given. A caller that has to catch an exception
 * to learn "you'll have to type it" is a caller that will render an error page
 * over a working text box.
 */

export interface ValuesParams {
  /**
   * A `DimFacet.key`: `attr:model` | `field:client.platform` | `subjectType` |
   * `actorType`. The literal `'subject'` is also accepted, and is the only way
   * to ask a family for its subject refs — it is a rollup `by` source rather
   * than a catalog dim, so it can only ever be answered by step 2.
   */
  dim: string;
  /**
   * Restrict to these event names — a Report's source events. REQUIRED in
   * practice for the raw step (it decides whether the attr is indexed), and a
   * narrowing hint for the other two.
   */
  names?: string[];
  /** required by the raw step; ignored by the others */
  range?: TimeRange;
  /** values cap, default `limits.values` (200), clamped to it */
  limit?: number;
}

export interface ValuesResult {
  /** catalog order for a declared enum, else by count desc then value asc */
  values: string[];
  /** parallel to `values` when the source can count — absent for 'catalog' */
  counts?: number[];
  source: 'catalog' | 'rollups' | 'raw' | 'none';
  /** the family that was read, when `source === 'rollups'` */
  via?: string;
  /** more values existed than the cap; the ones kept are the top by count */
  truncated: boolean;
  /** mirrors `source`, so a values response reads like every other one (recon #2) */
  dataSource: 'catalog' | 'rollups' | 'raw' | 'none';
}

export interface ValuesCtx {
  catalog: Catalog;
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  limits?: Partial<QueryLimits>;
  /** called with { op, ms, params } when a read exceeds slowMs (default 500) */
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  slowMs?: number;
  cacheTtlMs?: number;
  cacheSize?: number;
}

const empty = (source: ValuesResult['source']): ValuesResult => ({
  values: [], source, truncated: false, dataSource: source,
});

/** count the way series/breakdown do: 1/sampleRate, so a dropped rate still extrapolates */
const SAMPLED_COUNT = { $sum: { $divide: [1, { $ifNull: ['$sampleRate', 1] }] } };

export function createValues(ctx: ValuesCtx) {
  const limits = { ...DEFAULT_LIMITS, ...ctx.limits };
  const slowMs = ctx.slowMs ?? 500;
  const cache = new QueryCache(ctx.cacheTtlMs ?? 10 * 60_000, ctx.cacheSize ?? 60);
  const { catalog } = ctx;

  const timed = async <T>(op: string, params: unknown, run: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await run();
    } finally {
      const ms = Date.now() - t0;
      if (ms > slowMs) ctx.onSlowQuery?.({ op, ms, params });
    }
  };

  /** the event facets a `names` restriction selects, in the order given; all of them otherwise */
  const eventNames = (names?: string[]): string[] =>
    names?.length ? names.filter((n) => catalog.events[n]) : Object.keys(catalog.events);

  /**
   * Step 1. Every DimFacet under this key that carries a closed domain, unioned
   * in first-seen order. Two events declaring different enums for one attr is
   * not a conflict — it is two closed domains, and their union is the set a
   * filter over both could ever match.
   */
  function fromCatalog(dim: string, names?: string[]): string[] {
    const facets: DimFacet[] = [];
    for (const d of catalog.envelope) if (d.key === dim) facets.push(d);
    for (const name of eventNames(names)) {
      for (const d of catalog.events[name]!.dims) if (d.key === dim) facets.push(d);
    }
    const out: string[] = [];
    for (const f of facets) for (const v of f.values ?? []) if (!out.includes(v)) out.push(v);
    return out;
  }

  /**
   * Step 2. The family whose `by` names this dim, fewest dims first — fewer
   * dims is fewer docs for the same domain, and the `by` comparison is literal
   * because a DimFacet.key IS a DimSource (catalog §3). `subjectType` and
   * `actorType` have no `by` equivalent — a family keyed by a subject writes
   * `'subject'`, whose values are refs, not types — so they fall through.
   */
  function pickFamily(dim: string, names?: string[]): { as: string; index: number; label: string } | null {
    if (dim === 'subjectType' || dim === 'actorType') return null;
    const matches = Object.values(catalog.families)
      .map((f) => ({ f, index: f.by.indexOf(dim as any) }))
      .filter(({ f, index }) =>
        index !== -1 && (!names?.length || f.feeders.some((n) => names.includes(n))))
      .sort((a, b) => a.f.by.length - b.f.by.length || a.f.as.localeCompare(b.f.as));
    const best = matches[0];
    return best ? { as: best.f.as, index: best.index, label: best.f.labels[best.index]! } : null;
  }

  /**
   * Step 3's precondition. `dimExpression` owns the vocabulary — a dim is
   * raw-readable exactly when the primitive that would group on it accepts it,
   * so there is no second allowlist to drift. On top of that an ATTR must be
   * genuinely indexed on one of the events in play: a `$group` over an
   * unindexed attr is the collection scan this package refuses to sell as a
   * lookup, and `none` (free text + a scan badge) is the honest answer.
   */
  function rawReadable(dim: string, names?: string[]): boolean {
    try {
      dimExpression(dim);
    } catch {
      return false;
    }
    if (!dim.startsWith('attr:')) return true;
    const key = dim.slice(5);
    return eventNames(names).some((n) => catalog.events[n]!.indexedAttrs.includes(key));
  }

  return async function values(scope: string, params: ValuesParams): Promise<ValuesResult> {
    const { dim, names, range } = params;
    if (!dim) return empty('none');
    const cap = Math.min(Math.max(1, params.limit ?? limits.values), limits.values);
    const key = JSON.stringify([
      'values', scope, dim, names ?? null, range?.from ?? null, range?.to ?? null, cap,
    ]);

    return cache.get(key, () =>
      timed('values', { scope, dim, names }, async (): Promise<ValuesResult> => {
        // ── 1. the registry already said so ──
        const declared = fromCatalog(dim, names);
        if (declared.length) {
          return { values: declared, source: 'catalog', truncated: false, dataSource: 'catalog' };
        }

        // ── 2. what the aggregates have seen ──
        const family = pickFamily(dim, names);
        if (family) {
          // {tenantId, as, dims, bucketAt} answers the match on its prefix; the
          // $limit sits after the $group, so the cap bounds the ANSWER and the
          // scan stays bounded by the family
          const rows = await ctx.RollupModel.aggregate([
            {
              $match: {
                ...(isPlatformScope(scope) ? {} : { tenantId: scope }),
                as: family.as,
              },
            },
            { $project: { v: { $arrayElemAt: ['$dims', family.index] }, count: 1 } },
            { $match: { v: { $type: 'string' } } },
            { $group: { _id: '$v', count: { $sum: '$count' } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: cap + 1 },
          ] as any[]);
          const truncated = rows.length > cap;
          if (truncated) rows.pop();
          // rollups.ts writes `${label}=${value}` for every dim but the subject
          // one, which keeps its native `type:id` so erasure can match it — so
          // the prefix is stripped where it is actually present, never assumed
          const prefix = `${family.label}=`;
          return {
            values: rows.map((r: any) =>
              String(r._id).startsWith(prefix) ? String(r._id).slice(prefix.length) : String(r._id),
            ),
            counts: rows.map((r: any) => r.count),
            source: 'rollups',
            via: family.as,
            truncated,
            dataSource: 'rollups',
          };
        }

        // ── 3. the rows themselves, when an index answers them ──
        if (!rawReadable(dim, names)) return empty('none');
        // A missing range is not an error: the caller asked what it could offer
        // and the answer is "nothing cheap" — free text with a scan badge.
        if (!range) return empty('none');

        // `RecordFilter.name` takes the set directly, so the source events are
        // one indexed `$in` on {tenantId, kind, name, occurredAt} rather than a
        // restriction bolted onto the match afterwards
        const rows = await ctx.TelemetryModel.aggregate([
          { $match: buildMatch(scope, range, names?.length ? { name: names } : {}) },
          { $group: { _id: dimExpression(dim), count: SAMPLED_COUNT } },
          // a "no value" is not a value to pick — the null group is real
          // (breakdown reports it) but it is not something a filter can name
          { $match: { _id: { $ne: null } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: cap + 1 },
        ] as any[]);
        const truncated = rows.length > cap;
        if (truncated) rows.pop();
        return {
          values: rows.map((r: any) => String(r._id)),
          counts: rows.map((r: any) => r.count),
          source: 'raw',
          truncated,
          dataSource: 'raw',
        };
      }),
    );
  };
}

export type Values = ReturnType<typeof createValues>;
