import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

const acc = (id: string) => [{ type: 'account', id }];

describe('rollups — one primitive, four jobs', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('five milestone calls collapse to one row per account — firstAt never moves, count keeps the truth', async () => {
    // maxed verify [2] ported: the emitter contract is "call it on every
    // render without thinking". Once-ness now falls out of the upsert.
    const t = buildTelemetry();
    for (let i = 0; i < 5; i++) {
      await t.emit('data.first_viewed', {
        tenantId: 'tn', subjects: acc('acct1'), actor: 'user:u_1', client: { ...CLIENT },
        occurredAt: at(`2026-07-01T10:0${i}:00Z`),
      });
    }
    await t.emit('data.first_viewed', {
      tenantId: 'tn', subjects: acc('acct2'), actor: 'user:u_2', client: { ...CLIENT },
      occurredAt: at('2026-07-01T11:00:00Z'),
    });
    await t.flush();

    const rows = await t.models.rollups.find({ as: 'data.first_viewed' }).lean() as any[];
    expect(rows).toHaveLength(2); // per-account, not global — maxed verify [2b]
    const acct1 = rows.find((r) => r.dims[0] === 'account:acct1')!;
    expect(acct1.count).toBe(5);
    expect(new Date(acct1.firstAt).toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(new Date(acct1.lastAt).toISOString()).toBe('2026-07-01T10:04:00.000Z');
  });

  it('a late-arriving earlier record corrects firstAt AND the captured cohort dims', async () => {
    // update-pipeline upsert, not $setOnInsert: offline clients and backfills
    // must rewrite history to what actually happened first
    const t = buildTelemetry();
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: acc('a1'), occurredAt: at('2026-07-02T00:00:00Z'),
      attrs: { source: 'ads' },
    });
    await t.flush();
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: acc('a1'), occurredAt: at('2026-07-01T00:00:00Z'), // earlier!
      attrs: { source: 'organic' },
    });
    await t.flush();

    const roll = await t.models.rollups.findOne({ as: 'account.signed_up' }).lean() as any;
    expect(roll.count).toBe(2);
    expect(new Date(roll.firstAt).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(roll.firstCapture.source).toBe('organic'); // snapshot follows occurrence order, not arrival order
  });

  it('an admin actor never moves a customer aggregate — the raw row still lands for the explorer', async () => {
    // maxed verify [5] ported. RollupSpec.actors is the aggregate-plane gate;
    // the query-layer toggle cannot protect pre-aggregated families.
    const t = buildTelemetry();
    await t.emit('data.first_viewed', {
      tenantId: 'tn', subjects: acc('adminOnly'), actor: 'admin:u_9', client: { ...CLIENT },
      occurredAt: at('2026-07-01T00:00:00Z'),
    });
    await t.flush();
    expect(await t.models.rollups.countDocuments({ as: 'data.first_viewed' })).toBe(0);
    expect(await t.models.telemetry.countDocuments({ name: 'data.first_viewed' })).toBe(1);

    // system actors DO count — a job acting on the account's behalf is a real fact
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: acc('adminOnly'), actor: 'system:shopify-provisioning',
      occurredAt: at('2026-07-01T01:00:00Z'), attrs: { source: 'shopify' },
    });
    await t.flush();
    expect(await t.models.rollups.countDocuments({ as: 'account.signed_up' })).toBe(1);
  });

  it('llm_cost accumulates sums per (model, feature, day) and is immortal while its spans are not', async () => {
    const t = buildTelemetry();
    const span = (cost: number, hour: number) => ({
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }],
      traceId: `tr_00${hour}0abcd`, spanId: `s${hour}`, durationMs: 900,
      occurredAt: at(`2026-07-01T0${hour}:00:00Z`),
      attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'claude-opus-5', feature: 'chat' },
      metrics: { tokens_in: 100, tokens_out: 50, cost_usd: cost },
    });
    await t.emit('llm.completion', span(0.04, 1));
    await t.emit('llm.completion', span(0.06, 2));
    await t.flush();

    const roll = await t.models.rollups.findOne({ as: 'llm_cost' }).lean() as any;
    expect(roll.dims).toEqual(['gen_ai_request_model=claude-opus-5', 'feature=chat']);
    expect(new Date(roll.bucketAt).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(roll.count).toBe(2);
    expect(roll.sums.cost_usd).toBeCloseTo(0.1);
    expect(roll.sums.tokens_in).toBe(200);
    expect(roll.expiresAt).toBeUndefined(); // retentionDays: null — aggregate spend outlives evidence
  });

  it('the issue family captures release/type/route at FIRST occurrence and counts every one after', async () => {
    const t = buildTelemetry();
    const boom = (release: string, hour: number) => ({
      tenantId: 'tn', release,
      occurredAt: at(`2026-07-01T0${hour}:00:00Z`),
      attrs: { route: '/reports' },
      error: { type: 'TypeError', message: 'x is not a function', handled: false, fingerprint: 'abc123' },
    });
    await t.emit('error.unhandled', boom('app@1.4.2', 1));
    await t.emit('error.unhandled', boom('app@1.4.3', 2));
    await t.flush();

    const issue = await t.models.rollups.findOne({ as: 'issue' }).lean() as any;
    expect(issue.dims).toEqual(['error.fingerprint=abc123']);
    expect(issue.count).toBe(2);
    expect(issue.firstCapture.release).toBe('app@1.4.2'); // first seen, not last
    expect(issue.firstCapture['error.type']).toBe('TypeError');
  });

  it('a record missing a non-subject dim is skipped and counted — never keyed into a null bucket', async () => {
    const t = buildTelemetry();
    await t.emit('dim.probe', { tenantId: 'tn', occurredAt: at('2026-07-01T00:00:00Z') });
    await t.flush();
    expect(await t.models.rollups.countDocuments({ as: 'dim_probe' })).toBe(0);
    expect(t.counters.rollupSkipped).toBe(1);

    await t.emit('dim.probe', {
      tenantId: 'tn', occurredAt: at('2026-07-01T01:00:00Z'), attrs: { group: 'g1' },
    });
    await t.flush();
    const roll = await t.models.rollups.findOne({ as: 'dim_probe' }).lean() as any;
    expect(roll.dims).toEqual(['group=g1']);
    expect(roll.count).toBe(1); // the dimless record never contaminated the group
  });

  it('dimDefault puts the null-dim record in the NAMED bucket — the drop becomes a group you can query', async () => {
    // S2: silent-drop-on-null is the failure class this package refuses
    // everywhere else. The host names the bucket; nothing is invented.
    const t = buildTelemetry();
    await t.emit('dim.defaulted', { tenantId: 'tn', occurredAt: at('2026-07-01T00:00:00Z') });
    await t.emit('dim.defaulted', {
      tenantId: 'tn', occurredAt: at('2026-07-01T01:00:00Z'), attrs: { group: 'g1' },
    });
    await t.flush();

    const rows = await t.models.rollups.find({ as: 'dim_defaulted' }).sort({ _id: 1 }).lean() as any[];
    expect(rows.map((r) => r.dims[0]).sort()).toEqual(['group=g1', 'group=none']);
    expect(rows.every((r) => r.count === 1)).toBe(true); // the fallback is its OWN group
    expect(t.counters.rollupSkipped).toBe(0);

    // and the contrast, on the same instance: no dimDefault still skips + counts
    await t.emit('dim.probe', { tenantId: 'tn', occurredAt: at('2026-07-01T02:00:00Z') });
    await t.flush();
    expect(await t.models.rollups.countDocuments({ as: 'dim_probe' })).toBe(0);
    expect(t.counters.rollupSkipped).toBe(1);
  });

  it('the day-bucketed activity family writes one doc per subject per day — DAU is a count, MAU a distinct', async () => {
    const t = buildTelemetry();
    const view = (acct: string, iso: string) => ({
      tenantId: 'tn', subjects: acc(acct), actor: 'user:u_1', client: { ...CLIENT },
      occurredAt: at(iso),
    });
    await t.emit('data.first_viewed', view('a1', '2026-07-01T09:00:00Z'));
    await t.emit('data.first_viewed', view('a1', '2026-07-01T17:00:00Z')); // same day → same doc
    await t.emit('data.first_viewed', view('a1', '2026-07-02T09:00:00Z')); // next day → new doc
    await t.emit('data.first_viewed', view('a2', '2026-07-01T09:00:00Z'));
    await t.flush();

    const rows = await t.models.rollups.find({ as: 'activity' }).lean() as any[];
    expect(rows).toHaveLength(3);
    const day1 = rows.filter((r) => new Date(r.bucketAt).toISOString().startsWith('2026-07-01'));
    expect(day1).toHaveLength(2); // DAU(2026-07-01) = 2
    expect(rows.every((r) => r.expiresAt)).toBe(true); // activity is bucketed AND mortal (730d)
    expect(rows.every((r) => r.subjectType === 'account')).toBe(true);
  });

  it('subject fan-out respects the subjects restriction — only account refs feed account families', async () => {
    const t = buildTelemetry();
    await t.emit('account.signed_up', {
      tenantId: 'tn',
      subjects: [{ type: 'account', id: 'a1' }, { type: 'user', id: 'u1' }],
      occurredAt: at('2026-07-01T00:00:00Z'), attrs: { source: 'ads' },
    });
    await t.flush();
    const rows = await t.models.rollups.find({ as: 'account.signed_up' }).lean() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].dims).toEqual(['account:a1']); // user:u1 filtered out, no cross-class family mixing
  });

  it('bucket truncation is UTC — weeks start Monday, and §15 display timezones never leak into storage', async () => {
    const { truncate } = await import('../src/server/index.js');
    const sunday = at('2026-07-05T23:30:00Z');
    expect(truncate(sunday, 'day')!.toISOString()).toBe('2026-07-05T00:00:00.000Z');
    expect(truncate(sunday, 'week')!.toISOString()).toBe('2026-06-29T00:00:00.000Z'); // the prior Monday
    expect(truncate(sunday, 'month')!.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(truncate(sunday, 'hour')!.toISOString()).toBe('2026-07-05T23:00:00.000Z');
    expect(truncate(sunday, undefined)).toBeUndefined(); // lifetime rollup
  });
});
