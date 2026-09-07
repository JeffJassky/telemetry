import { truncate } from './rollups.js';
import { resolveReport, type Plan, type PlanShape, type Report } from './report.js';
import type { Catalog } from './catalog.js';
import type { BreakdownRow, Queries, QueryLimits } from './query.js';

/**
 * The executor (reports §6). `resolveReport` picks a primitive and its
 * arguments; this runs them. One function, two doors — `GET /api/report` and
 * the `run_report` MCP tool — so a Report means the same thing over HTTP and to
 * an agent, and neither door invents a query of its own.
 *
 * It lives here rather than in report.ts because report.ts is PURE: type-only
 * imports, no Mongo, unit-pinned like deriveCatalog. Executing needs `Queries`,
 * which is the whole database. The seam between them is `Plan.args`:
 *
 *   const result = await q[plan.primitive](scope, ...plan.args);
 *
 * That is the entire dispatch. There is no per-primitive adapter here, and the
 * moment one appears the plan shape is wrong.
 *
 * The one thing this file DOES translate is a `rollups` plan, and `foldRollups`
 * below says why: rollups() has no server-side groupBy, so the requested groups
 * are a fold over the docs it returns. The fold produces the same row shape
 * `breakdown()` does, so a renderer never learns which store answered — which
 * is the point of planning an exact read in the first place.
 */

export interface ExecuteOptions {
  /** injected so a plan is deterministic — shorthand ranges end here */
  now?: Date;
  /** forwarded to the resolver, which uses them to cap the plan's own limits */
  limits?: Partial<QueryLimits>;
  /**
   * Applied to a `records` plan's items before they leave. The dashboard has no
   * redactor (its viewer is already inside the tenant); mcp.ts passes its own,
   * because an agent reading raw `data` payloads is the exposure that tool
   * suite defaults against.
   */
  redact?: (items: any[]) => any[];
}

export interface ReportResult {
  /** the Report as executed — after a legacy lift, so the caller can see what ran */
  report: Report;
  plan: Plan;
  /** the primitive's own result, EXCEPT a rollups plan, which arrives folded */
  result: unknown;
  /** present when `compare: 'previous'` — the same call, range shifted back */
  previous?: unknown;
  /** which store answered, read off the result rather than assumed */
  dataSource: 'raw' | 'rollups' | 'raw+rollups';
}

/**
 * Report → the answer. Refusals are 400s: `Unavailable` is not an exception in
 * the resolver (a refusal is an answer), but by the time someone has asked for
 * the DATA it is — the `why` is the message, verbatim, because it already names
 * the offending key and the registry change that would fix it.
 */
export async function executeReport(
  q: Queries,
  scope: string,
  report: Report,
  catalog: Catalog,
  opts: ExecuteOptions = {},
): Promise<ReportResult> {
  const plan = resolveReport(report, catalog, { now: opts.now, limits: opts.limits });
  if ('unavailable' in plan) throw Object.assign(new Error(plan.why), { status: 400 });

  const run = async (args: unknown[]): Promise<unknown> => {
    // the contract, verbatim. `args` is positional and typed `unknown[]`, so the
    // cast is the one place the plan's promise is taken on trust — report.test.ts
    // pins the args shape per primitive, dashboard.test.ts executes all seven.
    const raw: any = await (q as any)[plan.primitive](scope, ...args);
    if (plan.primitive === 'rollups' && plan.shape) {
      return foldRollups(raw?.rows ?? [], plan.shape, !!raw?.truncated);
    }
    if (plan.primitive === 'records' && opts.redact) {
      return { ...raw, items: opts.redact(raw?.items ?? []) };
    }
    return raw;
  };

  const [result, previous] = await Promise.all([
    run(plan.args),
    plan.previous ? run(plan.previous.args) : Promise.resolve(undefined),
  ]);
  return {
    report,
    plan,
    result,
    ...(plan.previous ? { previous } : {}),
    dataSource: (result as any)?.dataSource ?? 'raw',
  };
}

// ── folding a rollups plan ──────────────────────────────────────────────────

/** the fields the fold reads off a rollup doc — see rollups.ts for the full shape */
export interface RollupDoc {
  /** dimension values in the family's `by` order: 'region=eu', or a bare 'user:u_1' */
  dims: string[];
  bucketAt?: Date | string | null;
  count?: number;
  sums?: Record<string, number> | Map<string, number> | null;
}

/** what breakdown() returns, from the rollup store instead of the raw one */
export interface FoldedRollups {
  rows: BreakdownRow[];
  /** distinct group tuples, ignoring the time axis — the same count breakdown reports */
  groups: number;
  /** the rollup read hit its cap, so groups are missing */
  truncated: boolean;
  dataSource: 'rollups';
}

