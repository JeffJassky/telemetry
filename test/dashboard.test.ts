import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDashboard } from '../src/server/index.js';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * The read surface. The template's universal checklist (401 leak, role guard,
 * caps, JSON-not-HTML) returns here, plus the five-primitive contract.
 */

async function seed(t: Awaited<ReturnType<typeof buildTelemetry>>) {
  await t.syncIndexes();
  const acc = (id: string) => [{ type: 'account', id }];
  for (let i = 0; i < 5; i++) {
    await t.emit('account.signed_up', {
      tenantId: 'tn', subjects: acc(`a${i}`), occurredAt: at(`2026-07-0${i + 1}T10:00:00Z`),
      attrs: { source: i % 2 ? 'ads' : 'organic' },
    });
  }
  await t.emit('data.first_viewed', {
    tenantId: 'tn', subjects: acc('a0'), actor: 'user:u_0', client: { ...CLIENT },
    occurredAt: at('2026-07-02T11:00:00Z'),
  });
  await t.emit('llm.completion', {
    tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }],
    traceId: 'tr_0000abcd', spanId: 's1', durationMs: 1200,
    occurredAt: at('2026-07-03T09:00:00Z'),
    attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'opus', feature: 'chat' },
    metrics: { tokens_in: 10, tokens_out: 5, cost_usd: 0.02 },
  });
  await t.emit('error.unhandled', {
    tenantId: 'tn', traceId: 'tr_0000abcd', occurredAt: at('2026-07-03T09:00:01Z'),
    error: { type: 'E', message: 'boom', handled: false, fingerprint: 'fp1' },
  });
  // another tenant — must never appear in tn's reads
  await t.emit('account.signed_up', {
    tenantId: 'other', subjects: acc('ax'), occurredAt: at('2026-07-01T10:00:00Z'),
    attrs: { source: 'ads' },
  });
  await t.flush();
}

function buildApp(t: any, viewer: any = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_me' }, extra: any = {}) {
  const state = { viewer };
  const app = express();
  app.use(
    '/telemetry',
    createDashboard({
      telemetry: t,
      viewerAdapter: { resolveViewer: () => state.viewer },
      ...extra,
    }),
  );
  return { app, state };
}

const RANGE = 'from=2026-06-30T00:00:00Z&to=2026-07-10T00:00:00Z';

