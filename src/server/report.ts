import type { Catalog, DimFacet, FamilyFacet } from './catalog.js';
import type { Interval, QueryLimits, RecordFilter, TimeRange } from './query.js';
import type { TelemetryKind } from './types.js';
import type { ViewSpec } from './views.js';

/**
 * The Report and its resolver (reports §4, §6). A Report is the one shape a
 * page renders, the explore UI builds, a saved view stores, a URL hash carries
 * and `run_report` executes. `resolveReport` is the pure function that turns
 * one into a Plan: the cheapest primitive that answers it EXACTLY, a raw plan
 * when nothing can, and a refusal with a reason when nothing at all can.
 *
 * Pure, like deriveCatalog and summarizeStages — no Mongo, no I/O, and
 * deterministic given `now`, so it is pinned by unit tests rather than by a
 * seeded database (reports §11.6). Nothing here executes anything — that is
 * execute.ts, which is the only file that needs a database to do its job.
 *
 * `Plan.args` is POSITIONAL and spreads straight into the named primitive:
 *
 *   const plan = resolveReport(report, catalog);
 *   if ('primitive' in plan) await q[plan.primitive](scope, ...plan.args);
 *
 * That is the entire contract between this file and query.ts, and it is why
 * nothing here imports a primitive — the resolver names one and hands over its
 * arguments, so adding a primitive costs a rule and no plumbing.
 */

// ── the Report ──────────────────────────────────────────────────────────────

export type ReportSource =
  /** one registered name */
  | { event: string }
  /** every event under `library.*` */
  | { namespace: string }
  | { kind: TelemetryKind }
  /** read a rollup family directly */
  | { family: string };

/** a shorthand from the UI's RANGES ('7d'), or an explicit half-open ISO pair */
export type ReportRange = string | { from: string; to: string };

export interface ReportFilter {
  /** a DimFacet.key: 'attr:model' | 'field:env' | 'subjectType' | 'field:name' … */
  dim: string;
  op: 'eq' | 'in' | 'gte' | 'lte';
  value: string | string[] | number;
}

export interface Report {
  source: ReportSource;
  range: ReportRange;
  interval?: Interval;
  /** a MeasureFacet.key. Default 'count'; also 'distinct:<subjectType>' and 'funnel' */
  measure?: string;
  /** DimFacet.key[], at most two — three dims is a pivot nobody can read */
  groupBy?: string[];
  filters?: ReportFilter[];
  excludeActorTypes?: string[];
  /** a rendering hint carried with the Report; no primitive takes it today */
  sort?: 'value' | 'label' | 'time';
  limit?: number;
  /** same length, immediately before */
  compare?: 'previous';

  // ── funnel-only (`measure: 'funnel'`) ──
  /** lifetime `by: ['subject']` family names, in order */
  stages?: string[];
  anchor?: string;
  exits?: string[];
  subjectType?: string;
}

/**
 * The pre-Report `ViewSpec.query`. Every view saved before Reports existed is
 * this shape and must keep parsing, so it stays in the union and
 * `normalizeQuery()` lifts it.
 *
 * @deprecated write a {@link Report}. The `display` key this shape used to
 * carry is REMOVED (reports §8): the renderer decides from the Report itself,
 * and a chart/table toggle would be a UI preference rather than view state. A
 * stored view that still carries the key keeps parsing — `spec` is a Mixed
 * document — and the key is ignored.
 */
export interface LegacyQuery {
  range?: string;
  filters?: Record<string, unknown>;
  groupBy?: string;
  sort?: string;
}

// ── the Plan ────────────────────────────────────────────────────────────────

export type PlanPrimitive =
  | 'records' | 'series' | 'breakdown' | 'distribution'
  | 'rollups' | 'distinctCount' | 'funnel';

/**
 * How the executor folds a `rollups` plan. `rollups()` has no server-side
 * groupBy — it returns the family's own docs, and the requested dims ARE that
 * family's dims, so the grouping is a fold over rows rather than a second read.
 * `labels[i]` is the `dims` prefix rollups.ts writes for `groupBy[i]`; a subject
 * dim labels to 'subject' and its stored value is the bare `type:id` ref.
 */
export interface PlanShape {
  groupBy: string[];
  labels: string[];
  measure: string;
  interval?: Interval;
  /** filters the fold applies, because rollups() can only pin whole dims */
  filters?: { dim: string; label: string; op: ReportFilter['op']; value: ReportFilter['value'] }[];
}

export interface Plan {
  primitive: PlanPrimitive;
  /** positional args AFTER scope — the executor is literally `q[primitive](scope, ...args)` */
  args: unknown[];
  exactness: 'exact' | 'raw' | 'scan';
  /** the family that answers it, when one does */
  via?: string;
  /** human sentence — the UI badge and the MCP explanation */
  why: string;
  /** how to fold the rows a `rollups` plan returns */
  shape?: PlanShape;
  /** present when `compare: 'previous'` — same primitive, range shifted back by its own length */
  previous?: { args: unknown[] };
}

export interface Unavailable {
  unavailable: true;
  why: string;
}

// ── ranges ──────────────────────────────────────────────────────────────────

/** the UI's RANGES (util.js), which is the vocabulary a stored view speaks */
const RANGE_MS: Record<string, number> = {
  '1h': 36e5,
  '24h': 864e5,
  '7d': 7 * 864e5,
  '30d': 30 * 864e5,
  '90d': 90 * 864e5,
};

const badRequest = (message: string) =>
  Object.assign(new Error(`telemetry: ${message}`), { status: 400 });

