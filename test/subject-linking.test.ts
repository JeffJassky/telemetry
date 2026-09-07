import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  SUBJECT_MAX, createIngest, defineRegistry, newId, type SubjectLinker,
} from '../src/server/index.js';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * Write-time subject linking (0.5.0). Suite names state the failure, per
 * standards/testing.md.
 *
 * The shape under test is the one that motivated the feature: a desktop client
 * knows its install and nothing else, so every record it sends carries
 * `machine:<installId>` and no `user`. Read-time resolution leaves a cohort
 * funnel anchored on `user` reading zero for every desktop stage — so the
 * assertions that matter here are on the ROLLUP DOCUMENT, not just the row. A
 * lifetime `by:['subject']` family is keyed on the subject the record was
 * written with, and no later join can reach back into it.
 */

const linkRegistry = () =>
  defineRegistry({
    // `user` DECLARED — the linked shape, and the only one whose linked subject
    // is allowed to be written
    'import.completed': {
      kind: 'event', origin: 'any', subjects: ['machine', 'user'],
      rollups: [{ by: ['subject'], subjects: ['user'] }],
      description: 'A desktop import finished — the stage the user funnel could not see',
    },
    // the same shape with `user` UNDECLARED — the refusal path
    'export.completed': {
      kind: 'event', origin: 'any', subjects: ['machine'],
      rollups: [{ by: ['subject'], subjects: ['user'] }],
      description: 'Declares only machine — a linked user has nowhere legal to land',
    },
    'share.published': {
      kind: 'event', origin: 'server', subjects: ['machine', 'user'],
      rollups: [{ as: 'shares', by: ['subject'], subjects: ['user'] }],
      description: 'The dedupeKey probe — insert-gated, so the insert is the verdict',
    },
    'billing.desktop_minutes': {
      kind: 'usage', origin: 'server', subjects: ['machine', 'user'],
      rollups: [{ as: 'desktop_spend', by: ['subject'], subjects: ['user'] }],
      description: 'Money on the insert-gated path',
    },
  });

type Ref = { type: string; id: string; role?: string };

/** the host resolver every test varies — `calls` is what proves WHEN it ran */
function linker(impl: SubjectLinker['link']) {
  const calls: Array<{ subjects: Ref[]; name: string; tenantId: string }> = [];
  const hook: SubjectLinker = {
    link: (subjects, ctx) => {
      calls.push({ subjects, name: ctx.name, tenantId: ctx.tenantId });
      return impl(subjects, ctx);
    },
  };
  return { hook, calls };
}

/** the machine → account map a real host would answer from cache */
const resolveOwner: SubjectLinker['link'] = (subjects) => {
  const machine = subjects.find((s) => s.type === 'machine');
  return machine && machine.id !== 'unmapped' ? [{ type: 'user', id: `u_${machine.id}` }] : [];
};

function warnLogger() {
  const warns: string[] = [];
  return { warns, logger: { info() {}, warn: (...a: unknown[]) => void warns.push(String(a[0])), error() {} } };
}

function build(over: Record<string, unknown> = {}) {
  return buildTelemetry({ registry: linkRegistry(), ...over });
}

const machineOnly = (id = 'm1') => ({
  tenantId: 'tn',
  subjects: [{ type: 'machine', id }],
  occurredAt: at('2026-07-01T00:00:00Z'),
});

