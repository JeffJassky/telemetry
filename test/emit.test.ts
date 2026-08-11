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