/**
 * A ReportRange → the half-open pair every primitive takes. Shorthands end at
 * `now`, which is injectable so the resolver stays deterministic under test.
 *
 * An unrecognised shorthand THROWS rather than defaulting to 7d the way
 * util.js does: on the client a wrong default draws a chart, here it would
 * silently answer a different question than the one asked.
 */
export function rangeOf(range: ReportRange, now: Date = new Date()): TimeRange {
  if (typeof range === 'string') {
    const ms = RANGE_MS[range] ?? spanOf(range);
    if (ms == null) {
      throw badRequest(
        `range "${range}" is not a known shorthand — use one of ${Object.keys(RANGE_MS).join(', ')}, ` +
          'an `<n>h`/`<n>d` form, or an explicit { from, to } ISO pair',
      );
    }
    return { from: new Date(now.getTime() - ms), to: now };
  }
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw badRequest(
      `range { from: "${range.from}", to: "${range.to}" } is not valid — \`from\` must be a valid ` +
        'ISO time strictly before `to` (the package is half-open everywhere)',
    );
  }
  return { from, to };
}

/** '14d' / '6h' — the generic form mcp.ts already accepts off a stored view */
function spanOf(range: string): number | null {
  const m = /^(\d+)([hd])$/.exec(range);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 36e5 : 864e5);
}

/**
 * The interval that keeps a range under ~120 buckets — util.js `intervalFor`,
 * extended to explicit pairs by their span so a Report built from a date picker
 * lands on the same grain as one built from the range chips.
 */
export function intervalForRange(range: ReportRange, now: Date = new Date()): Interval {
  if (typeof range === 'string' && RANGE_MS[range] != null) {
    return range === '1h' || range === '24h' ? 'hour' : range === '90d' ? 'week' : 'day';
  }
  const { from, to } = rangeOf(range, now);
  const ms = to.getTime() - from.getTime();
  if (ms <= 864e5) return 'hour';
  if (ms < 90 * 864e5) return 'day';
  return 'week';
}

/** hour < day < week < month — a family may be FINER than the interval asked for, never coarser */
const INTERVAL_RANK: Record<Interval, number> = { hour: 0, day: 1, week: 2, month: 3 };

/** the previous window of the same length, immediately before: [from - (to - from), from) */
const shift = (range: TimeRange): TimeRange => ({
  from: new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime())),
  to: range.from,
});

// ── source expansion ────────────────────────────────────────────────────────

interface ResolvedSource {
  form: 'event' | 'namespace' | 'kind' | 'family';
  /** the event names this source expands to, registry order */
  events: string[];
  /** set only by `{ kind }`, where the kind term IS the source and is therefore complete */
  kind?: TelemetryKind;
  family?: FamilyFacet;
}

function expandSource(source: ReportSource, catalog: Catalog): ResolvedSource | Unavailable {
  if ('event' in source) {
    if (!catalog.events[source.event]) {
      return unavailable(
        `no event named "${source.event}" is registered — the catalog knows ${count(Object.keys(catalog.events).length, 'event')}, ` +
          'so either the name is a typo or the registry never declared it',
      );
    }
    return { form: 'event', events: [source.event] };
  }
  if ('namespace' in source) {
    const events = catalog.namespaces[source.namespace];
    if (!events?.length) {
      return unavailable(
        `no event name starts with "${source.namespace}." — the registered namespaces are ` +
          `${Object.keys(catalog.namespaces).join(', ')}`,
      );
    }
    return { form: 'namespace', events: [...events] };
  }
  if ('kind' in source) {
    const events = Object.keys(catalog.events).filter((n) => catalog.events[n]!.kind === source.kind);
    if (!events.length) {
      return unavailable(
        `no event is registered with kind "${source.kind}" — declare one, or pick a kind the registry uses`,
      );
    }
    return { form: 'kind', events, kind: source.kind };
  }
  const family = catalog.families[source.family];
  if (!family) {
    return unavailable(
      `no rollup family "${source.family}" is declared — add a \`rollups: [{ as: '${source.family}', by: [...] }]\` ` +
        'block to the event that should feed it',
    );
  }
  return { form: 'family', events: [...family.feeders], family };
}

// ── dimensions ──────────────────────────────────────────────────────────────

/**
 * Filter-only pseudo dims: they are RecordFilter keys with real indexes behind
 * them, but they are not groupable and so they are not in the catalog. A saved
 * view's `filters.subject` lifts to one of these.
 */
const FILTER_ONLY: Record<string, keyof RecordFilter> = {
  'field:subject': 'subject',
  'field:traceId': 'traceId',
};

/**
 * Every dim this source can offer: the envelope, plus each event's own attrs
 * and kind fields. A key several events declare is `indexed` only when ALL of
 * them index it — one unindexed feeder makes the whole read a scan, and
 * claiming otherwise sells a scan as a lookup (reports §11.3).
 */
function dimsFor(catalog: Catalog, events: string[]): Map<string, DimFacet> {
  const out = new Map<string, DimFacet>();
  for (const d of catalog.envelope) out.set(d.key, d);
  for (const name of events) {
    for (const d of catalog.events[name]?.dims ?? []) {
      const seen = out.get(d.key);
      out.set(d.key, seen ? { ...seen, indexed: seen.indexed && d.indexed } : d);
    }
  }
  return out;
}

/** the measure keys this source declares — 'count', 'sum:cost_usd', 'p95:durationMs' … */
const measureDeclared = (catalog: Catalog, events: string[], key: string): boolean =>
  key === 'count' || events.some((n) => catalog.events[n]?.measures.some((m) => m.key === key));

