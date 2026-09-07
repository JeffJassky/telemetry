import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRegistry, type SubjectLinker } from '../src/server/index.js';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * `t.relink()` — the backfill for write-time subject linking (0.6.0). Suite
 * names state the failure, per standards/testing.md.
 *
 * The shape under test is the one a host actually walks into. Linking runs at
 * WRITE time, so the day a `subjectLinker` is configured splits the collection
 * in two: records after it carry `user:u_1` on the row and in every
 * `subjects:['user']` family, and records before it carry `machine:m1` and
 * nothing else — so the family has no member for any of them and a funnel
 * anchored on `user` reads zero for every stage they feed. Nothing at read time
 * fixes that, because the aggregate is already written.
 *
 * So the assertions here are on the ROLLUP DOCUMENT, not just the row, and the
 * one that matters most is the double run: `recordRollup` `$add`s 1 per call,
 * and a replay that happens twice inflates a historical `count` that no reader
 * can tell from a real one.
 */

const relinkRegistry = () =>
  defineRegistry({
    // Declares only `machine` — the shape a real host is forced into, because
    // declaring `user` would make it REQUIRED and quarantine every record from
    // a machine nobody has activated yet (see the 0.5.0 suite).
    'import.completed': {
      kind: 'event',
      origin: 'any',
      subjects: ['machine'],
      rollups: [
        // the family the backlog is missing from: keyed on the LINKED subject
        { by: ['subject'], subjects: ['user'] },
        // …and one the record's ORIGINAL subject already satisfied. Relinking
        // must not touch it, or every machine's lifetime count doubles.
        { as: 'by_machine', by: ['subject'], subjects: ['machine'] },
        // …and one that does not group by subject at all. A new subject cannot
        // give it a new group, so a replay here is a straight double.
        { as: 'imports_daily', by: ['field:tenantId'], bucket: 'day' },
      ],
      description: 'A desktop import finished — the stage the user funnel could not see',
    },
    'export.completed': {
      kind: 'event',
      origin: 'any',
      subjects: ['machine'],
      rollups: [{ as: 'exports', by: ['subject'], subjects: ['user'] }],
      description: 'A second name, so `names` has something to exclude',
    },
    // A different KIND, on purpose. Every kind is a discriminator on one
    // collection, so one cursor has to reach all five — a relink that swept
    // only `event` would leave money unattributed.
    'billing.desktop_minutes': {
      kind: 'usage',
      origin: 'server',
      subjects: ['machine'],
      metrics: z.object({ cost_usd: z.number() }),
      rollups: [{ as: 'desktop_spend', by: ['subject'], subjects: ['user'], sum: ['cost_usd'] }],
      description: 'Money from a machine nobody had resolved to an account yet',
    },
  });

type Ref = { type: string; id: string; role?: string };

/** the machine → account map a real host would answer from cache */
const resolveOwner: SubjectLinker['link'] = (subjects) => {
  const machine = subjects.find((s) => s.type === 'machine');
  return machine && machine.id !== 'unmapped' ? [{ type: 'user', id: `u_${machine.id}` }] : [];
};

/**
 * One instance, one collection, and a linker that can be switched ON — which is
 * exactly the adoption story. Records emitted while it is off go to disk
 * carrying only `machine:<id>`, byte for byte what an instance with no
 * `subjectLinker` at all would have written; flipping it on is the Tuesday the
 * host configured the hook, and everything already on disk is the backlog.
 */
function build(over: Record<string, unknown> = {}) {
  const state = { on: false, impl: resolveOwner, calls: 0 };
  const hook: SubjectLinker = {
    link: (subjects, ctx) => {
      state.calls++;
      return state.on ? state.impl(subjects, ctx) : [];
    },
  };
  const t = buildTelemetry({ registry: relinkRegistry(), subjectLinker: hook, ...over });
  return { t, state };
}

const machineOnly = (id = 'm1', when = '2026-07-01T00:00:00Z') => ({
  tenantId: 'tn',
  subjects: [{ type: 'machine', id }],
  occurredAt: at(when),
});