describe('dashboard', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('refuses to construct without a viewerAdapter — a telemetry dashboard without auth is a leak', async () => {
    const t = buildTelemetry();
    expect(() => createDashboard({ telemetry: t } as any)).toThrow(/viewerAdapter/);
  });

  it('answers 401 JSON to an unauthenticated caller instead of leaking a list', async () => {
    const t = buildTelemetry();
    const { app, state } = buildApp(t);
    state.viewer = null;
    const res = await request(app).get(`/telemetry/api/records?${RANGE}`);
    expect(res.status).toBe(401);
    expect(res.body.items).toBeUndefined();
  });

  it('every read is tenant-scoped through the viewer — the other tenant does not exist', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t);
    const res = await request(app).get(`/telemetry/api/records?${RANGE}&name=account.signed_up`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5); // not 6
    expect(res.body.items.every((r: any) => r.tenantId === 'tn')).toBe(true);
    expect(res.body.dataSource).toBe('raw');
  });

  it('caps a list read at the limit even when the caller asks for more, and pages by cursor', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t, undefined, { queryLimits: { records: 3 } });
    const p1 = await request(app).get(`/telemetry/api/records?${RANGE}&limit=100000`);
    expect(p1.body.items).toHaveLength(3); // the cap, not the ask
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await request(app).get(`/telemetry/api/records?${RANGE}&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    const ids1 = p1.body.items.map((r: any) => r._id);
    const ids2 = p2.body.items.map((r: any) => r._id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0); // no overlap
  });

  it('rejects a missing/invalid time range as 400 — unbounded reads are unreachable (§18)', async () => {
    const t = buildTelemetry();
    const { app } = buildApp(t);
    const res = await request(app).get('/telemetry/api/records?from=2026-07-02&to=2026-07-01');
    expect(res.status).toBe(400);
  });

  it('series buckets by interval and filters by attr equality', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t);
    const res = await request(app).get(
      `/telemetry/api/series?${RANGE}&name=account.signed_up&interval=day&attrs=source:ads`,
    );
    expect(res.status).toBe(200);
    const total = res.body.buckets.reduce((s: number, b: any) => s + b.value, 0);
    expect(total).toBe(2); // a1, a3
  });

  it('the customer toggle excludes typed actors without touching actorless rows', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t);
    const admin = await request(app).get(
      `/telemetry/api/records?${RANGE}&name=data.first_viewed&excludeActors=user`,
    );
    expect(admin.body.items).toHaveLength(0); // the only one has actor user:u_0
    const keep = await request(app).get(
      `/telemetry/api/records?${RANGE}&name=account.signed_up&excludeActors=admin`,
    );
    expect(keep.body.items).toHaveLength(5); // no actor at all → customer facts stay
  });

  it('distribution reports percentiles off raw spans', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t);
    const res = await request(app).get(`/telemetry/api/distribution?${RANGE}&kind=span`);
    expect(res.status).toBe(200);
    expect(res.body.n).toBe(1);
    expect(res.body.p95).toBe(1200);
    expect(res.body.dataSource).toBe('raw');
  });

  it('rollups serves a family with dataSource:rollups; trace joins every kind on one axis', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t);
    const rolls = await request(app).get('/telemetry/api/rollups?as=account.signed_up');
    expect(rolls.body.rows).toHaveLength(5);
    expect(rolls.body.dataSource).toBe('rollups');

    const trace = await request(app).get('/telemetry/api/trace/tr_0000abcd');
    const kinds = trace.body.items.map((r: any) => r.kind).sort();
    expect(kinds).toEqual(['error', 'span']); // the span AND its error, one query
  });

  it('journey interleaves records with lifetime-rollup milestones for one subject', async () => {
    const t = buildTelemetry();
    await seed(t);
    const { app } = buildApp(t);
    const res = await request(app).get(`/telemetry/api/journey/${encodeURIComponent('account:a0')}?${RANGE}`);
    expect(res.body.records.length).toBeGreaterThanOrEqual(2); // signed_up + first_viewed
    const families = res.body.milestones.map((m: any) => m.as).sort();
    expect(families).toContain('account.signed_up');
    expect(families).toContain('data.first_viewed');
    expect(families).not.toContain('activity'); // bucketed families stay out of the markers
  });

  it('the registry projection exposes names and shapes but never zod internals', async () => {
    const t = buildTelemetry();
    const { app } = buildApp(t);
    const res = await request(app).get('/telemetry/api/registry');
    const entry = res.body.registry['llm.completion'];
    expect(entry.kind).toBe('span');
    expect(entry.attrKeys).toContain('feature');
    expect(entry.indexedMetrics).toContain('cost_usd');
    expect(entry.rollups[0].as).toBe('llm_cost');
    expect(JSON.stringify(entry)).not.toMatch(/_def|~standard/); // no zod guts on the wire
  });

  describe('views', () => {
    it('derives one view per event name and rollup family; saved shadows derived by name', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const before = await request(app).get('/telemetry/api/views');
      const derived = before.body.views.find((v: any) => v.name === 'error.unhandled');
      expect(derived.origin).toBe('derived');
      expect(before.body.views.some((v: any) => v.name === 'rollup: llm_cost')).toBe(true);

      await request(app).post('/telemetry/api/views').send({
        spec: { name: 'error.unhandled', page: 'errors', query: { range: '24h', filters: { severity: 'fatal' } } },
      });
      const after = await request(app).get('/telemetry/api/views');
      const shadowed = after.body.views.find((v: any) => v.name === 'error.unhandled');
      expect(shadowed.origin).toBe('saved'); // the user's version wins without editing anything
      expect(after.body.views.filter((v: any) => v.name === 'error.unhandled')).toHaveLength(1);
    });

    it('a private view is invisible to other viewers; a shared one is tenant-wide', async () => {
      const t = buildTelemetry();
      const { app, state } = buildApp(t);
      await request(app).post('/telemetry/api/views').send({
        spec: { name: 'mine', page: 'events', query: {} },
      });
      await request(app).post('/telemetry/api/views').send({
        spec: { name: 'ours', page: 'events', query: {} }, shared: true,
      });
      state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_else' };
      const res = await request(app).get('/telemetry/api/views');
      const names = res.body.views.map((v: any) => v.name);
      expect(names).not.toContain('mine');
      expect(names).toContain('ours');
    });

    it('deleting someone else\'s view needs the admin role', async () => {
      const t = buildTelemetry();
      const { app, state } = buildApp(t);
      const saved = await request(app).post('/telemetry/api/views').send({
        spec: { name: 'target', page: 'events', query: {} }, shared: true,
      });
      state.viewer = { tenantId: 'tn', role: 'member', viewerRef: 'user:u_else' };
      expect((await request(app).delete(`/telemetry/api/views/${saved.body.id}`)).status).toBe(403);
      state.viewer = { tenantId: 'tn', role: 'admin', viewerRef: 'user:u_admin' };
      expect((await request(app).delete(`/telemetry/api/views/${saved.body.id}`)).body.removed).toBe(1);
    });

    it('forget() erases a person\'s private views and redacts their name on shared ones', async () => {
      const t = buildTelemetry();
      const { app } = buildApp(t); // viewerRef user:u_me
      await request(app).post('/telemetry/api/views').send({ spec: { name: 'private', page: 'events', query: {} } });
      await request(app).post('/telemetry/api/views').send({ spec: { name: 'public', page: 'events', query: {} }, shared: true });
      const res = await t.forget('tn', 'user:u_me');
      expect(res.views).toBe(2);
      const remaining = await t.models.telemetry.db.collection(
        t.models.telemetry.collection.collectionName + '_views',
      ).find({}).toArray();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.ownerRef).toMatch(/^user:redacted_/);
    });
  });

  describe('system — where "never drop silently" becomes visible', () => {
    it('serves counters and quarantine to any viewer, keys only to admin', async () => {
      const t = buildTelemetry();
      await seed(t);
      await t.createKey({ kind: 'publishable', tenantMode: 'fixed', tenantId: 'tn', service: 'web', env: 'prod' } as any);
      const { app, state } = buildApp(t);
      const member = await request(app).get('/telemetry/api/system');
      expect(member.body.counters).toBeDefined();
      expect(member.body.indexBudget).toBe(24);
      expect(member.body.keys).toHaveLength(0);

      state.viewer = { tenantId: 'tn', role: 'admin' };
      const admin = await request(app).get('/telemetry/api/system');
      expect(admin.body.keys).toHaveLength(1);
      expect(JSON.stringify(admin.body.keys)).not.toContain('secretHash');
    });

    it('key revocation requires the admin role — via OUR check, since the host guard may be coarser', async () => {
      const t = buildTelemetry();
      const { key } = await t.createKey({ kind: 'publishable', tenantMode: 'fixed', tenantId: 'tn', service: 'web', env: 'prod' } as any);
      const id = key.split('_').slice(2, 4).join('_');
      const { app, state } = buildApp(t);
      expect((await request(app).post(`/telemetry/api/system/keys/${id}/revoke`)).status).toBe(403);
      state.viewer = { tenantId: 'tn', role: 'admin' };
      const res = await request(app).post(`/telemetry/api/system/keys/${id}/revoke`);
      expect(res.body.revoked).toBe(1);
      const doc = await t.models.keys.findById(id).lean() as any;
      expect(doc.revokedAt).toBeTruthy();
    });
  });

  it('answers JSON, not HTML, when a handler throws', async () => {
    const t = buildTelemetry();
    const { app } = buildApp(t, undefined, {
      // sabotage: a subjectAdapter that explodes
      subjectAdapter: { describe: () => { throw new Error('boom'); } },
    });
    const res = await request(app).get('/telemetry/api/subjects/describe?refs=user:u_1');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toBe('internal_error');
  });

  it('serves the SPA shell with injected config at every non-api path, 503 when unbuilt', async () => {
    const t = buildTelemetry();
    const { app } = buildApp(t, undefined, { mountPath: '/telemetry' });
    const res = await request(app).get('/telemetry/some/deep/route');
    // dist/ui exists in this repo (template placeholder build) → 200 with config,
    // or 503 with the human explanation when it has not been built yet
    if (res.status === 200) {
      expect(res.text).toContain('window.__TELEMETRY__');
      expect(res.text).toContain('<base href="/telemetry/"');
    } else {
      expect(res.status).toBe(503);
      expect(res.text).toContain('npm run build');
    }
  });
});