const MEASURE_OP = /^(sum|avg|p50|p90|p95|p99):(.+)$/;

// ── the resolver ────────────────────────────────────────────────────────────

const unavailable = (why: string): Unavailable => ({ unavailable: true, why });

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export interface ResolveOptions {
  /** injected so a plan is deterministic — shorthand ranges end here */
  now?: Date;
  limits?: Partial<QueryLimits>;
}

/**
 * Report → Plan, first match wins (reports §6). The order is a preference
 * order: an exact rollup read beats a raw scan, and a refusal beats a query
 * that 400s at the database.
 *
 * One deviation from the plan's table, because the table's rows overlap:
 * `records` is tried BEFORE `series`. A Report with no measure still has the
 * default measure 'count', so the series rule would match everything and the
 * records rule would be unreachable. Asking for a measure — `measure: 'count'`
 * explicitly — is what distinguishes "chart this" from "show me the rows".
 */
export function resolveReport(report: Report, catalog: Catalog, opts: ResolveOptions = {}): Plan | Unavailable {
  const now = opts.now ?? new Date();
  const limits = opts.limits ?? {};
  const src = expandSource(report.source, catalog);
  if ('unavailable' in src) return src;

  const measure = report.measure ?? 'count';
  const groupBy = report.groupBy ?? [];
  if (groupBy.length > 2) {
    return unavailable(
      `groupBy takes at most 2 dimensions, got ${groupBy.length} (${groupBy.join(', ')}) — three dims is a ` +
        'pivot table nobody can read and a group count that multiplies',
    );
  }
  if (report.interval && INTERVAL_RANK[report.interval] == null) {
    return unavailable(`interval "${report.interval}" is not one of hour, day, week, month`);
  }

  // 1 — cohort funnels, over lifetime milestone families only
  if (measure === 'funnel') return planFunnel(report, catalog, now, limits);

  // 2 — distinct subjects per period, off a bucketed single-subject family
  if (measure.startsWith('distinct:')) return planDistinct(report, catalog, src, measure, now);

  const opMatch = MEASURE_OP.exec(measure);
  if (measure !== 'count' && !opMatch) {
    return unavailable(
      `measure "${measure}" is not a measure — use 'count', 'sum:<metric>', 'avg:<metric>', ` +
        "'p50|p95|p99:<metric>', 'distinct:<subjectType>' or 'funnel'",
    );
  }
  if (opMatch && !measureDeclared(catalog, src.events, measure)) {
    return unavailable(
      `"${measure}" names a metric no source event declares — add \`${opMatch[2]}\` to the \`metrics\` ` +
        `object of ${src.events.join(', ')}, or pick one of ${metricList(catalog, src.events)}`,
    );
  }

  // 3 — exact, via one indexed rollup read
  const exact = planRollups(report, catalog, src, measure, groupBy, now, limits);
  if (exact) return exact;

  // 4–7 — raw. One filter build, four dispatches.
  const filter = toRecordFilter(report, catalog, src);
  if ('unavailable' in filter) return filter;
  const range = rangeOf(report.range, now);
  const dims = dimsFor(catalog, src.events);
  const touched = [...groupBy, ...(report.filters ?? []).map((f) => f.dim)];
  const unindexed = touched.find((k) => !(dims.get(k)?.indexed ?? FILTER_ONLY[k] != null));
  // the source itself is always pinned by an indexed term now (a name, a name
  // set, or a kind), so the only thing left that can make a read a scan is a
  // dimension with no index behind it
  const scanWhy = unindexed
    ? ` — "${unindexed}" has no index behind it, so this is a collection scan bounded only by the range` +
      (unindexed.startsWith('attr:') ? `; add "${unindexed.slice(5)}" to \`indexedAttrs\` to make it a lookup` : '')
    : '';
  const exactness = unindexed != null ? 'scan' : 'raw';

  // 6 — percentiles come off the raw distribution, and only without a groupBy
  if (opMatch && opMatch[1] !== 'sum' && opMatch[1] !== 'avg') {
    if (groupBy.length) {
      return unavailable(
        `percentiles per group are not offered yet (reports §13) — "${measure}" with ` +
          `groupBy ${groupBy.join(', ')} would be one distribution() read per group. Drop the groupBy, ` +
          'or filter to one group and ask again',
      );
    }
    return withCompare(report, {
      primitive: 'distribution',
      args: [range, filter, { measure: opMatch[2]! }],
      exactness,
      why:
        `${measure} is approximate by construction ($percentile t-digest over the matched records)` +
        `${scanWhy}`,
    });
  }

  // 4 — top groups by one or two dims
  if (groupBy.length) {
    const bad = groupBy.find((k) => !dims.has(k));
    if (bad) {
      return unavailable(
        `"${bad}" is not a dimension of ${describe(src)} — group by one of ${[...dims.keys()].join(', ')}`,
      );
    }
    return withCompare(report, {
      primitive: 'breakdown',
      args: [
        range,
        filter,
        {
          groupBy,
          measure,
          ...(report.interval ? { interval: report.interval } : {}),
          ...(report.limit ? { limit: capped(report.limit, limits.breakdown) } : {}),
        },
      ],
      exactness,
      why: `raw ${measure} by ${groupBy.join(' × ')} over the range${scanWhy}`,
    });
  }

  // 7 — no measure, no groupBy, no interval: the reader wants the rows
  if (!report.measure && !report.interval) {
    return withCompare(report, {
      primitive: 'records',
      args: [range, filter, report.limit ? { limit: capped(report.limit, limits.records) } : {}],
      exactness,
      why: `the matching records themselves, newest first${scanWhy}`,
    });
  }

  // 5 — one line over time
  const interval = report.interval ?? intervalForRange(report.range, now);
  return withCompare(report, {
    primitive: 'series',
    args: [range, filter, { measure, interval }],
    exactness,
    why: `raw ${measure} per ${interval} over the range${scanWhy}`,
  });
}