const MEASURE_OP = /^(sum|avg):(.+)$/;

/**
 * A family's docs ARE the groups: the requested dims are its own `by` dims, so
 * grouping is arithmetic over rows already read, not a second query. This folds
 * them into the shape `breakdown()` returns — `{ dims, at?, value }` sorted the
 * same way — so the two are interchangeable and a chart cannot tell which store
 * answered. dashboard.test.ts asserts exactly that, number for number, on one
 * seed.
 *
 * Pure: no Mongo, no clock. `truncated` is the primitive's own flag, passed
 * through rather than re-derived, because a fold cannot know what it never saw.
 */
export function foldRollups(
  rows: readonly RollupDoc[],
  shape: PlanShape,
  truncated = false,
): FoldedRollups {
  const op = MEASURE_OP.exec(shape.measure);
  const groups = new Map<string, { dims: (string | null)[]; at?: Date; sum: number; count: number }>();

  for (const doc of rows) {
    const dims = doc?.dims ?? [];
    if (!(shape.filters ?? []).every((f) => admits(f, dimValue(dims, f.label)))) continue;
    const tuple = shape.labels.map((label) => dimValue(dims, label));
    // a family may bucket FINER than the interval asked for (day rows → weeks);
    // re-truncating a bucket start cannot split one, so the roll-up stays exact
    const at =
      shape.interval && doc.bucketAt ? truncate(new Date(doc.bucketAt as any), shape.interval) : undefined;
    const key = `${JSON.stringify(tuple)}|${at ? at.getTime() : ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { dims: tuple, ...(at ? { at } : {}), sum: 0, count: 0 }));
    g.count += typeof doc.count === 'number' ? doc.count : 0;
    if (op) g.sum += sumOf(doc.sums, op[2]!);
  }

  const rowsOut: BreakdownRow[] = [...groups.values()].map((g) => ({
    dims: g.dims,
    ...(g.at ? { at: g.at } : {}),
    // avg is sums[k]/count off the SAME doc, which is exact — not an average of
    // averages, which is what folding a per-bucket mean would have produced
    value: !op ? g.count : op[1] === 'sum' ? g.sum : g.count ? g.sum / g.count : 0,
  }));
  rowsOut.sort(
    shape.interval
      ? (a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0) || byDims(a, b)
      : (a, b) => b.value - a.value || byDims(a, b),
  );

  return {
    rows: rowsOut,
    groups: new Set([...groups.values()].map((g) => JSON.stringify(g.dims))).size,
    truncated,
    dataSource: 'rollups',
  };
}

/**
 * One dim value out of a doc's `dims`, by the label rollups.ts wrote in front of
 * it. A SUBJECT dim is the exception and keeps its native `type:id` ref with no
 * `label=` prefix — erasure matches those directly (rollups.ts) — so it is
 * found as the entry that carries no `=` at all, and returned whole. That is
 * also what `breakdown()` returns for `subjectType`'s sibling dims, so the two
 * row shapes stay comparable.
 */
function dimValue(dims: readonly string[], label: string): string | null {
  const prefix = `${label}=`;
  for (const d of dims) if (d.startsWith(prefix)) return d.slice(prefix.length);
  for (const d of dims) if (!d.includes('=')) return d;
  return null;
}

/** the fold's half of a filter — rollups() can only pin whole dims (reports §6) */
function admits(f: NonNullable<PlanShape['filters']>[number], value: string | null): boolean {
  if (f.op === 'in') return (f.value as unknown[]).map(String).includes(String(value));
  if (f.op === 'gte' || f.op === 'lte') {
    const n = Number(value);
    if (Number.isNaN(n)) return false;
    return f.op === 'gte' ? n >= Number(f.value) : n <= Number(f.value);
  }
  return String(value) === String(f.value);
}

/** lean() hands back a plain object; a hydrated doc hands back a Map. Read both. */
function sumOf(sums: RollupDoc['sums'], key: string): number {
  if (!sums) return 0;
  const v = sums instanceof Map ? sums.get(key) : (sums as Record<string, number>)[key];
  return typeof v === 'number' ? v : 0;
}

/** breakdown sorts ties by its `_id` tuple; matching that keeps the two orders identical */
function byDims(a: BreakdownRow, b: BreakdownRow): number {
  for (let i = 0; i < a.dims.length; i++) {
    const x = a.dims[i] ?? '';
    const y = b.dims[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
