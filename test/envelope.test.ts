import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * The envelope + pre-validate hook. Named after failures, per
 * standards/testing.md.
 */
describe('envelope', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('derives subjectKeys and otherPrincipals — actor lands in otherPrincipals only when not a subject', async () => {
    const t = buildTelemetry();
    await t.emit('report.shared', {
      tenantId: 'acc_9',
      subjects: [{ type: 'user', id: 'u_1', role: 'sender' }, { type: 'user', id: 'u_2', role: 'recipient' }],
      actor: 'user:u_1',
      onBehalfOf: 'admin:u_9',
      occurredAt: at('2026-07-01T10:00:00Z'),
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({ name: 'report.shared' }).lean() as any;
    expect(row.subjectKeys.sort()).toEqual(['user:u_1', 'user:u_2']);
    expect(row.otherPrincipals).toEqual(['admin:u_9']); // u_1 already a subject
  });

  it('defaults missing service/release to "unknown" AND counts it — never rejects on origin metadata', async () => {
    const t = buildTelemetry();
    await t.emit('report.shared', {
      tenantId: 'acc_9',
      subjects: [{ type: 'user', id: 'u_1' }],
      occurredAt: at('2026-07-01T10:00:00Z'),
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(row.service).toBe('unknown');
    expect(row.release).toBe('unknown');
    expect(row.env).toBe('dev'); // NODE_ENV=test → dev, stamped by the hook, not a schema default
    expect(t.counters.defaulted).toBeGreaterThanOrEqual(2);
  });

  it('stamps per-kind retention — and an explicit retentionDays: null means NO expiresAt', async () => {
    const t = buildTelemetry();
    const when = at('2026-07-01T00:00:00Z');
    await t.emit('report.shared', { tenantId: 'a', subjects: [{ type: 'user', id: 'u' }], occurredAt: when });
    await t.emit('llm.completion', {
      tenantId: 'a', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_1234abcd', spanId: 's1', durationMs: 5, occurredAt: when,
      attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'm', feature: 'chat' },
      metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.01 },
    });
    await t.emit('billing.ai_tokens', {
      tenantId: 'a', subjects: [{ type: 'org', id: 'o' }], occurredAt: when,
      attrs: { gen_ai_request_model: 'm', feature: 'chat' }, metrics: { cost_usd: 0.01 },
      usage: { meter: 'ai_tokens', quantity: 10, unit: 'token', idempotencyKey: 'k1', billedTo: 'org:o' },
    });
    await t.flush();

    const event = await t.models.telemetry.findOne({ name: 'report.shared' }).lean() as any;
    const span = await t.models.telemetry.findOne({ name: 'llm.completion' }).lean() as any;
    const usage = await t.models.telemetry.findOne({ name: 'billing.ai_tokens' }).lean() as any;
    const days = (d: Date) => Math.round((new Date(d).getTime() - when.getTime()) / 864e5);
    expect(days(event.expiresAt)).toBe(730);      // kind default
    expect(days(span.expiresAt)).toBe(400);       // per-name override beats the 90d span default
    expect(usage.expiresAt).toBeUndefined();      // money is immortal
  });

  it('rejects a span without traceId/spanId/durationMs into quarantine, not storage', async () => {
    const t = buildTelemetry();
    await t.emit('llm.completion', {
      tenantId: 'a', subjects: [{ type: 'org', id: 'o' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'm', feature: 'chat' },
      metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.01 },
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
    expect(await t.collections.rejects().countDocuments({})).toBe(1);
    expect(t.counters.rejected).toBe(1);
  });

  it('rejects a state row without state.to', async () => {
    const t = buildTelemetry();
    await t.emit('account.lifecycle', {
      tenantId: 'a', subjects: [{ type: 'account', id: 'acc' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      state: { key: 'lifecycle', from: 'trial' },
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
    expect(t.counters.rejected).toBe(1);
  });

  it('rejects a client-origin event with no client context', async () => {
    const t = buildTelemetry();
    await t.emit('data.first_viewed', {
      tenantId: 'a', subjects: [{ type: 'account', id: 'acc' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
  });

  it('rejects a missing required subject type', async () => {
    const t = buildTelemetry();
    await t.emit('account.signed_up', {
      tenantId: 'a', subjects: [{ type: 'user', id: 'u' }], // account required
      occurredAt: at('2026-07-01T00:00:00Z'), attrs: { source: 'ads' },
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
  });

  it('rejects undeclared attr keys — zod strict, not silent stripping', async () => {
    const t = buildTelemetry();
    await t.emit('account.signed_up', {
      tenantId: 'a', subjects: [{ type: 'account', id: 'acc' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { source: 'ads', smuggled: 'x' } as any,
    });
    await t.flush();
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
  });

  it('drops undeclared data entirely but keeps the row — declared-or-unstored', async () => {
    const t = buildTelemetry();
    await t.emit('report.shared', {
      tenantId: 'a', subjects: [{ type: 'user', id: 'u' }],
      occurredAt: at('2026-07-01T00:00:00Z'),
      data: { anything: 'goes' },
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(row).toBeTruthy();
    expect(row.data).toBeUndefined();
    expect(t.counters.rejected).toBe(1); // the drop is counted
  });

  it('stores boundedMeta data when in bounds, drops it whole when out — row survives both', async () => {
    const t = buildTelemetry();
    const base = {
      tenantId: 'a',
      subjects: [
        { type: 'user', id: 'u' }, { type: 'account', id: 'acc' }, { type: 'session', id: 's1' },
      ],
      client: { ...CLIENT },
      occurredAt: at('2026-07-01T00:00:00Z'),
    };
    await t.emit('page.view', { ...base, data: { route: '/reports' } });
    await t.emit('page.view', { ...base, data: { long: 'x'.repeat(300) } });
    await t.flush();
    const rows = await t.models.telemetry.find({ name: 'page.view' }).sort({ _id: 1 }).lean() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].data).toEqual({ route: '/reports' });
    expect(rows[1].data).toBeUndefined();
  });

  it('sanitizes dotted attr keys instead of crashing the Mongoose Map', async () => {
    const t = buildTelemetry();
    await t.emit('llm.completion', {
      tenantId: 'a', subjects: [{ type: 'org', id: 'o' }],
      traceId: 'tr_1234abcd', spanId: 's1', durationMs: 5,
      occurredAt: at('2026-07-01T00:00:00Z'),
      attrs: { 'gen_ai.system': 'anthropic', gen_ai_request_model: 'm', feature: 'chat' } as any,
      metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.01 },
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(row.attrs.gen_ai_system).toBe('anthropic');
  });

  it('quarantines an unregistered event name instead of throwing at the caller', async () => {
    const t = buildTelemetry();
    await expect(
      t.emit('typo.event' as any, { tenantId: 'a', occurredAt: at('2026-07-01T00:00:00Z') }),
    ).resolves.toBeUndefined();
    await t.flush();
    const rej = await t.collections.rejects().findOne({ name: 'typo.event' }) as any;
    expect(rej.reason).toMatch(/unregistered/);
  });

  it('records receivedAt via timestamps so the occurredAt↔receivedAt gap is measurable', async () => {
    const t = buildTelemetry();
    await t.emit('report.shared', {
      tenantId: 'a', subjects: [{ type: 'user', id: 'u' }],
      occurredAt: at('2020-01-01T00:00:00Z'), // long ago — a backfill
    });
    await t.flush();
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(new Date(row.receivedAt).getTime()).toBeGreaterThan(at('2026-01-01T00:00:00Z').getTime());
  });
});