const rollupsOf = (t: ReturnType<typeof build>['t']) =>
  t.models.rollups.find({}).sort({ _id: 1 }).lean() as unknown as Promise<any[]>;

describe('relink — the backlog a write-time linker cannot reach', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('a record already on disk with only a machine ref gains the user AND a user-keyed rollup document — a read-time join can never do the second half', async () => {
    const { t, state } = build();

    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    // the backlog, before anything is done about it: no user anywhere
    const before = await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(before.subjectKeys).toEqual(['machine:m1']);
    expect(await t.models.rollups.countDocuments({ as: 'import.completed' })).toBe(0);

    state.on = true;
    const r = await t.relink({ dryRun: false });

    expect(r).toEqual({
      examined: 1, linked: 1, subjects: 1, rollups: 1, misses: 0, errors: 0, skipped: 0,
    });

    const row = await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(row.subjects.map((s: Ref) => `${s.type}:${s.id}`)).toEqual(['machine:m1', 'user:u_m1']);
    // derived alongside the merge, or the row relinks and still aggregates to
    // nothing — the fan-out reads subjectKeys and only subjectKeys
    expect(row.subjectKeys).toEqual(['machine:m1', 'user:u_m1']);

    const roll = await t.models.rollups.findOne({ as: 'import.completed' }).lean() as any;
    expect(roll._id).toBe('tn|import.completed|user:u_m1|');
    expect(roll.dims).toEqual(['user:u_m1']);
    expect(roll.subjectType).toBe('user');
    expect(roll.count).toBe(1);
    // the aggregate is dated by the record, not by the backfill
    expect(roll.firstAt).toEqual(at('2026-07-01T00:00:00Z'));
  });

  it('running it a second time changes NOTHING — a replayed rollup is a historical count nobody can tell from a real one', async () => {
    const { t, state } = build();
    for (const id of ['m1', 'm2', 'm3']) await t.emit('import.completed', machineOnly(id));
    await t.flush();

    state.on = true;
    const first = await t.relink({ dryRun: false });
    expect(first).toMatchObject({ examined: 3, linked: 3, subjects: 3, rollups: 3 });

    const rowsAfterFirst = await t.models.telemetry.find({}).sort({ _id: 1 }).lean();
    const rollsAfterFirst = await rollupsOf(t);
    expect(rollsAfterFirst.filter((d) => d.as === 'import.completed').map((d) => d.count))
      .toEqual([1, 1, 1]);

    // The guard is the MERGE, not a watermark: the row now carries the linked
    // ref, so the linker's answer dedupes to nothing, so nothing is new, so
    // nothing is written and nothing is replayed.
    const second = await t.relink({ dryRun: false });
    expect(second).toEqual({
      examined: 3, linked: 0, subjects: 0, rollups: 0, misses: 0, errors: 0, skipped: 0,
    });

    expect(await t.models.telemetry.find({}).sort({ _id: 1 }).lean()).toEqual(rowsAfterFirst);
    expect(await rollupsOf(t)).toEqual(rollsAfterFirst);
  });

  it('the default call writes NOTHING — this rewrites historical aggregates, so the short call has to be the safe one', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    const rowBefore = await t.models.telemetry.find({}).lean();
    const rollsBefore = await rollupsOf(t);

    state.on = true;
    const dry = await t.relink(); // no options at all — dryRun defaults to TRUE
    // it reports exactly what the real run would do, including the rollup count
    expect(dry).toEqual({
      examined: 1, linked: 1, subjects: 1, rollups: 1, misses: 0, errors: 0, skipped: 0,
    });

    expect(await t.models.telemetry.find({}).lean()).toEqual(rowBefore);
    expect(await rollupsOf(t)).toEqual(rollsBefore);

    // …and the real run afterwards still does the whole job, so the dry run
    // consumed nothing
    expect(await t.relink({ dryRun: false })).toMatchObject({ linked: 1, rollups: 1 });
    const roll = await t.models.rollups.findOne({ as: 'import.completed' }).lean() as any;
    expect(roll.count).toBe(1);
  });

  it('a family the record\'s ORIGINAL subjects already satisfied is not incremented — replaying it would double every machine\'s lifetime count', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    const machineRoll = await t.models.rollups.findOne({ as: 'by_machine' }).lean() as any;
    expect(machineRoll.count).toBe(1);
    const dailyBefore = await t.models.rollups.findOne({ as: 'imports_daily' }).lean() as any;
    expect(dailyBefore.count).toBe(1);

    state.on = true;
    const r = await t.relink({ dryRun: false });
    // exactly ONE rollup document written, out of three families on this event
    expect(r.rollups).toBe(1);

    // `by_machine` fans out on subject but only admits `machine`, and the new
    // ref is a `user` — so the fan-out is empty and the family is never touched
    expect((await t.models.rollups.findOne({ as: 'by_machine' }).lean() as any).count).toBe(1);
    // `imports_daily` does not group by subject at all: a new subject cannot
    // give it a new group, so any replay here is a pure double
    expect(await t.models.rollups.findOne({ as: 'imports_daily' }).lean()).toEqual(dailyBefore);
    expect((await t.models.rollups.findOne({ as: 'import.completed' }).lean() as any).count).toBe(1);
  });

  it('a record that already carries the ref the linker names is left alone — the merge dedupes it, so there is nothing new to replay', async () => {
    const { t, state } = build();
    state.on = true;

    // written WITH the link — the post-adoption population
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();
    const rollsBefore = await rollupsOf(t);
    expect(rollsBefore.find((d) => d.as === 'import.completed').count).toBe(1);

    const r = await t.relink({ dryRun: false });
    expect(r).toMatchObject({ examined: 1, linked: 0, subjects: 0, rollups: 0 });
    expect(await rollupsOf(t)).toEqual(rollsBefore);
  });

  it('`names` restricts the sweep — a name left out keeps its backlog', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m1'));
    await t.emit('export.completed', machineOnly('m2'));
    await t.flush();

    state.on = true;
    const r = await t.relink({ names: ['import.completed'], dryRun: false });
    expect(r).toMatchObject({ examined: 1, linked: 1, rollups: 1 });

    expect((await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any).subjectKeys)
      .toEqual(['machine:m1', 'user:u_m1']);
    expect((await t.models.telemetry.findOne({ name: 'export.completed' }).lean() as any).subjectKeys)
      .toEqual(['machine:m2']);
    expect(await t.models.rollups.countDocuments({ as: 'exports' })).toBe(0);
  });

  it('a name the registry does not declare throws before any I/O — a typo that relinks nothing looks exactly like a clean run', async () => {
    const { t } = build();
    await expect(t.relink({ names: ['import.completed', 'nope.typo'], dryRun: false }))
      .rejects.toThrow(/nope\.typo/);
  });

  it('`since` restricts by occurrence — an operator backfilling one quarter does not rewrite the year', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m_old', '2026-01-01T00:00:00Z'));
    await t.emit('import.completed', machineOnly('m_new', '2026-07-01T00:00:00Z'));
    await t.flush();

    state.on = true;
    const r = await t.relink({ since: at('2026-06-01T00:00:00Z'), dryRun: false });
    expect(r).toMatchObject({ examined: 1, linked: 1 });

    expect(await t.models.rollups.countDocuments({ dims: 'user:u_m_new' })).toBe(1);
    expect(await t.models.rollups.countDocuments({ dims: 'user:u_m_old' })).toBe(0);
  });

  it('`limit` caps records EXAMINED, not records linked — it is a budget for the scan, and the rest are still there next run', async () => {
    const { t, state } = build();
    for (const id of ['m1', 'm2', 'm3', 'm4']) await t.emit('import.completed', machineOnly(id));
    await t.flush();

    state.on = true;
    const r = await t.relink({ limit: 2, dryRun: false });
    expect(r.examined).toBe(2);
    expect(r.linked).toBe(2);
    expect(await t.models.rollups.countDocuments({ as: 'import.completed' })).toBe(2);

    // the remaining two are picked up by the next run, and the first two are
    // not counted a second time
    const rest = await t.relink({ dryRun: false });
    expect(rest).toMatchObject({ examined: 4, linked: 2, rollups: 2 });
    const counts = (await rollupsOf(t))
      .filter((d) => d.as === 'import.completed')
      .map((d) => d.count);
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it('`limit: 0` examines nothing — Mongo reads a zero limit as NO limit, which would sweep the whole collection', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    state.on = true;
    expect(await t.relink({ limit: 0, dryRun: false })).toMatchObject({ examined: 0, linked: 0 });
    expect((await t.models.telemetry.findOne({}).lean() as any).subjectKeys).toEqual(['machine:m1']);
  });

  it('it streams — a collection larger than one batch is processed whole, and progress is reported per batch', async () => {
    const { t, state } = build();
    for (let i = 0; i < 25; i++) await t.emit('import.completed', machineOnly(`m${i}`));
    await t.flush();

    state.on = true;
    const seen: number[] = [];
    const r = await t.relink({ batchSize: 10, dryRun: false, onProgress: (p) => seen.push(p.examined) });

    expect(r).toMatchObject({ examined: 25, linked: 25, subjects: 25, rollups: 25 });
    expect(await t.models.rollups.countDocuments({ as: 'import.completed' })).toBe(25);
    // cumulative, per batch, and the trailing partial batch reports too
    expect(seen).toEqual([10, 20, 25]);
  });

  it('an onProgress that throws does not kill the backfill — a broken printer is not a data problem', async () => {
    const { t, state } = build();
    for (let i = 0; i < 3; i++) await t.emit('import.completed', machineOnly(`m${i}`));
    await t.flush();

    state.on = true;
    const r = await t.relink({
      batchSize: 1, dryRun: false,
      onProgress: () => { throw new Error('stdout is gone'); },
    });
    expect(r).toMatchObject({ examined: 3, linked: 3 });
  });

  it('an empty answer is a MISS, not a failure — on a backfill it is the expected answer for most rows', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('unmapped'));
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    state.on = true;
    const r = await t.relink({ dryRun: false });
    expect(r).toMatchObject({ examined: 2, linked: 1, misses: 1, errors: 0 });
  });

  it('a linker that throws costs that row its link and nothing else — the sweep does not stop', async () => {
    const { t, state } = build();
    for (const id of ['boom', 'm1']) await t.emit('import.completed', machineOnly(id));
    await t.flush();

    state.on = true;
    state.impl = (subjects, ctx) => {
      if (subjects.some((s) => s.id === 'boom')) throw new Error('user service down');
      return resolveOwner(subjects, ctx);
    };

    const r = await t.relink({ dryRun: false });
    expect(r).toMatchObject({ examined: 2, linked: 1, errors: 1, misses: 0 });
    expect((await t.models.telemetry.findOne({ subjectKeys: 'machine:boom' }).lean() as any).subjectKeys)
      .toEqual(['machine:boom']);
    expect(await t.models.rollups.countDocuments({ dims: 'user:u_m1' })).toBe(1);
  });

  it('garbage is not a link, and one bad row costs one error however many ways it was bad', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    state.on = true;
    state.impl = (() => [null, 42, { type: 'user' }]) as any;
    const r = await t.relink({ dryRun: false });

    // three junk entries, ONE row: this result counts rows, and
    // counters.subjectLinkErrors keeps the finer tally
    expect(r).toMatchObject({ examined: 1, linked: 0, errors: 1 });
    expect(t.counters.subjectLinkErrors).toBe(3);
    expect((await t.models.telemetry.findOne({}).lean() as any).subjectKeys).toEqual(['machine:m1']);
  });

  it('a linker that hangs is abandoned at the timeout, and the row keeps the subjects it had', async () => {
    const { t, state } = build({ subjectLinkTimeoutMs: 20 });
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    state.on = true;
    state.impl = () => new Promise<Ref[]>(() => {}); // never settles

    const started = Date.now();
    const r = await t.relink({ dryRun: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toMatchObject({ examined: 1, linked: 0, errors: 1 });
    expect(t.counters.subjectLinkTimeouts).toBe(1);
  });

  it('no subjectLinker is a skip, not a throw — a host may call this from a boot path that does not know how the instance was configured', async () => {
    const t = buildTelemetry({ registry: relinkRegistry() }); // no subjectLinker
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    expect(t.linkSubjects).toBeNull();
    const r = await t.relink({ dryRun: false });
    expect(r).toEqual({
      examined: 0, linked: 0, subjects: 0, rollups: 0, misses: 0, errors: 0, skipped: 1,
    });
    expect((await t.models.telemetry.findOne({}).lean() as any).subjectKeys).toEqual(['machine:m1']);
  });

  it('a stored row whose name the registry no longer declares is skipped, not relinked — its rollup families are unknowable, and a row whose aggregates disagree with it is the bug this exists to fix', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m1'));
    await t.flush();

    // the host dropped the event from its registry after the rows were written
    delete (t.registry as Record<string, unknown>)['import.completed'];

    state.on = true;
    const r = await t.relink({ dryRun: false });
    expect(r).toMatchObject({ examined: 1, linked: 0, skipped: 1 });
    expect((await t.models.telemetry.findOne({}).lean() as any).subjectKeys).toEqual(['machine:m1']);
  });

  it('a usage row is relinked too, sums and all — every kind is a discriminator on one collection, and a sweep that missed one would leave money unattributed', async () => {
    const { t, state } = build();
    await t.syncIndexes();

    await t.emit('billing.desktop_minutes', {
      ...machineOnly('m9'),
      metrics: { cost_usd: 4.5 },
      usage: {
        meter: 'desktop_minutes', quantity: 12, unit: 'minute',
        idempotencyKey: 'run_1', billedTo: 'machine:m9',
      },
    });
    await t.flush();
    expect(await t.models.rollups.countDocuments({ as: 'desktop_spend' })).toBe(0);

    state.on = true;
    expect(await t.relink({ dryRun: false })).toMatchObject({ examined: 1, linked: 1, rollups: 1 });

    const spend = await t.models.rollups.findOne({ as: 'desktop_spend' }).lean() as any;
    expect(spend.dims).toEqual(['user:u_m9']);
    expect(spend.count).toBe(1);
    // the measure rides the replay, not just the count — a spend family that
    // gained a member with sums of zero would be worse than one that gained none
    expect(spend.sums.cost_usd).toBe(4.5);

    // …and it is not counted twice
    expect(await t.relink({ dryRun: false })).toMatchObject({ linked: 0, rollups: 0 });
    expect((await t.models.rollups.findOne({ as: 'desktop_spend' }).lean() as any).sums.cost_usd)
      .toBe(4.5);
  });

  it('rows written before the hook and rows written after it end up identical — that is the whole point of the operation', async () => {
    const { t, state } = build();
    await t.emit('import.completed', machineOnly('m_before'));
    await t.flush();
    state.on = true;
    await t.emit('import.completed', machineOnly('m_after'));
    await t.flush();

    await t.relink({ dryRun: false });

    const rows = await t.models.telemetry.find({}).sort({ subjectKeys: 1 }).lean() as any[];
    const shape = (id: string) => {
      const row = rows.find((r) => r.subjectKeys.includes(`machine:${id}`))!;
      return { subjects: row.subjects.map((s: Ref) => `${s.type}:${s.id}`), keys: row.subjectKeys };
    };
    expect(shape('m_before')).toEqual({
      subjects: ['machine:m_before', 'user:u_m_before'],
      keys: ['machine:m_before', 'user:u_m_before'],
    });
    expect(shape('m_after')).toEqual({
      subjects: ['machine:m_after', 'user:u_m_after'],
      keys: ['machine:m_after', 'user:u_m_after'],
    });

    // and both are members of the family the funnel reads
    const counts = (await rollupsOf(t))
      .filter((d) => d.as === 'import.completed')
      .map((d) => [d.dims[0], d.count]);
    expect(counts.sort()).toEqual([['user:u_m_after', 1], ['user:u_m_before', 1]]);
  });
});
