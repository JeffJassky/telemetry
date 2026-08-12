import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import {
  createDashboard, createQueries, defineRegistry, median, summarizeStages,
} from '../src/server/index.js';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * B3(b) — the equivalence test.
 *
 * Nothing else proves the migrated funnel agrees with the one it replaces. The
 * fixture is cohort-math.md §3.1 verbatim — 12 subjects, the boundary cases, the
 * skipper, the admin rows, the backdated milestone — seeded through emit() so
 * the rollups under test are the ones the write path actually produces. The
 * expected table is §3.2, hand-computed from maxed's source, asserted cell by
 * cell.
 *
 * FIELD NAMES. maxed's names are host-specific or ambiguous; the package's are
 * general. The mapping is total and the numbers are identical:
 *
 *   accounts → subjects · medianDaysFromSignup → medianDaysFromAnchor
 *   stuckAccounts → notReached · accountsStuckAt(k) → stalledAt
 *
 * MECHANISM. maxed excludes admins with a read-time denylist (`actorRole: {$ne:
 * 'admin'}` on both funnel queries). The package excludes them with the
 * write-time `RollupSpec.actors` ALLOWLIST, so an admin-actor record never moves
 * the aggregate in the first place. Same answer on this fixture — a09's admin
 * `saw_first_data` is invisible either way, and a10's admin signup removes the
 * account from the cohort entirely either way — by two different mechanisms, and
 * the difference was a deliberate design decision: emit-time aggregation cannot
 * be query-filtered after the fact, so the policy has to be declared before the
 * write. The trade is that flipping it needs a rollup rebuild from raw (maxed
 * can change it per query), and that a NEW actor type is excluded here and
 * included there (cohort-math G2). The raw rows are untouched in both.
 */

const CUSTOMERS = ['user', 'system'] as const;

/** the maxed stage vocabulary as a host registry — one lifetime family per milestone */
const milestone = (as: string, description: string) => ({
  kind: 'event' as const,
  origin: 'any' as const,
  subjects: ['account'],
  attrs: z.object({ note: z.string().optional() }),
  rollups: [{ as, by: ['subject'] as const, subjects: ['account'], actors: [...CUSTOMERS] }],
  description,
});

const funnelRegistry = defineRegistry({
  'milestone.signed_up': milestone('signed_up', 'Account created'),
  'milestone.wizard_started': milestone('wizard_started', 'Opened the setup wizard'),
  'milestone.topic_finalized': milestone('topic_finalized', 'Chose what to measure'),
  'milestone.saw_first_data': milestone('saw_first_data', 'Real numbers on screen'),
  'milestone.plans_viewed': milestone('plans_viewed', 'Looked at pricing'),
  'milestone.plan_selected': milestone('plan_selected', 'Picked a plan'),
  'milestone.converted': milestone('converted', 'Paid subscription active'),
  'lifecycle.trial_expired': milestone('trial_expired', 'Trial expired'),
  'billing.subscription_deleted': milestone('subscription_deleted', 'Subscription canceled'),
  // the activity family S6 counts — bucketed, one doc per (subject, day)
  'app.opened': {
    kind: 'event' as const,
    // 'any', not 'client': a client-origin spec makes `client` context mandatory
    // and this fixture is about buckets, not about wire provenance
    origin: 'any' as const,
    subjects: ['account'],
    rollups: [
      { as: 'activity', by: ['subject'] as const, subjects: ['account'], actors: [...CUSTOMERS], bucket: 'day' as const },
      // a deliberately wrong shape, so the guard rails have something to reject
      { as: 'opens_by_day', by: ['field:tenantId'] as const, bucket: 'day' as const },
    ],
    description: 'Session start — the DAU/MAU signal',
  },
});

const STAGES = [
  'signed_up', 'wizard_started', 'topic_finalized', 'saw_first_data',
  'plans_viewed', 'plan_selected', 'converted',
] as const;

const COHORT_FROM = at('2026-07-01T00:00:00.000Z');
const COHORT_TO = at('2026-07-31T23:59:59.999Z');

