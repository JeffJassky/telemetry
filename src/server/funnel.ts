import type { Model } from 'mongoose';
import type { Registry, RollupSpec } from './registry.js';
import { truncate } from './rollups.js';
import type { TimeRange } from './query.js';

/**
 * The sixth read primitive: cohort funnels over lifetime milestone rollups
 * (cohort-math §1). Every host that models milestones as lifetime rollups then
 * rewrites the same three things — stage ordering, the cohort window, and the
 * median time-to-step aggregation. This file is that code, once.
 *
 * The formulas are ported verbatim from maxed's `src/server/telemetry/funnel.ts`
 * (recon: plans/cohort-math.md). Names differ where maxed's were host-specific
 * or actively wrong; the mapping is exact and total:
 *
 *   maxed                     here                      why
 *   ─────────────────────────────────────────────────────────────────────────
 *   accounts                  subjects                  the package counts subjects, not accounts
 *   first                     first                     unchanged — |{s : stage 1 present}|
 *   pctOfFirst                pctOfFirst                unchanged
 *   pctOfPrevious             pctOfPrevious             unchanged
 *   medianDaysFromSignup      medianDaysFromAnchor      the anchor milestone is configurable here
 *   medianDaysFromPrevious    medianDaysFromPrevious    unchanged
 *   StageSummary.stuckAccounts   notReached             reached k−1, not k  (drop-off INTO k)
 *   accountsStuckAt(k)           stalledAt              reached k, not k+1  (drop-off OUT OF k)
 *
 * The last two are the deliberate divergence. maxed ships both quantities under
 * the word "stuck", and its `accountsStuckAt` reports every CONVERTED subject as
 * stuck because the terminal stage has no k+1 to fail (cohort-math H3). Here the
 * two quantities have two names and `stalledAt` is **null** on the terminal
 * stage — "how many stalled here" has no answer when there is nowhere to go
 * next, and 0 would be as wrong as `subjects`.
 *
 * Interval convention: the package is half-open (`$gte`/`$lt`) everywhere and
 * stays that way. maxed's cohort window is closed on both ends (cohort-math R6),
 * so `cohort.endInclusive` exists to reproduce it — and is translated to a
 * half-open bound HERE (see `cohortWindow`) rather than leaking `$lte` into the
 * read layer.
 */

// ── shapes ──────────────────────────────────────────────────────────────────

export interface FunnelStageSpec {
  /** the lifetime rollup family whose doc marks this stage — `firstAt` IS the timestamp */
  as: string;
  /** stable identifier in the response. Default: `as` */
  key?: string;
  label?: string;
  description?: string;
}

export interface FunnelCohortWindow extends TimeRange {
  /**
   * Include `to` itself. Default FALSE — the package is half-open everywhere and
   * that is the correct convention. maxed's funnel is closed on both ends
   * (cohort-math R6), so a host migrating off it sets this to keep its numbers.
   */
  endInclusive?: boolean;
}

export interface FunnelParams {
  /** ordered stages. A stage may be reached without its predecessor — see LITERAL below. */
  stages: readonly FunnelStageSpec[];
  /** the milestone that assigns cohort membership and anchors time-to-step. Default: `stages[0].as` */
  anchor?: string;
  /** the cohort window, applied to the ANCHOR family's `firstAt` */
  cohort: FunnelCohortWindow;
  /** exit families — counted, never staged (cohort-math §1.4) */
  exits?: readonly FunnelStageSpec[];
  /** restrict the cohort to one subject type ('account') */
  subjectType?: string;
  /** also slice the cohort by anchor date. UTC, Monday-start weeks — `truncate()` */
  interval?: 'day' | 'week' | 'month';
  /** cohort size cap. Clamped to `limits.funnel`; hitting it sets `truncated`. */
  limit?: number;
}