describe('subject linking — the desktop record the user funnel could not see', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('a machine record is written with the linked user AND its user-keyed rollup names them — the read-time join can never do the second half', async () => {
    const { hook, calls } = linker(resolveOwner);
    const t = build({ subjectLinker: hook });

    const r = await t.emit('import.completed', machineOnly('m1'));
    await t.flush();
    expect(r.outcome).toBe('queued');

    const row = await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(row.subjects.map((s: Ref) => `${s.type}:${s.id}`)).toEqual(['machine:m1', 'user:u_m1']);
    expect(row.subjectKeys).toContain('user:u_m1'); // derived AFTER the merge, or the rollup misses

    // the whole point: the aggregate is keyed on the LINKED subject
    const roll = await t.models.rollups.findOne({ as: 'import.completed' }).lean() as any;
    expect(roll._id).toBe('tn|import.completed|user:u_m1|');
    expect(roll.dims).toEqual(['user:u_m1']);
    expect(roll.subjectType).toBe('user');
    expect(roll.count).toBe(1);

    // the host was asked once, with the record's own subjects and its context
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'import.completed', tenantId: 'tn' });
    expect(calls[0]!.subjects).toEqual([{ type: 'machine', id: 'm1' }]);
    expect(t.counters.subjectsLinked).toBe(1);
    expect(t.counters.subjectLinkMisses).toBe(0);
  });

  it('a ref the record already carries is never doubled, and the DECLARED role wins — the caller knew, the linker is guessing', async () => {
    const { hook } = linker(() => [{ type: 'user', id: 'u_1', role: 'viewer' }]);
    const t = build({ subjectLinker: hook });

    await t.emit('import.completed', {
      ...machineOnly('m1'),
      subjects: [{ type: 'machine', id: 'm1' }, { type: 'user', id: 'u_1', role: 'owner' }],
    });
    await t.flush();

    const row = await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(row.subjects).toHaveLength(2);
    expect(row.subjects[1].role).toBe('owner');
    expect(t.counters.subjectsLinked).toBe(0); // nothing was ADDED
    expect(t.counters.subjectLinkMisses).toBe(0); // …and the host did not miss, either
  });

  it('the cap bounds what linking may ADD — the subjects a record brought are never displaced by a derived one', async () => {
    const { hook } = linker(() => [
      { type: 'user', id: 'u_a' },
      { type: 'user', id: 'u_b' },
    ]);
    const t = build({ subjectLinker: hook });

    // seven declared: one short of SUBJECT_MAX, so exactly one link fits
    const declared: Ref[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'machine', id: `m${i}` })),
      { type: 'user', id: 'u_declared' },
    ];
    await t.emit('import.completed', { ...machineOnly(), subjects: declared });
    await t.flush();

    const row = await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(row.subjects).toHaveLength(SUBJECT_MAX);
    expect(row.subjects.slice(0, 7).map((s: Ref) => s.id)).toEqual(declared.map((s) => s.id));
    expect(t.counters.subjectsLinked).toBe(1);
    expect(t.counters.subjectLinkCapped).toBe(1);
  });

  it('a linked type the event does not declare is REFUSED and counted — the registry stays a description of what rows contain', async () => {
    const { hook } = linker(resolveOwner);
    const { warns, logger } = warnLogger();
    const t = build({ subjectLinker: hook, logger });

    for (const id of ['m1', 'm2', 'm3']) await t.emit('export.completed', machineOnly(id));
    await t.flush();

    const rows = await t.models.telemetry.find({ name: 'export.completed' }).lean() as any[];
    expect(rows).toHaveLength(3); // the record survives its refused link
    // fire-and-forget writes land in any order, so assert the SET
    expect(rows.flatMap((r) => r.subjectKeys).sort()).toEqual(['machine:m1', 'machine:m2', 'machine:m3']);
    expect(t.counters.subjectLinkUndeclared).toBe(3);
    expect(t.counters.subjectsLinked).toBe(0);

    // rate-limited: three records, ONE line. This fires from the write path.
    const undeclared = warns.filter((w) => w.includes('does not declare it'));
    expect(undeclared).toHaveLength(1);
    // …and it names the trap rather than telling a host to make `user` required
    expect(undeclared[0]).toContain('REQUIRED list');
  });

  it('a linker that throws costs the record its link, never its existence — ingest is unattended', async () => {
    const { hook } = linker(() => {
      throw new Error('user service down');
    });
    const { warns, logger } = warnLogger();
    const t = build({ subjectLinker: hook, logger });

    const r = await t.emit('export.completed', machineOnly());
    await t.flush();

    expect(r.outcome).toBe('queued');
    const row = await t.models.telemetry.findOne({ name: 'export.completed' }).lean() as any;
    expect(row.subjectKeys).toEqual(['machine:m1']);
    expect(t.counters.subjectLinkErrors).toBe(1);
    expect(warns.filter((w) => w.includes('threw'))).toHaveLength(1);
  });

  it('a linker that rejects asynchronously lands in the same place — the guard is not a try/catch around a call', async () => {
    const { hook } = linker(async () => {
      throw new Error('timed out talking to postgres');
    });
    const t = build({ subjectLinker: hook });
    await t.emit('export.completed', machineOnly());
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'export.completed' })).toBe(1);
    expect(t.counters.subjectLinkErrors).toBe(1);
  });

  it('a linker that hangs is abandoned at the timeout — a stalled host must never stall ingest', async () => {
    const { hook } = linker(() => new Promise<Ref[]>(() => {})); // never settles
    const t = build({ subjectLinker: hook, subjectLinkTimeoutMs: 20 });

    const started = Date.now();
    const r = await t.emit('export.completed', machineOnly());
    await t.flush();

    expect(Date.now() - started).toBeLessThan(2_000); // bounded, not blocked
    expect(r.outcome).toBe('queued');
    expect(await t.models.telemetry.countDocuments({ name: 'export.completed' })).toBe(1);
    expect(t.counters.subjectLinkTimeouts).toBe(1);
    expect(t.counters.subjectLinkErrors).toBe(0); // a timeout is its own diagnosis
  });

  it('garbage is not a link — a non-array answer, and junk inside a good one, are counted and dropped', async () => {
    const { hook } = linker((() => 'user:u_1') as unknown as SubjectLinker['link']);
    const t = build({ subjectLinker: hook });
    await t.emit('import.completed', {
      ...machineOnly(),
      subjects: [{ type: 'machine', id: 'm1' }, { type: 'user', id: 'u_1' }],
    });
    await t.flush();
    expect(t.counters.subjectLinkErrors).toBe(1);

    const junk = linker((() => [null, 42, { type: 'user' }, { id: 'u_2' }, { type: 'user', id: 'u_9' }]) as any);
    const t2 = build({ subjectLinker: junk.hook });
    await t2.emit('import.completed', machineOnly('m2'));
    await t2.flush();

    const row = await t2.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(row.subjectKeys).toEqual(['machine:m2', 'user:u_9']); // the one good ref still lands
    expect(t2.counters.subjectLinkErrors).toBe(4);
    expect(t2.counters.subjectsLinked).toBe(1);
  });

  it('an empty answer is a MISS, not a failure — "no link exists" is a fact the host is entitled to state', async () => {
    const { hook } = linker(resolveOwner);
    const t = build({ subjectLinker: hook });
    await t.emit('export.completed', machineOnly('unmapped'));
    await t.flush();
    expect(t.counters.subjectLinkMisses).toBe(1);
    expect(t.counters.subjectLinkErrors).toBe(0);
    expect(t.counters.subjectLinkUndeclared).toBe(0);
  });

  it('the linker is never asked about a record that was never going to be written', async () => {
    const { hook, calls } = linker(resolveOwner);
    const t = build({ subjectLinker: hook });

    await t.emit('never.registered' as any, machineOnly());
    await t.emit('import.completed', { ...machineOnly(), tenantId: '*' }); // reserved
    await t.emit('import.completed', { ...machineOnly(), dedupeKey: '' }); // malformed
    await t.flush();

    expect(calls).toHaveLength(0);
    expect(t.counters.rejected).toBe(3);
  });

  it('declaring the linked type makes it REQUIRED — on a total link that is right, and on a partial one it quarantines the miss', async () => {
    const { hook } = linker(resolveOwner);
    const t = build({ subjectLinker: hook });

    // `import.completed` declares `user`, so a machine nobody can resolve fails
    // validation. This is the sharp edge of the declared-type rule, asserted so
    // it is a decision rather than a surprise: declare the linked type only for
    // events whose link is total.
    const r = await t.emit('import.completed', machineOnly('unmapped'));
    await t.flush();

    expect(r.outcome).toBe('rejected');
    expect(t.counters.subjectLinkMisses).toBe(1);
    const reject = await t.collections.rejects().findOne({ name: 'import.completed' }) as any;
    expect(String(reject.reason)).toContain('requires subject "user"');
  });

  it('a dedupeKey still writes ONE row and ONE rollup — and that rollup is keyed on the linked user', async () => {
    const { hook, calls } = linker(resolveOwner);
    const t = build({ subjectLinker: hook });
    await t.syncIndexes(); // the unique partial index must exist before the race

    const share = { ...machineOnly('m7'), dedupeKey: 'stripe:evt_1' };
    const first = await t.emit('share.published', { ...share });
    const retry = await t.emit('share.published', { ...share });
    await t.flush();

    expect(first.outcome).toBe('written');
    expect(retry.outcome).toBe('deduped');
    expect(await t.models.telemetry.countDocuments({ name: 'share.published' })).toBe(1);
    const roll = await t.models.rollups.findOne({ as: 'shares' }).lean() as any;
    expect(roll.dims).toEqual(['user:u_m7']);
    expect(roll.count).toBe(1); // gating the insert still gates aggregation
    expect(t.counters.deduped).toBe(1);

    // DOCUMENTED, not desired: on the insert-gated path the INSERT is the
    // dedupe verdict, and the subjects have to be on the document before it. So
    // a redelivery asks the linker and then writes nothing. The cost is one
    // cached lookup per duplicate; the alternative is a second round trip on
    // every gated write, money included, to save it.
    expect(calls).toHaveLength(2);
    expect(t.counters.subjectsLinked).toBe(2);
  });

  it('money is linked too, and a replayed usage row is still the same money — one row, one spend rollup', async () => {
    const { hook } = linker(resolveOwner);
    const t = build({ subjectLinker: hook });
    await t.syncIndexes();

    const usage = {
      ...machineOnly('m3'),
      usage: {
        meter: 'desktop_minutes', quantity: 12, unit: 'minute',
        idempotencyKey: 'run_1', billedTo: 'user:u_m3',
      },
    };
    const r = await t.emit('billing.desktop_minutes', { ...usage });
    expect((await t.emit('billing.desktop_minutes', { ...usage })).outcome).toBe('deduped');
    await t.flush();

    expect(r.outcome).toBe('written'); // readable with no flush(), as before
    const row = await t.models.telemetry.findOne({ name: 'billing.desktop_minutes' }).lean() as any;
    expect(row.subjectKeys).toEqual(['machine:m3', 'user:u_m3']);
    const spend = await t.models.rollups.findOne({ as: 'desktop_spend' }).lean() as any;
    expect(spend.dims).toEqual(['user:u_m3']);
    expect(spend.count).toBe(1);
    expect(t.counters.deduped).toBe(1);
  });

  it('no subjectLinker is no behaviour change — nothing is asked, nothing is counted, the row is what it was', async () => {
    const t = build();
    await t.emit('export.completed', machineOnly());
    await t.flush();
    const row = await t.models.telemetry.findOne({ name: 'export.completed' }).lean() as any;
    expect(row.subjects.map((s: Ref) => `${s.type}:${s.id}`)).toEqual(['machine:m1']);
    expect(t.linkSubjects).toBeNull();
    for (const k of [
      'subjectsLinked', 'subjectLinkMisses', 'subjectLinkErrors',
      'subjectLinkTimeouts', 'subjectLinkUndeclared', 'subjectLinkCapped',
    ] as const) {
      expect(t.counters[k]).toBe(0);
    }
  });
});