/** cohort-math §3.1, row for row. `actor` is what the row carries; ✗ rows are seeded too. */
const FIXTURE: Array<[subject: string, step: string, iso: string, actor: string]> = [
  ['a01', 'signed_up', '2026-07-01T00:00:00.000Z', 'user:u01'],       // exactly cohortStart → in
  ['a01', 'wizard_started', '2026-07-02T00:00:00.000Z', 'user:u01'],
  ['a01', 'topic_finalized', '2026-07-04T00:00:00.000Z', 'user:u01'],
  ['a01', 'saw_first_data', '2026-07-05T00:00:00.000Z', 'user:u01'],
  ['a02', 'signed_up', '2026-07-31T23:59:59.999Z', 'user:u02'],       // exactly cohortEnd → in
  ['a02', 'wizard_started', '2026-08-02T23:59:59.999Z', 'user:u02'],  // after the window, still counts
  ['a03', 'signed_up', '2026-06-30T23:59:59.999Z', 'user:u03'],       // 1ms early → account excluded
  ['a03', 'wizard_started', '2026-07-03T00:00:00.000Z', 'user:u03'],
  ['a04', 'signed_up', '2026-08-01T00:00:00.000Z', 'user:u04'],       // 1ms late → account excluded
  ['a05', 'signed_up', '2026-07-05T12:00:00.000Z', 'user:u05'],
  ['a05', 'wizard_started', '2026-07-06T12:00:00.000Z', 'user:u05'],
  ['a05', 'topic_finalized', '2026-07-09T12:00:00.000Z', 'user:u05'],
  ['a05', 'saw_first_data', '2026-07-10T12:00:00.000Z', 'user:u05'],
  ['a06', 'signed_up', '2026-07-06T00:00:00.000Z', 'user:u06'],
  ['a06', 'wizard_started', '2026-07-08T00:00:00.000Z', 'user:u06'],
  ['a06', 'trial_expired', '2026-07-20T00:00:00.000Z', 'system:cron'],
  ['a06', 'trial_expired', '2026-07-21T00:00:00.000Z', 'system:cron'], // repeat — first wins
  ['a07', 'signed_up', '2026-07-07T00:00:00.000Z', 'user:u07'],
  ['a07', 'wizard_started', '2026-07-10T00:00:00.000Z', 'user:u07'],
  ['a07', 'topic_finalized', '2026-07-12T00:00:00.000Z', 'user:u07'],
  ['a08', 'signed_up', '2026-07-08T00:00:00.000Z', 'user:u08'],        // never leaves stage 1
  ['a09', 'signed_up', '2026-07-09T00:00:00.000Z', 'user:u09'],
  ['a09', 'wizard_started', '2026-07-11T00:00:00.000Z', 'user:u09'],
  ['a09', 'saw_first_data', '2026-07-12T00:00:00.000Z', 'admin:ops'],  // admin → stage dropped
  ['a10', 'signed_up', '2026-07-10T00:00:00.000Z', 'admin:ops'],       // admin signup → no cohort doc
  ['a10', 'wizard_started', '2026-07-11T00:00:00.000Z', 'user:u10'],
  ['a11', 'signed_up', '2026-07-11T00:00:00.000Z', 'user:u11'],        // the skipper
  ['a11', 'wizard_started', '2026-07-13T00:00:00.000Z', 'user:u11'],
  ['a11', 'topic_finalized', '2026-07-14T00:00:00.000Z', 'user:u11'],
  ['a11', 'saw_first_data', '2026-07-15T00:00:00.000Z', 'user:u11'],
  ['a11', 'plan_selected', '2026-07-20T00:00:00.000Z', 'user:u11'],    // skips plans_viewed
  ['a11', 'converted', '2026-08-05T00:00:00.000Z', 'system:billing'],  // after the window, counts
  ['a12', 'signed_up', '2026-07-12T00:00:00.000Z', 'user:u12'],
  ['a12', 'wizard_started', '2026-06-25T00:00:00.000Z', 'user:u12'],   // before cohortStart → dropped
];

const EVENT_FOR: Record<string, string> = {
  trial_expired: 'lifecycle.trial_expired',
  subscription_deleted: 'billing.subscription_deleted',
};

