import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PLATFORM_SCOPE, createDashboard, createIngest, newId } from '../src/server/index.js';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * The tenancy boundary. `Viewer.tenantId === '*'` is a cross-tenant read the
 * host's viewerAdapter authorized; everything else in the package treats '*' as
 * a reserved token that may never be written. Both halves are security
 * properties, so both are asserted here rather than inferred from the code:
 *
 *   - an ordinary viewer cannot reach another tenant through ANY primitive
 *   - a '*' viewer can, and every row it gets back names its tenant
 *   - no write path anywhere can mint '*' as a tenantId
 *   - saved views do NOT fan out under '*' — it is a read scope, not a master key
 *   - scoped() never learned about '*', which is the point of scoped()
 *
 * The leak test drives real HTTP through the dashboard router with two tenants'
 * data present, because that is the shape the leak would actually take.
 */

const TRACE = 'tr_0000abcd';
const RANGE = 'from=2026-06-30T00:00:00Z&to=2026-07-10T00:00:00Z';

/**
 * Both tenants get the SAME traceId and the SAME subject ref. Neither is unique
 * outside a tenant, so this is what a real two-tenant database looks like — and
 * it is the only seeding that can catch a join view that forgot to scope.
 */
async function seedTenant(t: any, tenantId: string, tag: string) {
  const account = [{ type: 'account', id: 'shared' }];
  await t.emit('account.signed_up', {
    tenantId, subjects: account, occurredAt: at('2026-07-01T10:00:00Z'),
    attrs: { source: tag },
  });
  await t.emit('data.first_viewed', {
    tenantId, subjects: account, client: { ...CLIENT },
    occurredAt: at('2026-07-02T10:00:00Z'),
  });
  await t.emit('llm.completion', {
    tenantId, subjects: [{ type: 'org', id: 'shared' }],
    traceId: TRACE, spanId: `s_${tag}`, durationMs: 100,
    occurredAt: at('2026-07-03T09:00:00Z'),
    attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'opus', feature: 'chat' },
    metrics: { tokens_in: 10, tokens_out: 5, cost_usd: 0.02 },
  });
  await t.emit('error.unhandled', {
    tenantId, traceId: TRACE, occurredAt: at('2026-07-03T09:00:01Z'),
    error: { type: 'E', message: 'boom', handled: false, fingerprint: `fp_${tag}` },
  });
}

async function seedBoth() {
  const t = buildTelemetry();
  await t.syncIndexes();
  await seedTenant(t, 'tn_a', 'a');
  await seedTenant(t, 'tn_b', 'b');
  await t.flush();
  return t;
}

function buildApp(t: any, viewer: any = { tenantId: 'tn_a', role: 'member', viewerRef: 'user:u_a' }) {
  const state = { viewer };
  const app = express();
  app.use('/telemetry', createDashboard({
    telemetry: t,
    viewerAdapter: { resolveViewer: () => state.viewer },
  }));
  return { app, state };
}

const TENANT_VIEWER = { tenantId: 'tn_a', role: 'member', viewerRef: 'user:u_a' };
const PLATFORM_VIEWER = { tenantId: PLATFORM_SCOPE, role: 'admin', viewerRef: 'user:u_ops' };