const capped = (limit: number, cap: number | undefined) =>
  cap == null ? limit : Math.max(1, Math.min(limit, cap));

const describe = (src: ResolvedSource) =>
  src.form === 'family' ? `family "${src.family!.as}"` : src.events.join(', ');

const metricList = (catalog: Catalog, events: string[]) => {
  const keys = new Set<string>();
  for (const n of events) for (const m of catalog.events[n]?.measures ?? []) keys.add(m.key);
  return keys.size ? [...keys].join(', ') : 'nothing but count';
};

// ── rule 1: funnel ──────────────────────────────────────────────────────────

/**
 * Every stage, the anchor and every exit must be a lifetime `by: ['subject']`
 * family. The predicate and the messages mirror funnel.ts `requireMilestoneFamily`
 * — that function takes a Registry and this file only ever sees a Catalog, so
 * the FamilyFacet carries the same three facts (`lifetime`, `by`, `feeders`)
 * and the refusals read the same. A resolver that refused for a different
 * reason than the primitive throws for would be worse than no check at all.
 */
function planFunnel(
  report: Report,
  catalog: Catalog,
  now: Date,
  limits: Partial<QueryLimits>,
): Plan | Unavailable {
  const stages = report.stages ?? [];
  if (!stages.length) {
    return unavailable(
      "`measure: 'funnel'` needs `stages` — one or more lifetime `by: ['subject']` rollup family names, " +
        'in the order a subject reaches them',
    );
  }
  const anchor = report.anchor ?? stages[0]!;
  const exits = report.exits ?? [];
  for (const as of [...stages, anchor, ...exits]) {
    const refusal = milestoneRefusal(catalog, as);
    if (refusal) return unavailable(refusal);
  }

  // one funnel is one population: two stages restricted to different subject
  // types would report conversions between subjects that are not the same party
  const first = catalog.families[stages[0]!]!;
  for (const as of [...stages.slice(1), anchor]) {
    const f = catalog.families[as]!;
    if (!sameSet(f.subjectTypes, first.subjectTypes)) {
      return unavailable(
        `funnel stages must share one subject type: "${stages[0]}" is declared \`subjects: [${first.subjectTypes.join(', ')}]\` ` +
          `and "${as}" is \`subjects: [${f.subjectTypes.join(', ')}]\` — two populations cannot convert into each other`,
      );
    }
  }
  if (report.subjectType && !first.subjectTypes.includes(report.subjectType)) {
    return unavailable(
      `subjectType "${report.subjectType}" is not one of the stages' subjects (${first.subjectTypes.join(', ')}) — ` +
        'the cohort would be empty',
    );
  }
  if (report.interval === 'hour') {
    return unavailable(
      'funnel slices are day, week or month — an hourly cohort slice is not offered, because a cohort is ' +
        'assembled from lifetime milestones with no hourly grain to slice on',
    );
  }

  const params: Record<string, unknown> = {
    stages: stages.map((as) => ({ as })),
    anchor,
    ...(exits.length ? { exits: exits.map((as) => ({ as })) } : {}),
    cohort: rangeOf(report.range, now),
    ...(report.subjectType ? { subjectType: report.subjectType } : {}),
    ...(report.interval ? { interval: report.interval } : {}),
    ...(report.limit ? { limit: capped(report.limit, limits.funnel) } : {}),
  };
  return withCompare(report, {
    primitive: 'funnel',
    args: [params],
    exactness: 'exact',
    via: anchor,
    why:
      `cohort funnel over ${count(stages.length, 'lifetime milestone family')}, anchored on "${anchor}" — ` +
      'rollups only, no raw scan',
  });
}

/** the funnel.ts precondition, said against a FamilyFacet. null when the family qualifies. */
function milestoneRefusal(catalog: Catalog, as: string): string | null {
  const f = catalog.families[as];
  if (!f) {
    return (
      `no rollup family "${as}" is declared. Add a \`rollups: [{ as: '${as}', by: ['subject'], subjects: [...] }]\` ` +
      'block to the event that marks it'
    );
  }
  const shape = `by: [${f.by.map((d) => `'${d}'`).join(', ')}]${f.bucket ? `, bucket: '${f.bucket}'` : ''}`;
  if (!f.lifetime) {
    return (
      `rollup family "${as}" (declared on "${f.feeders[0]}") is BUCKETED (${shape}). A milestone needs a ` +
      'lifetime family so `firstAt` is the one moment the subject reached it; a bucketed family has one doc ' +
      'per period and would count the same subject repeatedly'
    );
  }
  if (f.by.length !== 1 || f.by[0] !== 'subject') {
    return (
      `rollup family "${as}" (declared on "${f.feeders[0]}") is keyed ${shape}, but a milestone must be keyed ` +
      "by exactly one subject dim (`by: ['subject']`). Extra dims split one subject across several docs, " +
      'which would over-count every stage'
    );
  }
  return null;
}

// ── rule 2: distinct ────────────────────────────────────────────────────────