async function seed(t: ReturnType<typeof buildTelemetry>) {
  await t.syncIndexes();
  for (const [subject, step, iso, actor] of FIXTURE) {
    await t.emit(EVENT_FOR[step] ?? (`milestone.${step}` as any), {
      tenantId: 'tn',
      subjects: [{ type: 'account', id: subject }],
      actor: actor as `${string}:${string}`,
      occurredAt: at(iso),
    });
  }
  // a second tenant running the identical fixture — every number below must be
  // unmoved by it, which is the only proof the cohort read is scoped
  await t.emit('milestone.signed_up', {
    tenantId: 'other',
    subjects: [{ type: 'account', id: 'a01' }],
    actor: 'user:x',
    occurredAt: at('2026-07-03T00:00:00.000Z'),
  });
  await t.flush();
}

function queries(t: ReturnType<typeof buildTelemetry>) {
  return createQueries({
    TelemetryModel: t.models.telemetry,
    RollupModel: t.models.rollups,
    registry: t.registry,
  });
}

/**
 * The cohort window, in maxed's convention. cohort-math R6: CLOSED on both ends.
 * The package is half-open everywhere and stays that way — `endInclusive` is the
 * explicit opt-in that makes a02's signup at exactly `cohortEnd` a member, which
 * is what maxed does and what this test is comparing against.
 */
const COHORT = { from: COHORT_FROM, to: COHORT_TO, endInclusive: true };

const runFunnel = (t: ReturnType<typeof buildTelemetry>, extra: Record<string, unknown> = {}) =>
  queries(t).funnel('tn', {
    stages: STAGES.map((as) => ({ as })),
    exits: [{ as: 'trial_expired' }, { as: 'subscription_deleted' }],
    cohort: COHORT,
    subjectType: 'account',
    ...extra,
  } as any);

/** percentages are exact rationals × 100 — compare with tolerance, not equality on a decimal */
const pct = (n: number, d: number) => (n / d) * 100;

