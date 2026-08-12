import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DROP_TRACE, KEEP_TRACE, at, buildTelemetry, startDb, stopDb } from './helpers.js';

describe('emit — the two planes', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('a sampled-away record still reaches its rollup — aggregate before you drop (ops rule 8)', async () => {
    const t = buildTelemetry();
    await t.emit('sampled.event', {
      tenantId: 'tn', traceId: DROP_TRACE, occurredAt: at('2026-07-01T00:00:00Z'),
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'sampled.event' })).toBe(0); // evidence gone
    const roll = await t.models.rollups.findOne({ as: 'sampled_family' }).lean() as any;
    expect(roll.count).toBe(1); // aggregate exact
    expect(t.counters.sampled).toBe(1);
  });

  it('a kept trace stores evidence stamped with its sampleRate for later extrapolation', async () => {
    const t = buildTelemetry();
    await t.emit('sampled.event', {
      tenantId: 'tn', traceId: KEEP_TRACE, occurredAt: at('2026-07-01T00:00:00Z'),
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({ name: 'sampled.event' }).lean() as any;
    expect(row.sampleRate).toBe(0.5);
    expect(row.forced).toBe(false);
  });

  it('forceKeep survives sampling and is stamped forced:true, sampleRate:1 — excluded from ratios', async () => {
    const t = buildTelemetry();
    await t.emit('sampled.event', {
      tenantId: 'tn', traceId: DROP_TRACE, forceKeep: true, occurredAt: at('2026-07-01T00:00:00Z'),
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({ name: 'sampled.event' }).lean() as any;
    expect(row.forced).toBe(true);
    expect(row.sampleRate).toBe(1);
  });

  it('the burst cap bounds RAW rows while the issue rollup counts every occurrence — dashboards stay exact', async () => {
    const t = buildTelemetry();
    for (let i = 0; i < 70; i++) {
      await t.emit('error.unhandled', {
        tenantId: 'tn', occurredAt: at('2026-07-01T00:00:00Z'),
        error: { type: 'E', message: 'storm', handled: false, fingerprint: 'storm1' },
      });
    }
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'error.unhandled' })).toBe(60); // capped
    const issue = await t.models.rollups.findOne({ as: 'issue' }).lean() as any;
    expect(issue.count).toBe(70); // exact
    expect(t.counters.capped).toBe(10);
  });

  it('the burst key isolates groups — a storm on one fingerprint never starves another', async () => {
    const t = buildTelemetry();
    for (let i = 0; i < 65; i++) {
      await t.emit('error.unhandled', {
        tenantId: 'tn', occurredAt: at('2026-07-01T00:00:00Z'),
        error: { type: 'E', message: 'loud', handled: false, fingerprint: 'loud' },
      });
    }
    await t.emit('error.unhandled', {
      tenantId: 'tn', occurredAt: at('2026-07-01T00:00:00Z'),
      error: { type: 'E', message: 'quiet', handled: false, fingerprint: 'quiet' },
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ 'error.fingerprint': 'quiet' })).toBe(1);
  });

  it('a caller cannot override forced/name/_id/sampleRate — computed fields spread LAST (ops rule 6)', async () => {
    const t = buildTelemetry();
    await t.emit('llm.completion', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      traceId: DROP_TRACE, spanId: 's1', durationMs: 5,
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { gen_ai_system: 'a', gen_ai_request_model: 'm', feature: 'chat' },
      metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.5 },
      // hostile/buggy caller tries to sample away a cost-bearing span
      forced: false, sampleRate: 0, name: 'other.event', _id: 'attacker-chosen',
    } as any);
    await t.flush();
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(row).toBeTruthy(); // survived — cost_usd forces keep
    expect(row.forced).toBe(true);
    expect(row.sampleRate).toBe(1);
    expect(row.name).toBe('llm.completion');
    expect(row._id).not.toBe('attacker-chosen');
  });

  it('an invalid record reaches NO plane — no rollup, no row, quarantined once', async () => {
    const t = buildTelemetry();
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: [{ type: 'account', id: 'a1' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { source: 'ads', smuggled: 'x' } as any, // strict-rejected
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
    expect(await t.models.rollups.countDocuments({})).toBe(0); // the aggregate plane never saw it
    expect(await t.collections.rejects().countDocuments({})).toBe(1);
  });

  it('a replayed usage row is the same money — one row, ONE rollup count, no throw (dedupe gates aggregation)', async () => {
    const t = buildTelemetry();
    await t.syncIndexes(); // the unique partial index must exist before the race
    const usage = {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { gen_ai_request_model: 'm', feature: 'chat' }, metrics: { cost_usd: 0.05 },
      usage: { meter: 'ai_tokens', quantity: 100, unit: 'token', idempotencyKey: 'tr_1:s_3', billedTo: 'org:o' },
    };
    await t.emit('billing.ai_tokens', { ...usage });
    await t.emit('billing.ai_tokens', { ...usage }); // webhook retry
    await t.emit('billing.ai_tokens', { ...usage }); // queue replay
    await t.flush();

    expect(await t.models.telemetry.countDocuments({ name: 'billing.ai_tokens' })).toBe(1);
    const spend = await t.models.rollups.findOne({ as: 'spend' }).lean() as any;
    expect(spend.count).toBe(1); // counted once — the whole point of the inversion
    expect(spend.sums.cost_usd).toBeCloseTo(0.05);
    expect(t.counters.deduped).toBe(2); // the replays are visible, not silent
  });

  it('an INVALID usage row throws to the caller — money failures are never fire-and-forget', async () => {
    const t = buildTelemetry();
    await expect(
      t.emit('billing.ai_tokens', {
        tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
        occurredAt: at('2026-07-01T00:00:00Z'),
        attrs: { gen_ai_request_model: 'm', feature: 'chat' }, metrics: { cost_usd: 0.05 },
        usage: { meter: 'ai_tokens', quantity: 100, unit: 'token' } as any, // no idempotencyKey/billedTo
      }),
    ).rejects.toThrow();
    expect(await t.collections.rejects().countDocuments({})).toBe(1);
  });

  it('flush() drains fire-and-forget writes — nothing emitted is unqueryable after it resolves', async () => {
    const t = buildTelemetry();
    const emits = Array.from({ length: 25 }, (_, i) =>
      t.emit('report.shared', {
        tenantId: 'tn', subjects: [{ type: 'user', id: `u${i}` }],
        occurredAt: at('2026-07-01T00:00:00Z'),
      }),
    );
    await Promise.all(emits);
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'report.shared' })).toBe(25);
    expect(await t.models.rollups.countDocuments({ as: 'report.shared' })).toBe(25);
  });

  it('a redelivered dedupeKey writes ONE row and leaves the rollup count at 1 — gating the insert must gate aggregation', async () => {
    // the whole point of B1: a test that only counted rows would pass while the
    // real bug — a webhook redelivery inflating every aggregate — survived
    const t = buildTelemetry();
    await t.syncIndexes(); // the unique partial index must exist before the race
    const share = {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u1' }],
      occurredAt: at('2026-07-01T00:00:00Z'), dedupeKey: 'stripe:evt_1',
    };
    const first = await t.emit('report.shared', { ...share });
    const retry = await t.emit('report.shared', { ...share }); // webhook redelivery
    const replay = await t.emit('report.shared', { ...share }); // bridge rewound its watermark
    await t.flush();

    expect(first.outcome).toBe('written');
    expect(retry.outcome).toBe('deduped');
    expect(replay.outcome).toBe('deduped');
    expect(await t.models.telemetry.countDocuments({ name: 'report.shared' })).toBe(1);
    const roll = await t.models.rollups.findOne({ as: 'report.shared' }).lean() as any;
    expect(roll.count).toBe(1); // NOT 3 — the dup aggregated nothing
    expect(t.counters.deduped).toBe(2);
  });

  it('a dedupeKey is tenant-scoped — the same key under another tenant is a different fact', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    for (const tenantId of ['tn_a', 'tn_b']) {
      await t.emit('report.shared', {
        tenantId, subjects: [{ type: 'user', id: 'u1' }],
        occurredAt: at('2026-07-01T00:00:00Z'), dedupeKey: 'nightly:2026-07-01',
      });
    }
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'report.shared' })).toBe(2);
  });

  it('a dedupeKey survives sampling — a record whose rollup is gated on its own insert must never be sampled away', async () => {
    // the subtle half of B1: sampling it would take the aggregate with it,
    // because the rollup only runs if the insert won
    const t = buildTelemetry();
    await t.syncIndexes();
    const r = await t.emit('sampled.event', {
      tenantId: 'tn', traceId: DROP_TRACE, dedupeKey: 'lifecycle:acct1:2026-07-01',
      occurredAt: at('2026-07-01T00:00:00Z'),
    });
    await t.flush();
    expect(r.outcome).toBe('written'); // not 'sampled'
    const row = await t.models.telemetry.findOne({ name: 'sampled.event' }).lean() as any;
    expect(row.forced).toBe(true);
    expect(row.sampleRate).toBe(1);
    expect(row.dedupeKey).toBe('lifecycle:acct1:2026-07-01');
    const roll = await t.models.rollups.findOne({ as: 'sampled_family' }).lean() as any;
    expect(roll.count).toBe(1);
  });

  it('a malformed dedupeKey is quarantined, never silently ignored — a dropped key is a duplicate row', async () => {
    const t = buildTelemetry();
    const bad = async (dedupeKey: unknown) =>
      (await t.emit('report.shared', {
        tenantId: 'tn', subjects: [{ type: 'user', id: 'u1' }],
        occurredAt: at('2026-07-01T00:00:00Z'), dedupeKey,
      } as any)).outcome;
    expect(await bad('')).toBe('rejected');
    expect(await bad('k'.repeat(201))).toBe('rejected');
    expect(await bad(42)).toBe('rejected');
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
    expect(await t.collections.rejects().countDocuments({})).toBe(3);
  });

  it('a durable span is queryable the instant await returns — no flush(), no global drain', async () => {
    const t = buildTelemetry();
    const r = await t.emit('llm.completion', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_1234abcd', spanId: 's1', durationMs: 5,
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'm', feature: 'chat' },
      metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.01 },
      durable: true,
    });
    // deliberately NO flush() — that is the whole complaint durable answers
    expect(r.outcome).toBe('written');
    expect(await t.models.telemetry.countDocuments({ name: 'llm.completion' })).toBe(1);
    await t.flush();
  });

  it('a durable emit awaits its ROLLUPS too — the aggregate is readable with no flush()', async () => {
    // `written` used to mean the row and only the row: rollups were ctx.track()
    // on every path, so a host that awaited a durable emit and then read the
    // aggregate could legitimately get a stale one — the race durable exists to
    // remove, one plane over.
    const t = buildTelemetry();
    const r = await t.emit('llm.completion', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_2222abcd', spanId: 's1', durationMs: 7,
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'm', feature: 'chat' },
      metrics: { tokens_in: 3, tokens_out: 4, cost_usd: 0.25 },
      durable: true,
    });
    expect(r.outcome).toBe('written');
    // deliberately NO flush() — 'written' now covers both planes
    const roll = await t.models.rollups.findOne({ as: 'llm_cost' }).lean() as any;
    expect(roll).toBeTruthy();
    expect(roll.sums.cost_usd).toBeCloseTo(0.25);
    await t.flush();
  });

  it('usage is durable by kind, so its SPEND rollup is on disk the instant emit returns — money first', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    const r = await t.emit('billing.ai_tokens', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { gen_ai_request_model: 'm', feature: 'chat' }, metrics: { cost_usd: 0.42 },
      usage: { meter: 'ai_tokens', quantity: 100, unit: 'token', idempotencyKey: 'tr_9:s_1', billedTo: 'org:o' },
    });
    expect(r.outcome).toBe('written');
    // no flush: an invoice read that has to guess whether the aggregate landed
    // is the bug, and usage is the case where it costs actual money
    const spend = await t.models.rollups.findOne({ as: 'spend' }).lean() as any;
    expect(spend.count).toBe(1);
    expect(spend.sums.cost_usd).toBeCloseTo(0.42);
    await t.flush();
  });

  it('the NON-durable path stays fire-and-forget — its rollup is a promise until flush()', async () => {
    // the other half of the contract: awaiting aggregates on every path would
    // put a Mongo round trip on the hot path of a page view
    const t = buildTelemetry();
    const r = await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u_ff' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
    });
    expect(r.outcome).toBe('queued');
    await t.flush();
    expect(await t.models.rollups.countDocuments({ as: 'report.shared' })).toBe(1);
  });

  it('EventSpec.durable makes it the default for every caller of that name', async () => {
    const t = buildTelemetry();
    const r = await t.emit('ledger.charge', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_5678abcd', spanId: 's1', durationMs: 3,
      occurredAt: at('2026-07-01T00:00:00Z'), metrics: { amount_usd: 12.5 },
    });
    expect(r.outcome).toBe('written');
    expect(await t.models.telemetry.countDocuments({ name: 'ledger.charge' })).toBe(1);
    await t.flush();
  });

  it('a durable write that fails reaches the caller — the contract usage always had, now declarable', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    const charge = {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_9999abcd', spanId: 's1', durationMs: 3,
      occurredAt: at('2026-07-01T00:00:00Z'), metrics: { amount_usd: 1 },
      dedupeKey: 'charge:1',
    };
    await t.emit('ledger.charge', charge);
    // durable + dedupeKey: insert-gating wins on ordering, so a replay is a
    // clean 'deduped' rather than a throw — dedupe is not a failure
    expect((await t.emit('ledger.charge', charge)).outcome).toBe('deduped');
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'ledger.charge' })).toBe(1);
  });

  it('emit() reports what actually happened — written, queued, deduped, sampled, capped, rejected', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    const when = at('2026-07-01T00:00:00Z');

    const written = await t.emit('ledger.charge', {
      tenantId: 'tn', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_1111abcd', spanId: 's1', durationMs: 1, occurredAt: when,
      metrics: { amount_usd: 1 },
    });
    const queued = await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u1' }], occurredAt: when,
    });
    await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u2' }], occurredAt: when, dedupeKey: 'dk_1',
    });
    const deduped = await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u2' }], occurredAt: when, dedupeKey: 'dk_1',
    });
    const sampled = await t.emit('sampled.event', { tenantId: 'tn', traceId: DROP_TRACE, occurredAt: when });
    let capped = { outcome: 'queued' } as { outcome: string };
    for (let i = 0; i < 61; i++) {
      capped = await t.emit('error.unhandled', {
        tenantId: 'tn', occurredAt: when,
        error: { type: 'E', message: 'storm', handled: false, fingerprint: 'outcomes' },
      });
    }
    const rejected = await t.emit('never.registered' as any, { tenantId: 'tn', occurredAt: when });
    await t.flush();

    expect(written.outcome).toBe('written');
    expect(queued.outcome).toBe('queued');
    expect(deduped.outcome).toBe('deduped');
    expect(sampled.outcome).toBe('sampled');
    expect(capped.outcome).toBe('capped');
    expect(rejected.outcome).toBe('rejected');
    // the id correlates even when nothing was stored
    expect(rejected.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await t.models.telemetry.countDocuments({ _id: sampled.id })).toBe(0);
  });

  it('a queued write is only a promise of a row — flush() is what makes it queryable', async () => {
    const t = buildTelemetry();
    const r = await t.emit('report.shared', {
      tenantId: 'tn', subjects: [{ type: 'user', id: 'u1' }], occurredAt: at('2026-07-01T00:00:00Z'),
    });
    expect(r.outcome).toBe('queued');
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ _id: r.id })).toBe(1);
  });

  it('scoped() pins the tenant on find, aggregate, and rollups — cross-tenant reads are unreachable', async () => {
    const t = buildTelemetry();
    for (const tenantId of ['tn_a', 'tn_b']) {
      await t.emit('report.shared', {
        tenantId, subjects: [{ type: 'user', id: 'u1' }], occurredAt: at('2026-07-01T00:00:00Z'),
      });
    }
    await t.flush();
    expect(await t.scoped('tn_a').find({}).countDocuments()).toBe(1);
    const agg = await t.scoped('tn_a').aggregate([{ $count: 'n' }]);
    expect(agg[0].n).toBe(1);
    expect(await t.scoped('tn_a').rollups({}).countDocuments()).toBe(1);
    // and the sneaky version: a caller-supplied tenantId in the query is
    // overridden by the pin — still tn_a's row, never tn_b's
    const sneaky = await t.scoped('tn_a').find({ tenantId: 'tn_b' }).lean() as any[];
    expect(sneaky).toHaveLength(1);
    expect(sneaky[0].tenantId).toBe('tn_a');
  });
});