/**
 * The wire. This is the path the feature exists for — createIngest() does NOT
 * call emit() (at-least-once delivery inverts the plane order, §4.6), so a hook
 * that lived only in emit() would leave every desktop record unlinked.
 */
describe('subject linking — over the wire, where the machine ref actually arrives', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  async function buildIngestApp(over: Record<string, unknown> = {}) {
    const t = build(over);
    await t.syncIndexes();
    const { key } = await t.createKey({
      kind: 'publishable', tenantMode: 'fixed', tenantId: 'tn',
      service: 'desktop', env: 'prod',
    } as any);
    const app = express();
    app.use('/telemetry/ingest', createIngest({ telemetry: t } as any));
    return { t, key, app };
  }

  const batch = (records: unknown[]) => ({
    sdk: { name: 'test', version: '0' },
    sentAt: new Date().toISOString(),
    release: 'app@1.0.0',
    client: { platform: 'electron', appVersion: '1.0.0' },
    context: { subjects: [{ type: 'machine', id: 'm1' }] },
    records,
  });

  it('a desktop batch carrying only a machine ref lands with the user on the row AND on the user-keyed rollup', async () => {
    const { hook, calls } = linker(resolveOwner);
    const { t, key, app } = await buildIngestApp({ subjectLinker: hook });

    const res = await request(app)
      .post('/telemetry/ingest')
      .set('authorization', `Bearer ${key}`)
      .send(batch([{ _id: newId(), name: 'import.completed', occurredAt: new Date().toISOString() }]));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1, rejected: 0 });

    const row = await t.models.telemetry.findOne({ name: 'import.completed' }).lean() as any;
    expect(row.subjectKeys).toEqual(['machine:m1', 'user:u_m1']);
    const roll = await t.models.rollups.findOne({ as: 'import.completed' }).lean() as any;
    expect(roll.dims).toEqual(['user:u_m1']);
    expect(calls).toHaveLength(1);
    expect(t.counters.subjectsLinked).toBe(1);
  });

  it('a broken linker never costs the wire a record — the batch is still accepted, unlinked and counted', async () => {
    const { hook } = linker(() => {
      throw new Error('user service down');
    });
    const { t, key, app } = await buildIngestApp({ subjectLinker: hook });

    const res = await request(app)
      .post('/telemetry/ingest')
      .set('authorization', `Bearer ${key}`)
      .send(batch([{ _id: newId(), name: 'export.completed', occurredAt: new Date().toISOString() }]));

    expect(res.body).toEqual({ accepted: 1, rejected: 0 });
    expect(await t.models.telemetry.countDocuments({ name: 'export.completed' })).toBe(1);
    expect(t.counters.subjectLinkErrors).toBe(1);
  });
});