describe('funnel — equivalence with the maxed cohort math', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('assembles the cohort exactly: boundaries in, an admin signup out, a pre-window signup out', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const f = await runFunnel(t);

    // §3.1: a01 a02 a05 a06 a07 a08 a09 a11 a12 — NOT a03 (1ms early), a04 (1ms
    // late), a10 (admin signup). The other tenant's a01 is not here either.
    expect(f.cohortSubjects).toBe(9);
    expect(f.first).toBe(9);
    expect(f.truncated).toBe(false);
    expect(f.cohort.endInclusive).toBe(true);
    expect(f.dataSource).toBe('rollups');
  });

  it('reproduces cohort-math §3.2 cell by cell', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const { stages } = await runFunnel(t);
    const row = (k: string) => stages.find((s) => s.key === k)!;

    expect(stages.map((s) => s.key)).toEqual([...STAGES]); // all seven, always, even the empty one
    expect(stages.map((s) => s.subjects)).toEqual([9, 7, 4, 3, 0, 1, 1]);
    expect(stages.map((s) => s.notReached)).toEqual([0, 2, 3, 1, 3, 0, 0]);

    // ── 1 signed_up ──
    expect(row('signed_up')).toMatchObject({ order: 1, subjects: 9, pctOfFirst: 100 });
    // null by construction on stage 1 — never 0, never Infinity (R3)
    expect(row('signed_up').pctOfPrevious).toBeNull();
    expect(row('signed_up').medianDaysFromPrevious).toBeNull();
    // ...but the anchor median is a real ZERO: the sample is nine zeros, because
    // stage 1's timestamp IS the anchor timestamp. Not null (R8).
    expect(row('signed_up').medianDaysFromAnchor).toBe(0);

    // ── 2 wizard_started ── a12's wizard_started is dated before cohortStart and
    // is therefore invisible: 7, not 8 (R7 / AMBIGUOUS-1, reading (a) — below)
    expect(row('wizard_started').subjects).toBe(7);
    expect(row('wizard_started').pctOfFirst).toBeCloseTo(pct(7, 9), 9);
    expect(row('wizard_started').pctOfPrevious).toBeCloseTo(pct(7, 9), 9);
    expect(row('wizard_started').medianDaysFromAnchor).toBe(2); // [1,1,2,2,2,2,3] odd
    expect(row('wizard_started').medianDaysFromPrevious).toBe(2);

    // ── 3 topic_finalized — THE DISCRIMINATING CELL ──
    // sample [3,3,4,5], n even → (3+4)/2. A lower-middle median returns 3 here,
    // and that is the single number that separates R1 from a plausible wrong
    // implementation. Nothing else in the table catches it.
    expect(row('topic_finalized').medianDaysFromAnchor).toBe(3.5);
    expect(row('topic_finalized').subjects).toBe(4);
    expect(row('topic_finalized').pctOfFirst).toBeCloseTo(pct(4, 9), 9);
    expect(row('topic_finalized').pctOfPrevious).toBeCloseTo(pct(4, 7), 9);
    expect(row('topic_finalized').medianDaysFromPrevious).toBe(2); // [1,2,2,3] → (2+2)/2

    // ── 4 saw_first_data ── a09's is admin-actored and never reached the rollup
    expect(row('saw_first_data')).toMatchObject({
      subjects: 3, pctOfPrevious: 75, medianDaysFromAnchor: 4, medianDaysFromPrevious: 1,
    });
    expect(row('saw_first_data').pctOfFirst).toBeCloseTo(pct(3, 9), 9);

    // ── 5 plans_viewed — THE EMPTY STEP ──
    // zero is a real answer here and null is a real answer there, on the same
    // row: the percentages are genuine zeros (their denominators are non-zero),
    // the medians are null (empty samples, R2).
    expect(row('plans_viewed')).toMatchObject({
      subjects: 0,
      pctOfFirst: 0,          // 0/9 × 100 — a zero, because first > 0
      pctOfPrevious: 0,       // 0/3 × 100 — a zero, because prevReached = 3
      medianDaysFromAnchor: null,
      medianDaysFromPrevious: null,
      notReached: 3,          // a01, a05, a11 reached saw_first_data and stopped
    });

    // ── 6 plan_selected — THE ZERO-PREVIOUS STEP ──
    // subjects = 1 and yet BOTH previous-relative cells are null. a11 skipped
    // plans_viewed, so it counts here and contributes to nothing else on the row
    // (R4). pctOfPrevious is null rather than Infinity (R3); the fromPrevious
    // sample is empty because the loop only visits subjects that have the
    // PREVIOUS stage, and a11 does not.
    expect(row('plan_selected')).toMatchObject({
      subjects: 1,
      pctOfPrevious: null,
      medianDaysFromPrevious: null,
      medianDaysFromAnchor: 9, // 07-20 − 07-11
      notReached: 0,           // nobody had plans_viewed to be lost from
    });
    expect(row('plan_selected').pctOfFirst).toBeCloseTo(pct(1, 9), 9);

    // ── 7 converted ── lands 2026-08-05, five days after cohortEnd, and counts
    expect(row('converted')).toMatchObject({
      subjects: 1, pctOfPrevious: 100, medianDaysFromAnchor: 25, medianDaysFromPrevious: 16,
    });
  });

  it('names the two "stuck" quantities separately and returns null on the terminal stage', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const { stages } = await runFunnel(t);
    const row = (k: string) => stages.find((s) => s.key === k)!;

    // cohort-math §3.4. `stalledAt` is maxed's accountsStuckAt(k): reached k,
    // not k+1. `notReached` is maxed's StageSummary.stuckAccounts: reached k−1,
    // not k. maxed ships BOTH under the word "stuck", which is the trap.
    expect(stages.map((s) => s.stalledAt)).toEqual([2, 3, 1, 3, 0, 0, null]);

    // the relation that holds for every non-terminal stage, asserted rather than
    // assumed — it is what proves the two definitions are the two definitions
    for (let i = 0; i < stages.length - 1; i++) {
      expect(stages[i]!.stalledAt).toBe(stages[i + 1]!.notReached);
    }

    // ── THE DELIBERATE DIVERGENCE ──
    // maxed's accountsStuckAt('converted') returns [a11] — count 1 — because the
    // terminal stage has no successor for `!next` to fail against, so every
    // subject that CONVERTED is reported as stuck at conversion (cohort-math
    // H3). That is the one cell where this package refuses to agree.
    const maxedWouldReport = 1;
    expect(row('converted').stalledAt).not.toBe(maxedWouldReport);
    expect(row('converted').stalledAt).toBeNull();
    // and it is null rather than 0, because 0 would assert that nobody stalled
    // at conversion — a claim about a stage that does not exist
    expect(row('converted').stalledAt).not.toBe(0);
    expect(row('converted').subjects).toBe(1); // the conversion itself is still counted
  });

  it('counts exits by first occurrence, one row per declared exit, zeros included', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const { exits } = await runFunnel(t);

    // §3.3 — a06 fired trial_expired twice; the rollup's $min collapses them on
    // write, so the repeat cannot double-count (R12, structurally rather than
    // by a JS min over rows)
    expect(exits).toEqual([
      { key: 'trial_expired', as: 'trial_expired', label: 'trial_expired', subjects: 1 },
      { key: 'subscription_deleted', as: 'subscription_deleted', label: 'subscription_deleted', subjects: 0 },
    ]);
  });

  it('slices the cohort by anchor week — Monday-start, time-of-day discarded', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const { slices } = await runFunnel(t, { interval: 'week' });
    const s = slices!;

    // §3.5. maxed labels these '2026-W27'/'2026-W28'/'2026-W31'; the package
    // returns the UTC Monday itself. Same grouping — both key off the Monday —
    // and a Date is the more useful label, since it sorts and formats.
    expect(s.map((x) => x.at.toISOString())).toEqual([
      '2026-06-29T00:00:00.000Z', '2026-07-06T00:00:00.000Z', '2026-07-27T00:00:00.000Z',
    ]);
    expect(s.map((x) => x.subjects)).toEqual([2, 6, 1]);

    // a05 signed up on a SUNDAY and lands with a01's Wednesday; a06's Monday
    // starts the next slice. That pair is the Monday-start assertion.
    // a02's 23:59:59.999 collapsing into a plain week is the time-of-day one.
    const w27 = s[0]!, w28 = s[1]!, w31 = s[2]!;
    const cell = (slice: typeof w27, key: string) => slice.stages.find((x) => x.key === key)!;

    // two more even-length medians, on smaller populations
    expect(cell(w27, 'topic_finalized').medianDaysFromAnchor).toBe(3.5); // (3+4)/2
    expect(cell(w27, 'saw_first_data').medianDaysFromAnchor).toBe(4.5);  // (4+5)/2
    expect(cell(w27, 'plan_selected').pctOfPrevious).toBeNull();
    expect(cell(w27, 'converted').pctOfPrevious).toBeNull();

    expect(cell(w28, 'wizard_started').pctOfPrevious).toBeCloseTo(pct(4, 6), 9);
    expect(cell(w28, 'topic_finalized').medianDaysFromAnchor).toBe(4); // [3,5]
    expect(cell(w28, 'plan_selected').pctOfPrevious).toBeNull();
    expect(cell(w28, 'converted').pctOfPrevious).toBe(100);

    // the pair that separates "genuinely zero" from "undefined", on one subject
    expect(cell(w31, 'topic_finalized').pctOfPrevious).toBe(0);    // 0/1
    expect(cell(w31, 'saw_first_data').pctOfPrevious).toBeNull();  // 0/0
  });

  /**
   * AMBIGUOUS-1 (cohort-math): maxed collects stages with `at >= cohortStart`
   * and no upper bound. Whether the lower bound is a semantic rule (a) or an
   * index-shaping accident (b) is not recoverable from the source.
   *
   * READING TAKEN: (a), the as-written behaviour. Two reasons. First, this test
   * is an equivalence test — asserting against a table recomputed under the
   * other reading would prove agreement with nothing. Second, over rollup
   * storage the predicate reads "first reached no earlier than the cohort
   * opened", and that is the only reading under which a cohort's funnel is a
   * function of its own window: drop the bound and a backfill dated before the
   * window silently adds stages to a report that was already published.
   *
   * The package-specific caveat, which maxed does not have: rollups collapse
   * repeats into one doc, so the filter is on the EARLIEST occurrence, not on
   * each row. A subject that reached a stage before the window AND again inside
   * it is dropped here and kept there. Backdated writes are the only way to get
   * there, and the alternative silently inflates published cohorts.
   */
  it('drops a milestone dated before the cohort window, keeps one dated after it', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const { stages } = await runFunnel(t);

    // a12 is IN the cohort (signed up 07-12) but its wizard_started is dated
    // 06-25, before the window — so it counts at stage 1 and nowhere else
    expect(stages[0]!.subjects).toBe(9);
    expect(stages[1]!.subjects).toBe(7); // not 8
    expect(stages[0]!.stalledAt).toBe(2); // a08 (nothing after) and a12 (dropped)

    // the mirror case, and the one maxed asserts explicitly: no UPPER bound.
    // a11's conversion lands 2026-08-05 and a02's wizard_started 2026-08-02,
    // both after cohortEnd, both counted.
    expect(stages[6]!.subjects).toBe(1);
  });

  /**
   * AMBIGUOUS-2 (cohort-math): maxed's cohort read overwrites per row with no
   * ordering and no `.sort()`, so with two in-window signup rows `signupAt` is
   * whichever Mongo returned last — nondeterministic, and the recon says a port
   * should pick min(at) and say so.
   *
   * READING TAKEN: min(at). The package cannot express the other one: `firstAt`
   * is a `$min` maintained by the update pipeline on write, so the anchor is the
   * earliest occurrence by construction — and unlike maxed, a repeat does not
   * even need a unique index to be harmless.
   */
  it('anchors on the EARLIEST occurrence when a milestone repeats', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await t.syncIndexes();
    for (const iso of ['2026-07-20T00:00:00.000Z', '2026-07-04T00:00:00.000Z', '2026-07-11T00:00:00.000Z']) {
      await t.emit('milestone.signed_up', {
        tenantId: 'tn', subjects: [{ type: 'account', id: 'r1' }], actor: 'user:u', occurredAt: at(iso),
      });
    }
    await t.emit('milestone.wizard_started', {
      tenantId: 'tn', subjects: [{ type: 'account', id: 'r1' }], actor: 'user:u',
      occurredAt: at('2026-07-06T00:00:00.000Z'),
    });
    await t.flush();

    const f = await runFunnel(t);
    expect(f.cohortSubjects).toBe(1);
    // 07-06 minus 07-04 = 2. Under "last row wins" the anchor would be 07-11 and
    // this would be −5; under "whichever came back first", 07-20 and −14.
    expect(f.stages[1]!.medianDaysFromAnchor).toBe(2);
  });

  it('is scoped: the other tenant ran the same fixture and moved nothing', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const other = await queries(t).funnel('other', {
      stages: STAGES.map((as) => ({ as })),
      cohort: COHORT,
      subjectType: 'account',
    });
    expect(other.cohortSubjects).toBe(1);
    expect(other.stages[1]!.subjects).toBe(0);
  });

  it('says so when the cohort read hit its cap instead of reporting a short funnel', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const q = createQueries({
      TelemetryModel: t.models.telemetry,
      RollupModel: t.models.rollups,
      registry: t.registry,
      limits: { funnel: 4 },
    });
    const f = await q.funnel('tn', {
      stages: STAGES.map((as) => ({ as })), cohort: COHORT, subjectType: 'account',
    });
    expect(f.cohortSubjects).toBe(4);
    expect(f.truncated).toBe(true); // 9 were available — the number below is an undercount, and says so
  });

  it('refuses a family that cannot mark a milestone, naming the family and the fix', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    const q = queries(t);
    // bucketed: one doc per period, so `firstAt` is not "when they reached it"
    await expect(q.funnel('tn', { stages: [{ as: 'activity' }], cohort: COHORT })).rejects.toThrow(
      /rollup family "activity".*is BUCKETED/s,
    );
    // no subject dim: the docs count occurrences, not subjects
    await expect(q.funnel('tn', { stages: [{ as: 'opens_by_day' }], cohort: COHORT })).rejects.toThrow(
      /rollup family "opens_by_day"/,
    );
    await expect(q.funnel('tn', { stages: [{ as: 'nope' }], cohort: COHORT })).rejects.toThrow(
      /no rollup family "nope" is declared/,
    );
  });
});