function planDistinct(
  report: Report,
  catalog: Catalog,
  src: ResolvedSource,
  measure: string,
  now: Date,
): Plan | Unavailable {
  const subjectType = measure.slice('distinct:'.length);
  if (!subjectType) {
    return unavailable(
      `"${measure}" needs a subject type — 'distinct:account', one of ${catalog.subjectTypes.join(', ')}`,
    );
  }
  if (!catalog.subjectTypes.includes(subjectType)) {
    return unavailable(
      `no event or rollup declares the subject type "${subjectType}" — the registry knows ` +
        `${catalog.subjectTypes.join(', ') || 'no subject types at all'}`,
    );
  }
  if (report.groupBy?.length) {
    return unavailable(
      `distinct counts take no groupBy: distinctCount() answers one series per family, and "${report.groupBy.join(', ')}" ` +
        "would need a family keyed by those dims AND `by: ['subject']`, which cannot count subjects exactly",
    );
  }

  // one doc per (subject, bucket) is the whole exactness argument — the same
  // predicate query.ts `requireDistinctFamily` enforces at read time
  const wanted = new Set(src.events);
  const fits = Object.values(catalog.families).filter(
    (f) =>
      f.bucket != null &&
      f.by.length === 1 &&
      f.by[0] === 'subject' &&
      f.subjectTypes.includes(subjectType) &&
      src.events.every((e) => f.feeders.includes(e)),
  );
  const family = fits.find((f) => sameSet(f.feeders, [...wanted])) ?? fits[0];
  if (!family) {
    return unavailable(
      `no bucketed \`by: ['subject']\` family covers ${src.events.join(', ')} for subject type "${subjectType}" — ` +
        `declare \`rollups: [{ as: 'activity', by: ['subject'], subjects: ['${subjectType}'], bucket: 'day' }]\` ` +
        'on the events that count as activity',
    );
  }
  const superset = !sameSet(family.feeders, [...wanted]);
  return withCompare(report, {
    primitive: 'distinctCount',
    args: [
      {
        as: family.as,
        subjectType,
        range: rangeOf(report.range, now),
        ...(report.interval ? { interval: report.interval } : {}),
      },
    ],
    exactness: 'exact',
    via: family.as,
    why:
      `"${family.as}" writes exactly one doc per (subject, ${family.bucket}), so distinct subjects IS the doc ` +
      'count — exact, no sketch' +
      (superset
        ? `. Its feeders (${family.feeders.join(', ')}) are a SUPERSET of the source (${src.events.join(', ')}), ` +
          'so the count includes subjects who only did the others'
        : ''),
  });
}

// ── rule 3: exact via rollups ───────────────────────────────────────────────

/** a family dim in groupBy/filter vocabulary — the subject dim is asked for as `subjectType` */
const famDims = (f: FamilyFacet) => f.by.map((b) => (b === 'subject' ? 'subjectType' : (b as string)));

/**
 * The cheapest read in the package: a family whose docs ARE the answer. Every
 * condition below is a way the family could be a different question than the
 * one asked, and any one of them falling through to raw is correct — a raw plan
 * is slower, never wrong.
 *
 * Returns null (not Unavailable) when nothing matches, because "no family
 * answers this exactly" is not a refusal.
 */
function planRollups(
  report: Report,
  catalog: Catalog,
  src: ResolvedSource,
  measure: string,
  groupBy: string[],
  now: Date,
  limits: Partial<QueryLimits>,
): Plan | null {
  // an actor-type exclusion is a WRITE-time decision for a family (`actors`),
  // so a read-time one cannot be applied to rows already accumulated
  if (report.excludeActorTypes?.length) return null;

  const candidates = src.family
    ? [src.family]
    : Object.values(catalog.families).filter((f) => sameSet(f.feeders, src.events));

  const op = MEASURE_OP.exec(measure);
  const filters = report.filters ?? [];
  const fits = candidates.filter((f) => {
    const dims = famDims(f);
    if (!groupBy.every((k) => dims.includes(k))) return false;
    if (report.interval && (!f.bucket || INTERVAL_RANK[f.bucket] > INTERVAL_RANK[report.interval])) return false;
    if (op) {
      // `sum` is stored; `avg` is sums[k]/count, which is exact off the same doc
      if ((op[1] !== 'sum' && op[1] !== 'avg') || !f.sums.includes(op[2]!)) return false;
    }
    // a rollup `dims` entry is a STRING ('region=eu'), so a family dim answers
    // equality and set membership and nothing else — a numeric bound belongs to
    // the raw path, where it can read `metrics.<k>`
    return filters.every(
      (t) => (dims.includes(t.dim) && (t.op === 'eq' || t.op === 'in')) || nameFilterCovers(t, f),
    );
  });
  // fewest dims wins: the cheapest read and the tightest match, since a wider
  // family would have to be folded down to the same groups anyway
  const family = fits.sort((a, b) => a.by.length - b.by.length)[0];
  if (!family) return null;

  const dims = famDims(family);
  const range = rangeOf(report.range, now);
  const on = family.lifetime ? 'firstAt' : 'bucketAt';
  // a `field:name` term is already answered by the family's feeders; the rest
  // are dim equalities the executor applies while folding the rows
  const fold = filters.filter((t) => dims.includes(t.dim));
  return withCompare(report, {
    primitive: 'rollups',
    args: [
      {
        as: family.as,
        on,
        range,
        sort: family.lifetime ? 'count' : 'bucketAt',
        ...(report.limit ? { limit: capped(report.limit, limits.rollups) } : {}),
      },
    ],
    exactness: 'exact',
    via: family.as,
    shape: {
      groupBy,
      labels: groupBy.map((k) => family.labels[dims.indexOf(k)]!),
      measure,
      ...(report.interval ? { interval: report.interval } : {}),
      ...(fold.length
        ? { filters: fold.map((t) => ({ ...t, label: family.labels[dims.indexOf(t.dim)]! })) }
        : {}),
    },
    why:
      `family "${family.as}" is keyed by ${dims.join(', ') || 'nothing but its feeders'} and maintained on write, ` +
      `so this is one indexed rollup read over \`${on}\` instead of a raw scan` +
      (op?.[1] === 'avg'
        ? `. avg:${op[2]} is exact off a rollup: the executor divides sums.${op[2]} by count`
        : '') +
      (report.interval && family.bucket !== report.interval
        ? `. Its ${family.bucket} buckets roll up into ${report.interval} without splitting one`
        : ''),
  });
}