export interface FunnelStageResult {
  /** 1-based position in `stages` */
  order: number;
  key: string;
  as: string;
  label: string;
  description?: string;
  /** subjects with this stage present. NOT monotonic — see LITERAL below. */
  subjects: number;
  /** 0–100, unrounded. null when stage 1's count is 0. */
  pctOfFirst: number | null;
  /** 0–100, unrounded. null on stage 1 and whenever the previous count is 0 — never 0, never Infinity. */
  pctOfPrevious: number | null;
  /** fractional days, unrounded. null on an empty sample. */
  medianDaysFromAnchor: number | null;
  /** fractional days, unrounded. null on stage 1 and on an empty sample. */
  medianDaysFromPrevious: number | null;
  /** reached the PREVIOUS stage and not this one — drop-off INTO this stage. 0 on stage 1. */
  notReached: number;
  /** reached this stage and not the NEXT — drop-off OUT OF it. null on the terminal stage. */
  stalledAt: number | null;
}

export interface FunnelExitResult {
  key: string;
  as: string;
  label: string;
  subjects: number;
}

export interface FunnelSlice {
  /** the truncated anchor date — UTC bucket start, not a "2026-W31" label */
  at: Date;
  subjects: number;
  stages: FunnelStageResult[];
}

export interface FunnelResult {
  /** cohort size: subjects whose ANCHOR firstAt fell in the window */
  cohortSubjects: number;
  /** |{ s : stage 1 present }| — the `pctOfFirst` denominator. Equals cohortSubjects when the anchor IS stage 1. */
  first: number;
  stages: FunnelStageResult[];
  exits: FunnelExitResult[];
  /** present only when `interval` was asked for; ascending by `at` */
  slices: FunnelSlice[] | null;
  /** the cohort read hit its cap — every number below is an UNDERCOUNT (traps §18: no silent caps) */
  truncated: boolean;
  cohort: { from: Date; to: Date; endInclusive: boolean; anchor: string };
  dataSource: 'rollups';
}

/** one subject's assembled milestone index — the input `summarizeStages` reasons over */
export interface CohortSubject {
  ref: string;
  /** the anchor milestone's firstAt. Never null via `runFunnel`; the branch exists per cohort-math R9. */
  anchorAt: Date | null;
  /** stage key → first occurrence */
  stages: Record<string, Date>;
  /** exit key → first occurrence */
  exits: Record<string, Date>;
}

interface ResolvedStage {
  order: number;
  key: string;
  as: string;
  label: string;
  description?: string;
}

// ── pure math ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Mean of the two middles on even counts — NOT the lower middle (cohort-math R1).
 * Empty set is null, never 0: "nobody got here" and "everybody got here
 * instantly" are different facts and a chart must be able to tell them apart.
 * No rounding anywhere; the caller formats.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The stage table. Pure — same input, same output, no Mongo — so the equivalence
 * test can pin it cell by cell.
 *
 * LITERAL, never backfilled (cohort-math R4): a subject counts at stage N only
 * if a stage-N doc exists for it. Reaching N+1 does not imply N. So stage counts
 * are NOT required to be non-increasing, `pctOfPrevious` may exceed 100%, and a
 * skipping subject contributes to `subjects` for the later stage but to nothing
 * else on that row — not `prevReached`, not the fromPrevious sample, not
 * `notReached`. That is a data fact, not a bug, and smoothing it would invent
 * subjects that never existed.
 */