describe('median — the R1 contract, without a database', () => {
  it('averages the two middles on even counts and returns null on empty', () => {
    expect(median([3, 3, 4, 5])).toBe(3.5); // NOT 3 — the lower middle is the bug
    expect(median([1, 2])).toBe(1.5);
    expect(median([1, 1, 2, 2, 2, 2, 3])).toBe(2);
    expect(median([])).toBeNull(); // not 0, not undefined
    expect(median([5])).toBe(5);
    // numeric comparator, not lexicographic — [1,2,10] must not sort to [1,10,2]
    expect(median([10, 1, 2])).toBe(2);
    // no rounding, and negatives survive (a stage may precede its predecessor)
    expect(median([-1.5, 0.25])).toBe(-0.625);
  });

  it('summarizeStages keeps a subject with no anchor in the count but out of the sample (R9)', () => {
    // unreachable through funnel(), which always sets the anchor — the branch
    // exists because summarizeStages is exported and can be fed from elsewhere
    const rows = summarizeStages(
      [
        { ref: 'account:a', anchorAt: at('2026-07-01T00:00:00Z'), stages: { s1: at('2026-07-03T00:00:00Z') }, exits: {} },
        { ref: 'account:b', anchorAt: null, stages: { s1: at('2026-07-09T00:00:00Z') }, exits: {} },
      ],
      [{ order: 1, key: 's1', as: 's1', label: 's1' }] as any,
    );
    expect(rows[0]!.subjects).toBe(2);
    expect(rows[0]!.medianDaysFromAnchor).toBe(2); // only a's sample
  });
});