/**
 * A `field:name` filter is not a family dim — a rollup doc does not record which
 * event wrote it — but it costs nothing when the names it admits already cover
 * every feeder, because then it removes nothing the family holds.
 */
function nameFilterCovers(t: ReportFilter, f: FamilyFacet): boolean {
  if (t.dim !== 'field:name') return false;
  const admitted = t.op === 'eq' ? [String(t.value)] : t.op === 'in' ? [...(t.value as string[])].map(String) : null;
  return admitted != null && f.feeders.every((n) => admitted.includes(n));
}

// ── the raw filter ──────────────────────────────────────────────────────────

/** the RecordFilter keys a `field:` filter maps onto, equality only */
const FIELD_TERMS: Record<string, keyof RecordFilter> = {
  'field:kind': 'kind',
  'field:name': 'name',
  'field:severity': 'severity',
  'field:env': 'env',
  'field:service': 'service',
  'field:release': 'release',
  ...FILTER_ONLY,
};

/**
 * Report → RecordFilter, the shape every raw primitive takes. Deliberately
 * total over what RecordFilter can EXPRESS and refusing everything else: this
 * plan step is where "the query layer is missing a parameter" gets said out
 * loud (dashboards law 6) rather than papered over with a filter that reads
 * more records than the Report asked about.
 */
function toRecordFilter(report: Report, catalog: Catalog, src: ResolvedSource): RecordFilter | Unavailable {
  const filter: RecordFilter = {};

  if (src.events.length === 1) {
    // one name pins the read exactly, whichever source form named it
    filter.name = src.events[0];
  } else if (src.kind) {
    // a kind term IS the source: `{ kind }` expanded to every event declaring
    // it, so one indexed equality covers exactly that set for less than an
    // `$in` over every name in it
    filter.kind = src.kind;
  } else {
    // a namespace or a family is several names, and `RecordFilter.name` takes
    // the set — so the read is the source, exactly, rather than "every record
    // of that kind in the range" with a note apologising for it
    filter.name = [...src.events];
  }

  for (const t of report.filters ?? []) {
    const term = FIELD_TERMS[t.dim];
    if (term) {
      if (t.op !== 'eq') {
        return unavailable(
          `"${t.dim}" supports equality only on the raw path — RecordFilter.${String(term)} is one string, ` +
            `and "${t.op}" would need a term query.ts does not build`,
        );
      }
      (filter as Record<string, unknown>)[term] = String(t.value);
      continue;
    }
    if (t.dim.startsWith('attr:')) {
      const key = t.dim.slice(5);
      if (t.op === 'eq') {
        (filter.attrs ??= {})[key] = String(t.value);
        continue;
      }
      if (t.op === 'gte' || t.op === 'lte') {
        // a numeric bound names a METRIC — `metrics.<k>` is the only ranged
        // term buildMatch writes, and attrs are strings after casting
        if (!measureDeclared(catalog, src.events, `sum:${key}`)) {
          return unavailable(
            `"${t.dim} ${t.op}" is a numeric bound, which only a declared metric can carry — add \`${key}\` to ` +
              `the \`metrics\` object of ${src.events.join(', ')}, or filter it as an equality`,
          );
        }
        const range = ((filter.metrics ??= {})[key] ??= {});
        range[t.op] = Number(t.value);
        continue;
      }
      return unavailable(
        `"${t.dim}" supports equality (or a gte/lte bound on a metric) — an \`in\` over attrs would need a ` +
          '`$in` term buildMatch does not write',
      );
    }
    if (t.dim === 'subjectType' || t.dim === 'actorType') {
      return unavailable(
        `"${t.dim}" is derived at query time from ${t.dim === 'subjectType' ? '`subjectKeys`' : '`actor`'} and ` +
          'RecordFilter has no term for it — group by it instead, pin one subject with `field:subject`' +
          (t.dim === 'actorType' ? ', or use `excludeActorTypes`' : ''),
      );
    }
    return unavailable(
      `"${t.dim}" is not filterable on the raw path — RecordFilter carries ${Object.keys(FIELD_TERMS).join(', ')}, ` +
        '`attr:<key>` and metric bounds',
    );
  }

  if (report.excludeActorTypes?.length) filter.excludeActorTypes = [...report.excludeActorTypes];
  return filter;
}

// ── compare ─────────────────────────────────────────────────────────────────

/**
 * `compare: 'previous'` is pure arithmetic on the Report: the same plan, its
 * range shifted back by its own length. No primitive changes, and the executor
 * runs the same call twice.
 *
 * Each primitive keeps its range in a different place, which is exactly why the
 * shift lives here rather than in seven call sites.
 */