describe('tenancy — the platform scope and the reserved token', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  describe('the leak test — an ordinary viewer cannot reach the other tenant', () => {
    it('no query primitive returns another tenant\'s rows, over real HTTP', async () => {
      const t = await seedBoth();
      const { app } = buildApp(t, TENANT_VIEWER);
      const get = (p: string) => request(app).get(`/telemetry/api/${p}`);

      // records — the obvious one
      const records = await get(`records?${RANGE}`);
      expect(records.status).toBe(200);
      expect(records.body.items.length).toBeGreaterThan(0);
      expect(records.body.items.every((r: any) => r.tenantId === 'tn_a')).toBe(true);

      // series — a count that included tn_b would be silently double
      const series = await get(`series?${RANGE}&name=account.signed_up&interval=day`);
      expect(series.body.buckets.reduce((s: number, b: any) => s + b.value, 0)).toBe(1);

      // distribution — n counts the spans it saw
      const dist = await get(`distribution?${RANGE}&kind=span`);
      expect(dist.body.n).toBe(1);

      // rollups — the aggregate plane is scoped too, or the funnels lie
      const rollups = await get('rollups?as=account.signed_up');
      expect(rollups.body.rows.every((r: any) => r.tenantId === 'tn_a')).toBe(true);
      expect(rollups.body.rows).toHaveLength(1);

      // trace — a shared traceId is the join view's leak
      const trace = await get(`trace/${TRACE}`);
      expect(trace.body.items.every((r: any) => r.tenantId === 'tn_a')).toBe(true);
      expect(trace.body.items).toHaveLength(2); // its own span + error, not four

      // journey — a shared subject ref is the other one
      const journey = await get(`journey/${encodeURIComponent('account:shared')}?${RANGE}`);
      expect(journey.body.records.every((r: any) => r.tenantId === 'tn_a')).toBe(true);
      expect(journey.body.milestones.every((m: any) => m.tenantId === 'tn_a')).toBe(true);
      expect(journey.body.records.length).toBe(2); // signed_up + first_viewed, hers only
    });

    it('nor the System page\'s quarantine — rejects hold RAW payloads', async () => {
      const t = buildTelemetry();
      // an unregistered name quarantines the whole record, verbatim
      await t.emit('nope.not_a_thing', { tenantId: 'tn_a', attrs: { secret: 'a-side' } });
      await t.emit('nope.not_a_thing', { tenantId: 'tn_b', attrs: { secret: 'b-side' } });
      await t.flush();

      const { app, state } = buildApp(t, TENANT_VIEWER);
      const mine = (await request(app).get('/telemetry/api/system')).body.quarantine;
      expect(mine).toHaveLength(1);
      expect(mine[0].raw.tenantId).toBe('tn_a');
      // the payload is the point: this route bypasses the query primitives, so
      // it needs its own scoping or it is a leak that no primitive test catches
      expect(JSON.stringify(mine)).not.toContain('b-side');

      state.viewer = PLATFORM_VIEWER;
      expect((await request(app).get('/telemetry/api/system')).body.quarantine).toHaveLength(2);
    });

    it('a viewer cannot widen its own scope through the query string', async () => {
      const t = await seedBoth();
      const { app } = buildApp(t, TENANT_VIEWER);
      // the scope comes from the viewerAdapter and nowhere else — every one of
      // these is an unknown filter term or an ignored one, never a scope change
      for (const q of ['tenantId=*', 'tenantId=tn_b', 'scope=*', 'tenant=*']) {
        const res = await request(app).get(`/telemetry/api/records?${RANGE}&${q}`);
        expect(res.status).toBe(200);
        expect(res.body.items.every((r: any) => r.tenantId === 'tn_a')).toBe(true);
      }
    });
  });

  describe('the platform scope — a cross-tenant read that stays attributable', () => {
    it('a \'*\' viewer reads every tenant, and every row carries its tenantId', async () => {
      const t = await seedBoth();
      const { app } = buildApp(t, PLATFORM_VIEWER);
      const get = (p: string) => request(app).get(`/telemetry/api/${p}`);

      const records = await get(`records?${RANGE}`);
      expect(new Set(records.body.items.map((r: any) => r.tenantId))).toEqual(new Set(['tn_a', 'tn_b']));

      const rollups = await get('rollups?as=account.signed_up');
      expect(rollups.body.rows).toHaveLength(2);
      expect(new Set(rollups.body.rows.map((r: any) => r.tenantId))).toEqual(new Set(['tn_a', 'tn_b']));

      const trace = await get(`trace/${TRACE}`);
      expect(trace.body.items).toHaveLength(4); // both tenants' span + error
      expect(trace.body.items.every((r: any) => r.tenantId)).toBe(true);

      const journey = await get(`journey/${encodeURIComponent('account:shared')}?${RANGE}`);
      expect(journey.body.records).toHaveLength(4);
      expect(new Set(journey.body.records.map((r: any) => r.tenantId))).toEqual(new Set(['tn_a', 'tn_b']));
      expect(journey.body.milestones.every((m: any) => m.tenantId)).toBe(true);
    });

    it('series and distribution aggregate ACROSS tenants — the platform-wide chart, by design', async () => {
      const t = await seedBoth();
      const { app } = buildApp(t, PLATFORM_VIEWER);
      const series = await request(app)
        .get(`/telemetry/api/series?${RANGE}&name=account.signed_up&interval=day`);
      // one bucket, both tenants summed into it — not one bucket per tenant
      expect(series.body.buckets.reduce((s: number, b: any) => s + b.value, 0)).toBe(2);
      const dist = await request(app).get(`/telemetry/api/distribution?${RANGE}&kind=span`);
      expect(dist.body.n).toBe(2);
    });

    it('the filter terms still apply under \'*\' — it drops the tenant and nothing else', async () => {
      const t = await seedBoth();
      const { app } = buildApp(t, PLATFORM_VIEWER);
      const res = await request(app).get(`/telemetry/api/records?${RANGE}&name=account.signed_up&attrs=source:b`);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].tenantId).toBe('tn_b');
      // the mandatory time range is not relaxed either (traps §18)
      const bad = await request(app).get('/telemetry/api/records?from=2026-07-02&to=2026-07-01');
      expect(bad.status).toBe(400);
    });

    it('the SPA is told its scope, so a cross-tenant number can say so on screen', async () => {
      const t = await seedBoth();
      const { app, state } = buildApp(t, TENANT_VIEWER);
      const tenant = await request(app).get('/telemetry/api/registry');
      expect(tenant.body.platform).toBe(false);
      expect(tenant.body.scope).toBe('tn_a');
      state.viewer = PLATFORM_VIEWER;
      const platform = await request(app).get('/telemetry/api/registry');
      expect(platform.body.platform).toBe(true);
      expect(platform.body.scope).toBe(PLATFORM_SCOPE);
    });
  });

  describe('the reserved token — no write path can mint \'*\'', () => {
    it('emit() refuses it and quarantines, rather than writing a cross-tenant row', async () => {
      const t = buildTelemetry();
      await t.syncIndexes();
      const res = await t.emit('account.signed_up', {
        tenantId: PLATFORM_SCOPE,
        subjects: [{ type: 'account', id: 'a1' }],
        attrs: { source: 'ads' },
      });
      expect(res.outcome).toBe('rejected');
      await t.flush();
      expect(await t.models.telemetry.countDocuments({ tenantId: PLATFORM_SCOPE })).toBe(0);
      expect(await t.models.rollups.countDocuments({ tenantId: PLATFORM_SCOPE })).toBe(0);
      expect(t.counters.rejected).toBe(1); // never a silent drop
      const [reject] = await t.collections.rejects().find({}).toArray();
      expect(reject!.reason).toMatch(/reserved/i); // and the reason names the reservation
    });

    it('forget() refuses it — erasure across every tenant is not one typo away', async () => {
      const t = buildTelemetry();
      await expect(t.forget(PLATFORM_SCOPE, 'user:u_1')).rejects.toThrow(/reserved/i);
    });

    it('createKey() refuses a fixed-mode key on it — a key IS its tenantId', async () => {
      const t = buildTelemetry();
      await expect(t.createKey({
        kind: 'secret', tenantMode: 'fixed', tenantId: PLATFORM_SCOPE, service: 'web', env: 'prod',
      } as any)).rejects.toThrow(/reserved/i);
      expect(await t.models.keys.countDocuments({})).toBe(0);
    });

    it('the ingest path cannot CLAIM it — a claim is not a fact, and \'*\' is not a tenant', async () => {
      const t = buildTelemetry();
      await t.syncIndexes();
      const { key } = await t.createKey({
        kind: 'secret', tenantMode: 'claimed', service: 'api', env: 'prod',
      } as any);
      const app = express();
      app.use('/ingest', createIngest({ telemetry: t } as any));
      const res = await request(app)
        .post('/ingest')
        .set('authorization', `Bearer ${key}`)
        .send({
          sentAt: new Date().toISOString(),
          context: { tenantId: PLATFORM_SCOPE },
          records: [{ _id: newId(), name: 'app.ping', occurredAt: new Date().toISOString() }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('reserved_tenant'); // sk_ callers are programmers
      expect(await t.models.telemetry.countDocuments({})).toBe(0);
    });

    it('nor can a host contextAdapter hand it one — session mode is guarded too, and pk_ still never 4xxes', async () => {
      const t = buildTelemetry();
      await t.syncIndexes();
      const { key } = await t.createKey({
        kind: 'publishable', tenantMode: 'session', service: 'web', env: 'prod',
      } as any);
      const app = express();
      app.use('/ingest', createIngest({
        telemetry: t,
        // a host whose session resolution went wrong, or was talked into it
        contextAdapter: { resolveContext: () => ({ tenantId: PLATFORM_SCOPE }) },
      } as any));
      const res = await request(app)
        .post('/ingest')
        .set('authorization', `Bearer ${key}`)
        .send({
          sentAt: new Date().toISOString(),
          records: [{ _id: newId(), name: 'app.ping', occurredAt: new Date().toISOString() }],
        });
      expect(res.status).toBe(202); // traps §19 — a browser console never sees this
      expect(res.body).toEqual({ accepted: 0, rejected: 1 });
      expect(await t.models.telemetry.countDocuments({})).toBe(0);
      expect(t.counters.rejected).toBe(1); // dropped, but counted
    });
  });

  describe('saved views — \'*\' is a read scope, not a master key', () => {
    it('a platform viewer\'s view is invisible to a tenant viewer, and vice versa', async () => {
      const t = buildTelemetry();
      const { app, state } = buildApp(t, PLATFORM_VIEWER);
      const platformPrivate = await request(app).post('/telemetry/api/views')
        .send({ spec: { name: 'platform-private', page: 'events', query: {} } });
      await request(app).post('/telemetry/api/views')
        .send({ spec: { name: 'platform-shared', page: 'events', query: {} }, shared: true });

      state.viewer = TENANT_VIEWER;
      const tenantPrivate = await request(app).post('/telemetry/api/views')
        .send({ spec: { name: 'tenant-private', page: 'events', query: {} } });
      const asTenant = (await request(app).get('/telemetry/api/views')).body.views.map((v: any) => v.name);
      expect(asTenant).toContain('tenant-private');
      expect(asTenant).not.toContain('platform-private');
      // not even the SHARED one — shared means "to this scope", and '*' is a
      // scope of its own, not the union of every tenant's saved state
      expect(asTenant).not.toContain('platform-shared');

      state.viewer = PLATFORM_VIEWER;
      const asPlatform = (await request(app).get('/telemetry/api/views')).body.views.map((v: any) => v.name);
      expect(asPlatform).toContain('platform-private');
      expect(asPlatform).toContain('platform-shared');
      expect(asPlatform).not.toContain('tenant-private');

      void platformPrivate;
      void tenantPrivate;
    });

    it('neither can delete the other\'s — the ownership lookup matches the scope literally', async () => {
      const t = buildTelemetry();
      const { app, state } = buildApp(t, PLATFORM_VIEWER);
      const platformView = await request(app).post('/telemetry/api/views')
        .send({ spec: { name: 'platform-target', page: 'events', query: {} }, shared: true });

      state.viewer = TENANT_VIEWER;
      const tenantView = await request(app).post('/telemetry/api/views')
        .send({ spec: { name: 'tenant-target', page: 'events', query: {} }, shared: true });

      // a tenant viewer — even an admin one — cannot reach the platform view
      state.viewer = { tenantId: 'tn_a', role: 'admin', viewerRef: 'user:u_a_admin' };
      expect((await request(app).delete(`/telemetry/api/views/${platformView.body.id}`)).body.removed).toBe(0);

      // and the platform viewer's role: 'admin' is admin OF the platform scope
      state.viewer = PLATFORM_VIEWER;
      expect((await request(app).delete(`/telemetry/api/views/${tenantView.body.id}`)).body.removed).toBe(0);

      const views = t.models.telemetry.db.collection(
        `${t.models.telemetry.collection.collectionName}_views`,
      );
      expect(await views.countDocuments({})).toBe(2); // both still there

      // each can still delete its own
      expect((await request(app).delete(`/telemetry/api/views/${platformView.body.id}`)).body.removed).toBe(1);
      state.viewer = TENANT_VIEWER;
      expect((await request(app).delete(`/telemetry/api/views/${tenantView.body.id}`)).body.removed).toBe(1);
    });
  });

  describe('erasing a person who used the cross-tenant dashboard', () => {
    /** saves one private and one shared view as `owner`, in `scope` */
    const seedViews = async (t: any, scope: string, owner: string) => {
      const { app, state } = buildApp(t, { tenantId: scope, role: 'admin', viewerRef: owner });
      state.viewer = { tenantId: scope, role: 'admin', viewerRef: owner };
      await request(app).post('/telemetry/api/views')
        .send({ spec: { name: `${owner}-private-in-${scope}`, page: 'events', query: {} } });
      await request(app).post('/telemetry/api/views')
        .send({ spec: { name: `${owner}-shared-in-${scope}`, page: 'events', query: {} }, shared: true });
      return t.models.telemetry.db.collection(
        `${t.models.telemetry.collection.collectionName}_views`,
      );
    };

    it('by default, forget() leaves the platform-scoped ones — the stated bound', async () => {
      const t = buildTelemetry();
      const views = await seedViews(t, PLATFORM_SCOPE, 'user:u_ops');
      await seedViews(t, 'tn_a', 'user:u_ops');

      const gone = await t.forget('tn_a', 'user:u_ops');
      expect(gone.views).toBe(2); // the home tenant's pair only

      // still there, still owned by them — incomplete erasure, on purpose,
      // because the package cannot know that 'user:u_ops' is one person
      expect(await views.countDocuments({ tenantId: PLATFORM_SCOPE, ownerRef: 'user:u_ops' })).toBe(2);
    });

    it('globalSubjectRefs reaches them — the host asserting a ref is one party everywhere', async () => {
      const t = buildTelemetry({ globalSubjectRefs: true });
      const views = await seedViews(t, PLATFORM_SCOPE, 'user:u_ops');
      await seedViews(t, 'tn_a', 'user:u_ops');

      const gone = await t.forget('tn_a', 'user:u_ops');
      expect(gone.views).toBe(4); // both scopes, both pairs

      // private ones deleted outright; shared ones survive with the owner link
      // rekeyed — the same delete-vs-redact rule the rows follow
      expect(await views.countDocuments({ ownerRef: 'user:u_ops' })).toBe(0);
      const survivors = await views.find({ tenantId: PLATFORM_SCOPE }).toArray();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]!.spec.name).toBe('user:u_ops-shared-in-*');
      expect(survivors[0]!.ownerRef).toMatch(/^user:redacted_/);
    });

    it('it is bounded by the REF, never by the tenant — another owner\'s views are untouched', async () => {
      const t = buildTelemetry({ globalSubjectRefs: true });
      const views = await seedViews(t, PLATFORM_SCOPE, 'user:u_ops');
      await seedViews(t, PLATFORM_SCOPE, 'user:u_other');

      await t.forget('tn_a', 'user:u_ops');

      // the flag widens WHICH SCOPES are searched, not whose views match. A
      // second platform user is a bystander, not collateral.
      expect(await views.countDocuments({ ownerRef: 'user:u_other' })).toBe(2);
    });

    it('still refuses \'*\' as the erasure SCOPE — widening reach is not widening blast radius', async () => {
      const t = buildTelemetry({ globalSubjectRefs: true });
      await expect(t.forget(PLATFORM_SCOPE, 'user:u_ops')).rejects.toThrow(/reserved/);
    });
  });

  it('scoped(\'*\') scopes to the LITERAL string and returns nothing — it is not an escape hatch', async () => {
    const t = await seedBoth();
    // scoped() is the unconditional isolation primitive: whatever string goes
    // in, only rows carrying that string come out. '*' is reserved on the write
    // side, so no row carries it, so this is empty — never "everything".
    expect(await t.scoped(PLATFORM_SCOPE).find().lean()).toEqual([]);
    expect(await t.scoped(PLATFORM_SCOPE).rollups().lean()).toEqual([]);
    expect(await t.scoped(PLATFORM_SCOPE).aggregate([{ $count: 'n' }])).toEqual([]);
    expect(await t.scoped(PLATFORM_SCOPE).rollupAggregate([{ $count: 'n' }])).toEqual([]);
    // the control: a real tenant still works, so the emptiness above is the
    // scope doing its job and not a broken query
    expect((await t.scoped('tn_a').find().lean()).length).toBeGreaterThan(0);
  });
});