describe('distinctCount — exact DAU/MAU, no sketch', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  const RANGE = { from: at('2026-07-01T00:00:00Z'), to: at('2026-08-01T00:00:00Z') };

  async function seedActivity(t: ReturnType<typeof buildTelemetry>) {
    await t.syncIndexes();
    const open = (id: string, iso: string, actor = 'user:u') =>
      t.emit('app.opened', {
        tenantId: 'tn', subjects: [{ type: 'account', id }], actor: actor as any, occurredAt: at(iso),
      });
    // 07-01: a, b   07-02: a (twice — same doc)   07-03: c
    await open('a', '2026-07-01T01:00:00Z');
    await open('b', '2026-07-01T02:00:00Z');
    await open('a', '2026-07-02T01:00:00Z');
    await open('a', '2026-07-02T23:00:00Z');
    await open('c', '2026-07-03T01:00:00Z');
    await open('z', '2026-07-03T01:00:00Z', 'admin:ops'); // allowlist keeps admins out
    await t.flush();
  }

  it('counts distinct subjects per bucket and over the range — the range total is not the sum', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seedActivity(t);
    const res = await queries(t).distinctCount('tn', { as: 'activity', range: RANGE });

    expect(res.interval).toBe('day');
    expect(res.buckets.map((b) => b.value)).toEqual([2, 1, 1]); // a+b, a, c
    // a appears on two days. Summing the buckets gives 4; the distinct total is
    // 3, and that gap is the entire reason this primitive exists.
    expect(res.buckets.reduce((s, b) => s + b.value, 0)).toBe(4);
    expect(res.distinct).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.dataSource).toBe('rollups');
  });

  it('rolls daily buckets up to a coarser interval without losing exactness', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seedActivity(t);
    const res = await queries(t).distinctCount('tn', { as: 'activity', range: RANGE, interval: 'month' });
    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0]!.value).toBe(3); // MAU — a counted once, not twice
    expect(res.distinct).toBe(3);
  });

  it('throws a fix-shaped error when the family cannot answer the question', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    const q = queries(t);
    // lifetime family: one doc per subject forever, so every period is identical
    expect(() => q.distinctCount('tn', { as: 'signed_up', range: RANGE })).toThrow(/has no `bucket`/);
    // bucketed but keyed on a field, so the docs count occurrences
    expect(() => q.distinctCount('tn', { as: 'opens_by_day', range: RANGE })).toThrow(/no\s+`subject` dim/);
    expect(() => q.distinctCount('tn', { as: 'ghost', range: RANGE })).toThrow(/no rollup family "ghost"/);
  });
});