function withCompare(report: Report, plan: Plan): Plan {
  if (report.compare !== 'previous') return plan;
  const [first, ...rest] = plan.args;
  if (plan.primitive === 'rollups' || plan.primitive === 'distinctCount' || plan.primitive === 'funnel') {
    const params = first as Record<string, unknown>;
    const key = plan.primitive === 'funnel' ? 'cohort' : 'range';
    const window = params[key] as (TimeRange & { endInclusive?: boolean }) | undefined;
    if (!window) return plan;
    return { ...plan, previous: { args: [{ ...params, [key]: { ...window, ...shift(window) } }, ...rest] } };
  }
  return { ...plan, previous: { args: [shift(first as TimeRange), ...rest] } };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

// ── the URL form (reports §4, §11.4) ────────────────────────────────────────

/**
 * A Report is a URL. These two are inverses — `parseReportQuery(reportToQuery(r))`
 * deep-equals `r` — and they are the ONLY encoding: `GET /api/report` reads it,
 * the explore hash carries it, and util.js implements the same grammar on the
 * client. A Report that needed state a URL cannot hold would mean the query
 * layer is missing a parameter (dashboards law 6), not that the encoder needs a
 * blob.
 *
 *   source=event:llm.completion&range=7d&interval=day&measure=sum:cost_usd
 *     &groupBy=attr:gen_ai_request_model&filter=attr:feature:eq:chat&compare=previous
 *
 * Everything is flat and human-typable. `filter` REPEATS (express parses repeats
 * into an array; one stays a string, and both are accepted), because a term's
 * value may contain a comma — an `in` list is exactly that.
 */
const FILTER_OPS = new Set<ReportFilter['op']>(['eq', 'in', 'gte', 'lte']);
const SORTS = new Set(['value', 'label', 'time']);

export function parseReportQuery(q: Record<string, unknown>): Report {
  /** a repeated param takes its first value; every param but `filter` is single */
  const str = (k: string): string | undefined => {
    const v = Array.isArray(q[k]) ? (q[k] as unknown[])[0] : q[k];
    return typeof v === 'string' && v ? v : undefined;
  };
  const list = (k: string): string[] =>
    (str(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const raw = str('source');
  if (!raw) {
    throw badRequest(
      '`source` is required — one of source=event:<name>, namespace:<ns>, kind:<kind>, family:<as>',
    );
  }
  const cut = raw.indexOf(':');
  const form = cut > 0 ? raw.slice(0, cut) : '';
  const named = cut > 0 ? raw.slice(cut + 1) : '';
  if (!named || !['event', 'namespace', 'kind', 'family'].includes(form)) {
    throw badRequest(
      `\`source\` must be "event:<name>", "namespace:<ns>", "kind:<kind>" or "family:<as>" — got "${raw}"`,
    );
  }
  const source: ReportSource =
    form === 'event'
      ? { event: named }
      : form === 'namespace'
        ? { namespace: named }
        : form === 'kind'
          ? { kind: named as TelemetryKind }
          : { family: named };

  // the shorthand wins when both are present: it is the Report's own param, and
  // the shell's from/to ride along on every URL the SPA builds
  const shorthand = str('range');
  const from = str('from');
  const to = str('to');
  if (!shorthand && !(from && to)) {
    throw badRequest('a range is required — either `range=7d` or both `from` and `to` as ISO times');
  }
  const range: ReportRange = shorthand ?? { from: from!, to: to! };

  const interval = str('interval');
  if (interval && INTERVAL_RANK[interval as Interval] == null) {
    throw badRequest(`\`interval\` must be one of hour, day, week, month — got "${interval}"`);
  }
  const sort = str('sort');
  if (sort && !SORTS.has(sort)) {
    throw badRequest(`\`sort\` must be one of value, label, time — got "${sort}"`);
  }
  const compare = str('compare');
  if (compare && compare !== 'previous') {
    throw badRequest(`\`compare\` takes only "previous" — got "${compare}"`);
  }
  const limitRaw = str('limit');
  const limit = limitRaw == null ? undefined : Number(limitRaw);
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    throw badRequest(`\`limit\` must be a positive integer — got "${limitRaw}"`);
  }

  const measure = str('measure');
  const groupBy = list('groupBy');
  const excludeActorTypes = list('excludeActors');
  const stages = list('stages');
  const exits = list('exits');
  const anchor = str('anchor');
  const subjectType = str('subjectType');
  const filters = (
    q.filter == null ? [] : Array.isArray(q.filter) ? q.filter.map(String) : [String(q.filter)]
  ).map(parseFilterTerm);

  return {
    source,
    range,
    ...(interval ? { interval: interval as Interval } : {}),
    ...(measure ? { measure } : {}),
    ...(groupBy.length ? { groupBy } : {}),
    ...(filters.length ? { filters } : {}),
    ...(excludeActorTypes.length ? { excludeActorTypes } : {}),
    ...(sort ? { sort: sort as Report['sort'] } : {}),
    ...(limit != null ? { limit } : {}),
    ...(compare ? { compare: 'previous' as const } : {}),
    ...(stages.length ? { stages } : {}),
    ...(anchor ? { anchor } : {}),
    ...(exits.length ? { exits } : {}),
    ...(subjectType ? { subjectType } : {}),
  };
}

/**
 * `<dim>:<op>:<value>`, where the DIM itself contains a colon (`attr:model`) and
 * so may the value (`field:subject:eq:user:u_1`). The op is therefore found
 * rather than positioned: the FIRST token that is one of the four operators
 * ends the dim and begins the value. A dim whose last segment is literally
 * "eq"/"in"/"gte"/"lte" would mis-split, which is the price of a grammar a
 * person can type; nothing in the catalog's vocabulary produces one.
 */
function parseFilterTerm(term: string): ReportFilter {
  const parts = term.split(':');
  const i = parts.findIndex((p) => FILTER_OPS.has(p as ReportFilter['op']));
  const rest = i < 0 ? '' : parts.slice(i + 1).join(':');
  // an EMPTY value is refused with the rest: `field:env:eq:` reads as "env is
  // the empty string", which nothing stores — it is a half-typed URL, and
  // answering it would return zero rows that look like an answer
  if (i < 1 || !rest) {
    throw badRequest(
      `\`filter\` must be "<dim>:<op>:<value>" with op one of eq, in, gte, lte — got "${term}"`,
    );
  }
  const dim = parts.slice(0, i).join(':');
  const op = parts[i] as ReportFilter['op'];
  if (op === 'in') {
    const values = rest.split(',').map((s) => s.trim()).filter(Boolean);
    if (!values.length) throw badRequest(`\`filter\` "${term}" has an empty \`in\` list`);
    return { dim, op, value: values };
  }
  if (op === 'gte' || op === 'lte') {
    const n = Number(rest);
    if (Number.isNaN(n)) throw badRequest(`\`filter\` bound "${term}" is not a number`);
    return { dim, op, value: n };
  }
  return { dim, op, value: rest };
}

/**
 * The inverse. `filter` is the one key that can hold several values — one term
 * stays a string so the URL reads the way a person would write it, several
 * become the repeated-param array express parses back.
 */
export function reportToQuery(report: Report): Record<string, string | string[]> {
  const s = report.source;
  const q: Record<string, string | string[]> = {
    source:
      'event' in s
        ? `event:${s.event}`
        : 'namespace' in s
          ? `namespace:${s.namespace}`
          : 'kind' in s
            ? `kind:${s.kind}`
            : `family:${s.family}`,
  };
  if (typeof report.range === 'string') q.range = report.range;
  else {
    q.from = report.range.from;
    q.to = report.range.to;
  }
  if (report.interval) q.interval = report.interval;
  if (report.measure) q.measure = report.measure;
  if (report.groupBy?.length) q.groupBy = report.groupBy.join(',');
  if (report.filters?.length) {
    const terms = report.filters.map(
      (f) => `${f.dim}:${f.op}:${Array.isArray(f.value) ? f.value.join(',') : String(f.value)}`,
    );
    q.filter = terms.length === 1 ? terms[0]! : terms;
  }
  if (report.excludeActorTypes?.length) q.excludeActors = report.excludeActorTypes.join(',');
  if (report.sort) q.sort = report.sort;
  if (report.limit != null) q.limit = String(report.limit);
  if (report.compare) q.compare = report.compare;
  if (report.stages?.length) q.stages = report.stages.join(',');
  if (report.anchor) q.anchor = report.anchor;
  if (report.exits?.length) q.exits = report.exits.join(',');
  if (report.subjectType) q.subjectType = report.subjectType;
  return q;
}

// ── the legacy lift ─────────────────────────────────────────────────────────

/** legacy filter key → the DimFacet key its equality term becomes */
const LEGACY_DIMS: Record<string, string> = {
  kind: 'field:kind',
  name: 'field:name',
  severity: 'field:severity',
  env: 'field:env',
  service: 'field:service',
  release: 'field:release',
  subject: 'field:subject',
  traceId: 'field:traceId',
};

/**
 * The stored-view lift (reports §4). `ViewSpec.query` is a `Report` now — the
 * derived ones included — but every view saved before this shipped is
 * `{ range, filters, groupBy, sort }`, a Mixed document that must keep parsing.
 *
 * Returns null when nothing in the query identifies a source, because a legacy
 * query that names neither an event, a kind nor a family is not a Report — it
 * is a page's default, and the caller's own fallback is the honest answer.
 */
export function normalizeQuery(query: ViewSpec['query'] | null | undefined): Report | null {
  if (!query || typeof query !== 'object') return null;
  if ('source' in query && query.source) return query as Report;

  const q = query as LegacyQuery;
  const filters = (q.filters ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

  // a family read is more specific than a kind page, and a name more specific
  // than either — whichever is present wins in that order
  const name = str(filters.name);
  const family = str(filters.rollup);
  const kind = str(filters.kind);
  const source: ReportSource | null = name
    ? { event: name }
    : family
      ? { family }
      : kind
        ? { kind: kind as TelemetryKind }
        : null;
  if (!source) return null;

  const consumed = name ? 'name' : family ? 'rollup' : 'kind';
  const terms: ReportFilter[] = [];
  for (const [k, v] of Object.entries(filters)) {
    if (k === consumed || k === 'rollup') continue;
    if (k === 'excludeActorTypes') continue;
    if (k === 'attrs') {
      // the FilterBar's own encoding, both ways round: an object, or 'a:b,c:d'
      const entries =
        typeof v === 'string'
          ? v.split(',').map((pair) => pair.split(':').map((s) => s.trim()))
          : Object.entries((v ?? {}) as Record<string, unknown>).map(([a, b]) => [a, String(b)]);
      for (const [key, value] of entries) {
        if (key && value != null) terms.push({ dim: `attr:${key}`, op: 'eq', value: String(value) });
      }
      continue;
    }
    const dim = LEGACY_DIMS[k];
    const value = str(v);
    if (dim && value) terms.push({ dim, op: 'eq', value });
  }

  const groupBy = (q.groupBy ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sort = q.sort === 'value' || q.sort === 'label' || q.sort === 'time' ? q.sort : undefined;
  const actors = filters.excludeActorTypes;

  return {
    source,
    range: q.range ?? '7d',
    ...(terms.length ? { filters: terms } : {}),
    ...(groupBy.length ? { groupBy } : {}),
    ...(sort ? { sort } : {}),
    ...(Array.isArray(actors) && actors.length ? { excludeActorTypes: actors.map(String) } : {}),
  };
}
