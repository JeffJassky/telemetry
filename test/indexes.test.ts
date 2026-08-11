import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { z } from 'zod';
import { createTelemetry } from '../src/server/index.js';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

describe('indexes — registry-driven, budgeted, never COLLSCAN on the firehose', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('builds attr_/metric_ payload indexes from the registry, name-pinned and tenant-prefixed', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    const names = (await t.models.telemetry.collection.indexes()).map((i) => i.name);
    expect(names).toContain('attr_llm_completion_gen_ai_request_model');
    expect(names).toContain('attr_llm_completion_feature');
    expect(names).toContain('metric_llm_completion_cost_usd');
    expect(names).toContain('attr_billing_plan_selected_plan');
    const ix = (await t.models.telemetry.collection.indexes()).find(
      (i) => i.name === 'metric_llm_completion_cost_usd',
    ) as any;
    expect(ix.key).toEqual({ tenantId: 1, 'metrics.cost_usd': 1, occurredAt: -1 });
    expect(ix.partialFilterExpression).toEqual({ name: 'llm.completion' });
  });

  it('drops an orphaned payload index BEFORE the budget check — recoverable by config alone', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    await t.models.telemetry.collection.createIndex(
      { tenantId: 1, 'attrs.stale': 1, occurredAt: -1 },
      { name: 'attr_removed_event_stale', partialFilterExpression: { name: 'removed.event' } },
    );
    await t.syncIndexes();
    const names = (await t.models.telemetry.collection.indexes()).map((i) => i.name);
    expect(names).not.toContain('attr_removed_event_stale');
  });

  it('throws when the registry plans past the index budget — at boot, not at 3am', async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `wide.e${i}`,
        {
          kind: 'event' as const, origin: 'server' as const, subjects: [],
          attrs: z.object({ a: z.string() }), indexedAttrs: ['a'] as const,
          description: 'budget probe',
        },
      ]),
    );
    const t = createTelemetry({
      registry: wide, connection: mongoose,
      modelName: `TelemetryBudget${Date.now().toString(36)}`,
      collection: `telemetry_budget_${Date.now().toString(36)}`,
    });
    await expect(t.syncIndexes()).rejects.toThrow(/exceeds budget/);
  });

  it('the unique usage idempotency index is partial — non-usage rows must not collide on null', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    const ix = (await t.models.telemetry.collection.indexes()).find(
      (i: any) => i.key['usage.idempotencyKey'] === 1,
    ) as any;
    expect(ix.unique).toBe(true);
    expect(ix.partialFilterExpression).toEqual({ kind: 'usage' });
    // the failure this prevents: two plain events (usage.idempotencyKey: null) coexisting
    await t.emit('report.shared', { tenantId: 'tn', subjects: [{ type: 'user', id: 'u1' }], occurredAt: at('2026-07-01T00:00:00Z') });
    await t.emit('report.shared', { tenantId: 'tn', subjects: [{ type: 'user', id: 'u2' }], occurredAt: at('2026-07-01T00:00:00Z') });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ name: 'report.shared' })).toBe(2);
  });

  it('the firehose reads never COLLSCAN — subject timeline, name+time, fingerprint, trace', async () => {
    // maxed verify [7] ported to the unified envelope
    const t = buildTelemetry();
    await t.syncIndexes();
    for (let i = 0; i < 30; i++) {
      await t.emit('page.view', {
        tenantId: 'tn',
        subjects: [{ type: 'user', id: `u${i % 3}` }, { type: 'account', id: 'a1' }, { type: 'session', id: `s${i}` }],
        client: { ...CLIENT },
        occurredAt: at(`2026-07-01T10:${String(i).padStart(2, '0')}:00Z`),
      });
    }
    await t.flush();

    const planOf = async (q: Record<string, unknown>, sort: Record<string, 1 | -1>) => {
      const p: any = await t.models.telemetry.find(q).sort(sort).limit(50).explain('queryPlanner');
      return JSON.stringify(p.queryPlanner?.winningPlan ?? p);
    };
    expect(await planOf({ tenantId: 'tn', subjectKeys: 'user:u1' }, { occurredAt: -1 })).not.toContain('COLLSCAN');
    expect(await planOf({ tenantId: 'tn', kind: 'event', name: 'page.view' }, { occurredAt: -1 })).not.toContain('COLLSCAN');
    expect(await planOf({ tenantId: 'tn', 'error.fingerprint': 'x' }, { occurredAt: -1 })).not.toContain('COLLSCAN');
    expect(await planOf({ traceId: 'tr_1' }, { occurredAt: 1 })).not.toContain('COLLSCAN');
  });

  it('reuses an already-compiled model instead of throwing OverwriteModelError (traps #2)', async () => {
    const name = `TelemetryReuse${Date.now().toString(36)}`;
    const opts = { modelName: name, collection: `telemetry_reuse_${Date.now().toString(36)}` };
    const t1 = buildTelemetry(opts);
    const t2 = buildTelemetry(opts); // same names — second build must not throw
    expect(t2.models.telemetry).toBe(t1.models.telemetry);
  });
});