describe('the cohort primitives over HTTP', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  function buildApp(t: any) {
    const app = express();
    app.use('/telemetry', createDashboard({
      telemetry: t,
      viewerAdapter: { resolveViewer: () => ({ tenantId: 'tn', role: 'member' }) },
    }));
    return app;
  }

  it('serves the funnel as a URL, cohort window and all', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const res = await request(buildApp(t)).get(
      `/telemetry/api/funnel?from=${COHORT_FROM.toISOString()}&to=${COHORT_TO.toISOString()}` +
        `&endInclusive=true&subjectType=account&stages=${STAGES.join(',')}&exits=trial_expired`,
    );
    expect(res.status).toBe(200);
    expect(res.body.cohortSubjects).toBe(9);
    expect(res.body.stages.map((s: any) => s.subjects)).toEqual([9, 7, 4, 3, 0, 1, 1]);
    expect(res.body.stages[2].medianDaysFromAnchor).toBe(3.5);
    expect(res.body.stages[6].stalledAt).toBeNull();
    expect(res.body.exits[0].subjects).toBe(1);
  });

  it('answers 400 with the registry advice rather than 500 when the family is wrong', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await seed(t);
    const app = buildApp(t);
    const bad = await request(app).get(
      `/telemetry/api/funnel?from=2026-07-01&to=2026-08-01&stages=activity`,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/BUCKETED/);

    const missing = await request(app).get('/telemetry/api/funnel?from=2026-07-01&to=2026-08-01');
    expect(missing.status).toBe(400);
  });

  it('serves distinctCount with its bucket series and range total', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await t.syncIndexes();
    await t.emit('app.opened', {
      tenantId: 'tn', subjects: [{ type: 'account', id: 'a' }], occurredAt: at('2026-07-01T01:00:00Z'),
    });
    await t.emit('app.opened', {
      tenantId: 'tn', subjects: [{ type: 'account', id: 'b' }], occurredAt: at('2026-07-01T02:00:00Z'),
    });
    await t.flush();
    const res = await request(buildApp(t)).get(
      '/telemetry/api/distinct?as=activity&from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z',
    );
    expect(res.status).toBe(200);
    expect(res.body.distinct).toBe(2);
    expect(res.body.truncated).toBe(false);
  });
});