export function summarizeStages(
  subjects: readonly CohortSubject[],
  stages: readonly ResolvedStage[],
): FunnelStageResult[] {
  const firstKey = stages[0]?.key;
  const first = firstKey ? subjects.filter((s) => s.stages[firstKey]).length : 0;

  return stages.map((st, i) => {
    const prev = i > 0 ? stages[i - 1]! : null;
    const next = i < stages.length - 1 ? stages[i + 1]! : null;

    const reached: CohortSubject[] = [];
    const fromAnchor: number[] = [];
    for (const s of subjects) {
      const at = s.stages[st.key];
      if (!at) continue;
      reached.push(s);
      // a subject with no anchor is excluded from the SAMPLE but still counted
      // in `subjects` (cohort-math R9) — unreachable through runFunnel, kept
      // because summarizeStages is exported and can be fed from elsewhere
      if (s.anchorAt) fromAnchor.push((at.getTime() - s.anchorAt.getTime()) / DAY_MS);
    }

    let prevReached = 0;
    let notReached = 0;
    const fromPrevious: number[] = [];
    if (prev) {
      for (const s of subjects) {
        const p = s.stages[prev.key];
        if (!p) continue;
        prevReached += 1;
        const cur = s.stages[st.key];
        if (cur) fromPrevious.push((cur.getTime() - p.getTime()) / DAY_MS);
        else notReached += 1;
      }
    }

    // `pctOfPrevious` divides ALL subjects that reached this stage by only those
    // that reached the previous one — two independent counts, not a conversion
    // rate (cohort-math H4). Ported deliberately: changing it would silently
    // disagree with the funnel a migrating host is reading today.
    return {
      order: st.order,
      key: st.key,
      as: st.as,
      label: st.label,
      ...(st.description ? { description: st.description } : {}),
      subjects: reached.length,
      pctOfFirst: first > 0 ? (reached.length / first) * 100 : null,
      pctOfPrevious: prev ? (prevReached > 0 ? (reached.length / prevReached) * 100 : null) : null,
      medianDaysFromAnchor: median(fromAnchor),
      medianDaysFromPrevious: prev ? median(fromPrevious) : null,
      notReached,
      // the divergence: maxed's `!next` clause makes every subject that reached
      // the terminal stage "stuck" there. null says "undefined", which is true.
      stalledAt: next ? subjects.filter((s) => s.stages[st.key] && !s.stages[next.key]).length : null,
    };
  });
}

// ── registry lookup ─────────────────────────────────────────────────────────

/** the first declaration of a rollup family — validateRegistry pins the shape, so it speaks for all */
export function findFamily(registry: Registry, as: string): { name: string; spec: RollupSpec } | null {
  for (const [name, s] of Object.entries(registry)) {
    for (const r of s.rollups ?? []) {
      if ((r.as ?? name) === as) return { name, spec: r };
    }
  }
  return null;
}

/**
 * A milestone family is a LIFETIME rollup keyed on exactly one subject dim. Any
 * other shape cannot answer "when did this subject first reach this stage" —
 * a bucketed family has one doc per period, and an extra dim has one doc per
 * (subject, value). Both would produce a plausible wrong number, so this throws
 * instead. A registry mistake must fail loudly; that is what this package is for.
 */
export function requireMilestoneFamily(registry: Registry, as: string, primitive: string): RollupSpec {
  const found = findFamily(registry, as);
  if (!found) {
    throw new Error(
      `telemetry: ${primitive} — no rollup family "${as}" is declared. Add a \`rollups: [{ as: '${as}', ` +
        `by: ['subject'], subjects: [...] }]\` block to the event that marks it.`,
    );
  }
  const { name, spec } = found;
  const shape = `by: [${spec.by.map((d) => `'${d}'`).join(', ')}]${spec.bucket ? `, bucket: '${spec.bucket}'` : ''}`;
  if (spec.bucket) {
    throw new Error(
      `telemetry: ${primitive} — rollup family "${as}" (declared on "${name}") is BUCKETED (${shape}). ` +
        `A milestone needs a lifetime family so \`firstAt\` is the one moment the subject reached it; ` +
        `a bucketed family has one doc per period and would count the same subject repeatedly.`,
    );
  }
  if (spec.by.length !== 1 || spec.by[0] !== 'subject') {
    throw new Error(
      `telemetry: ${primitive} — rollup family "${as}" (declared on "${name}") is keyed ${shape}, ` +
        `but a milestone must be keyed by exactly one subject dim (\`by: ['subject']\`). ` +
        `Extra dims split one subject across several docs, which would over-count every stage.`,
    );
  }
  return spec;
}