describe('rollups() — the two cohort gaps it was missing', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('filters on firstAt when asked, which is what cohort selection needs (G1)', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await t.syncIndexes();
    // one subject, first seen inside the window and last seen outside it — the
    // case where `lastAt` and `firstAt` disagree, and the reason the default
    // (lastAt) cannot express cohort membership
    for (const iso of ['2026-07-05T00:00:00Z', '2026-09-09T00:00:00Z']) {
      await t.emit('milestone.signed_up', {
        tenantId: 'tn', subjects: [{ type: 'account', id: 'a' }], actor: 'user:u', occurredAt: at(iso),
      });
    }
    await t.flush();
    const q = queries(t);
    const july = { from: at('2026-07-01T00:00:00Z'), to: at('2026-08-01T00:00:00Z') };

    expect((await q.rollups('tn', { as: 'signed_up', range: july })).rows).toHaveLength(0);
    expect((await q.rollups('tn', { as: 'signed_up', range: july, on: 'firstAt' })).rows).toHaveLength(1);
  });

  it('reads many subjects in one query and reports truncation instead of hiding it (G3)', async () => {
    const t = buildTelemetry({ registry: funnelRegistry });
    await t.syncIndexes();
    for (const id of ['a', 'b', 'c']) {
      await t.emit('milestone.signed_up', {
        tenantId: 'tn', subjects: [{ type: 'account', id }], actor: 'user:u',
        occurredAt: at('2026-07-05T00:00:00Z'),
      });
    }
    await t.flush();
    const q = queries(t);

    const one = await q.rollups('tn', { as: 'signed_up', dims: 'account:a' });
    expect(one.rows).toHaveLength(1);
    expect(one.truncated).toBe(false);

    const many = await q.rollups('tn', { as: 'signed_up', dims: ['account:a', 'account:c'] });
    expect(many.rows).toHaveLength(2); // one query, not two
    expect(many.truncated).toBe(false);

    const capped = await q.rollups('tn', { as: 'signed_up', limit: 2 });
    expect(capped.rows).toHaveLength(2);
    expect(capped.truncated).toBe(true); // three exist — the answer says it is short
  });
});