// ── the read ────────────────────────────────────────────────────────────────

export interface FunnelCtx {
  RollupModel: Model<any>;
  registry: Registry;
  /** cohort size cap — config, per traps §18 */
  cohortCap: number;
  /**
   * The tenancy term for a scope, INJECTED. This file computes cohort math; it
   * does not get to decide who may read across tenants, and hard-wiring
   * `{ tenantId }` here would put that policy in two places. query.ts owns it.
   */
  scopeMatch: (scope: string) => Record<string, unknown>;
}

/**
 * Closed → half-open, exactly. BSON dates are integer milliseconds, so
 * `{$lte: e}` and `{$lt: e + 1ms}` select identically — which is why
 * `endInclusive` can be honoured without a `$lte` ever reaching the query layer.
 */
function cohortWindow(c: FunnelCohortWindow): { from: Date; to: Date; endInclusive: boolean } {
  const endInclusive = c.endInclusive === true;
  return { from: c.from, to: endInclusive ? new Date(c.to.getTime() + 1) : c.to, endInclusive };
}

export async function runFunnel(
  ctx: FunnelCtx,
  scope: string,
  params: FunnelParams,
): Promise<FunnelResult> {
  if (!params.stages?.length) throw new Error('telemetry: funnel() needs at least one stage');

  const stages: ResolvedStage[] = params.stages.map((s, i) => ({
    order: i + 1,
    key: s.key ?? s.as,
    as: s.as,
    label: s.label ?? s.key ?? s.as,
    ...(s.description ? { description: s.description } : {}),
  }));
  const exits: ResolvedStage[] = (params.exits ?? []).map((s, i) => ({
    order: i + 1,
    key: s.key ?? s.as,
    as: s.as,
    label: s.label ?? s.key ?? s.as,
  }));

  // ANCHOR, not first-event (cohort-math R5): a subject whose earliest record is
  // a page view three weeks before signup is still assigned by the signup. A
  // subject with no anchor doc in the window is absent from the cohort entirely
  // — every other milestone it has is invisible, counted at no stage.
  const anchor = params.anchor ?? stages[0]!.as;

  requireMilestoneFamily(ctx.registry, anchor, 'funnel()');
  for (const s of [...stages, ...exits]) requireMilestoneFamily(ctx.registry, s.as, 'funnel()');

  const { from, to, endInclusive } = cohortWindow(params.cohort);
  const cap = Math.min(Math.max(1, params.limit ?? ctx.cohortCap), ctx.cohortCap);

  const cohortMatch: Record<string, unknown> = {
    ...ctx.scopeMatch(scope),
    as: anchor,
    // AMBIGUOUS-2 (cohort-math): maxed's cohort read overwrites per row with no
    // ordering, so its `signupAt` is whichever row Mongo returned last —
    // nondeterministic. Unreachable here by construction: the rollup's `firstAt`
    // is a `$min` maintained on write, so the anchor timestamp is the EARLIEST
    // occurrence, always, matching the tie-break rule maxed uses everywhere else
    // (R12). We take min(at) and the storage enforces it.
    firstAt: { $gte: from, $lt: to },
  };
  if (params.subjectType) cohortMatch.subjectType = params.subjectType;

  // limit+1 so "hit the cap" is a fact, not an inference off an exact match
  const cohortRows = await ctx.RollupModel.find(cohortMatch)
    .sort({ firstAt: 1 })
    .limit(cap + 1)
    .lean();
  const truncated = cohortRows.length > cap;
  if (truncated) cohortRows.pop();

  // A subject ref is unique only WITHIN a tenant, so the index is keyed by
  // (tenant, ref). Under a cross-tenant scope two tenants' 'account:a1' are two
  // subjects; keying on the ref alone would braid their milestones into one
  // funnel and report a conversion that never happened.
  const keyOf = (r: any) => `${r.tenantId ?? ''}|${r.dims?.[0]}`;
  const index = new Map<string, CohortSubject>();
  const refs = new Set<string>();
  const tenants = new Set<string>();
  for (const r of cohortRows as any[]) {
    const ref = r.dims?.[0];
    if (!ref) continue;
    refs.add(ref);
    tenants.add(String(r.tenantId ?? ''));
    index.set(keyOf(r), { ref, anchorAt: r.firstAt, stages: {}, exits: {} });
  }

  if (refs.size) {
    const byAs = new Map<string, ResolvedStage[]>();
    for (const s of [...stages, ...exits]) {
      const list = byAs.get(s.as) ?? [];
      list.push(s);
      byAs.set(s.as, list);
    }
    // One read for every stage of every cohort member — the multi-subject gap
    // (cohort-math G3). N single-subject reads or an uncapped family scan were
    // the alternatives; the second truncates a large cohort silently.
    const stageRows = await ctx.RollupModel.find({
      ...ctx.scopeMatch(scope),
      as: { $in: [...byAs.keys()] },
      dims: { $in: [...refs] },
      // AMBIGUOUS-1 (cohort-math): maxed collects stages with `at >= cohortStart`
      // and no upper bound. We keep the lower bound — reading (a), as-written.
      // Reasons: (1) it is what maxed does, and an equivalence test against a
      // table computed under the other reading would prove nothing; (2) over
      // rollup storage the predicate reads "first reached no earlier than the
      // cohort opened", which is the only reading under which a cohort's funnel
      // is a function of its own window — drop the bound and a backfill dated
      // before the window silently adds stages to a report already published.
      // No UPPER bound, deliberately: a conversion landing months after the
      // window still belongs to its cohort (R7).
      firstAt: { $gte: from },
    })
      // The exact worst case of the query as written: a lifetime by:['subject']
      // family holds at most one doc per (tenant, subject), and `dims` matches
      // refs across every tenant in the cohort. Under a single-tenant scope that
      // is index.size × families. The bound cannot bite; it is here because §18
      // says every read carries its limit, not because we expect to reach it.
      .limit(refs.size * tenants.size * byAs.size + 1)
      .lean();

    for (const r of stageRows as any[]) {
      const subject = index.get(keyOf(r));
      if (!subject) continue;
      for (const s of byAs.get(r.as) ?? []) {
        const bag = exits.includes(s) ? subject.exits : subject.stages;
        const prevAt = bag[s.key];
        // earliest wins (R12) — belt and braces, `firstAt` is already a $min
        if (!prevAt || r.firstAt < prevAt) bag[s.key] = r.firstAt;
      }
    }
  }

  const subjects = [...index.values()];
  const summary = summarizeStages(subjects, stages);

  let slices: FunnelSlice[] | null = null;
  if (params.interval) {
    const groups = new Map<number, CohortSubject[]>();
    for (const s of subjects) {
      // subjects with no anchor date are dropped from the slices, matching
      // maxed (adminTelemetry.ts:660-666); unreachable via this path
      if (!s.anchorAt) continue;
      const at = truncate(s.anchorAt, params.interval)!;
      const k = at.getTime();
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    slices = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, members]) => ({
        at: new Date(k),
        subjects: members.length,
        stages: summarizeStages(members, stages),
      }));
  }

  return {
    cohortSubjects: subjects.length,
    first: stages[0] ? subjects.filter((s) => s.stages[stages[0]!.key]).length : 0,
    stages: summary,
    exits: exits.map((e) => ({
      key: e.key,
      as: e.as,
      label: e.label,
      subjects: subjects.filter((s) => s.exits[e.key]).length,
    })),
    slices,
    truncated,
    cohort: { from: params.cohort.from, to: params.cohort.to, endInclusive, anchor },
    dataSource: 'rollups' as const,
  };
}
