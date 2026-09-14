import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  PLATFORM_SCOPE, createDashboard, createQueries, defineRegistry, deriveCatalog, resolveReport,
  type Report,
} from '../src/server/index.js';
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
    expect(res.body.truncated).toBe(false); // one span, nowhere near the ceiling
    expect(res.body.dataSource).toBe('raw');
  });

  it('distribution SAYS it hit the scan ceiling — an undercount nobody mentions is the silent cap', async () => {
    // `$percentile` is method:'approximate' over a bounded scan. The sample is
    // complete only while the match fits under the ceiling; past it the number
    // is a lower bound, and this used to be the one capped primitive that did
    // not report that.
    const t = buildTelemetry();
    await t.syncIndexes();
    for (let i = 0; i < 4; i++) {
      await t.emit('llm.completion', {
        tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }],
        traceId: `tr_0000abc${i}`, spanId: `s${i}`, durationMs: 100 * (i + 1),
        occurredAt: at(`2026-07-0${i + 1}T09:00:00Z`),
        attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'opus', feature: 'chat' },
        metrics: { tokens_in: 10, tokens_out: 5, cost_usd: 0.02 },
      });
    }
    await t.flush();

    const full = await request(buildApp(t).app).get(`/telemetry/api/distribution?${RANGE}&kind=span`);
    expect(full.body.n).toBe(4);
    expect(full.body.truncated).toBe(false);

    // same data, a ceiling of two: the scan reads cap+1 and observes the overflow
    const { app } = buildApp(t, undefined, { queryLimits: { distribution: 2 } });
    const cut = await request(app).get(`/telemetry/api/distribution?${RANGE}&kind=span`);
    expect(cut.status).toBe(200);
    expect(cut.body.truncated).toBe(true);
    expect(cut.body.n).toBeLessThan(4); // and the response says the count is short
    expect(cut.body.histogram.length).toBeGreaterThan(0);
  });

  it('an empty distribution still carries truncated — a key you must check for is a key you infer', async () => {
    const t = buildTelemetry();
    const { app } = buildApp(t);
    const res = await request(app).get(`/telemetry/api/distribution?${RANGE}&kind=span`);
    expect(res.body.n).toBe(0);
    expect(res.body.p95).toBeUndefined(); // a p95 of zero is a claim; absence is not
    expect(res.body.truncated).toBe(false);
  });

  it('/rollups forwards `on` — firstAt selects the cohort, the default lastAt selects the latest occurrence', async () => {
    // the read fix that shipped unreachable: `on` existed on the primitive and
    // the only surface that matters never forwarded it
    const t = buildTelemetry();
    const signup = (id: string, iso: string) => t.emit('account.signed_up', {
      tenantId: 'tn', subjects: [{ type: 'account', id }], occurredAt: at(iso),
      attrs: { source: 'organic' },
    });
    await signup('a0', '2026-07-01T00:00:00Z'); // joined IN the window…
    await t.flush(); // the second increment must land AFTER the upsert, not race it
    await signup('a0', '2026-07-20T00:00:00Z'); // …and re-emitted after it
    await signup('a1', '2026-07-20T00:00:00Z'); // joined after the window
    await t.flush();
    const { app } = buildApp(t);

    // the default filters lastAt, so the account that actually joined in the
    // window is invisible — correct for "who was active", wrong for a cohort
    const byLast = await request(app).get(`/telemetry/api/rollups?as=account.signed_up&${RANGE}`);
    expect(byLast.status).toBe(200);
    expect(byLast.body.rows).toHaveLength(0);

    const byFirst = await request(app).get(`/telemetry/api/rollups?as=account.signed_up&on=firstAt&${RANGE}`);
    expect(byFirst.body.rows.map((r: any) => r.dims[0])).toEqual(['account:a0']);

    // an unrecognised field would range-filter on something that does not exist
    // and return an empty family, which reads exactly like "no data"
    const bad = await request(app).get(`/telemetry/api/rollups?as=account.signed_up&on=createdAt&${RANGE}`);
    expect(bad.status).toBe(400);
  });

  it('/rollups reads N subjects in one call via repeated dims params, bounded and typed', async () => {
    const t = buildTelemetry();
    await seed(t); // a0…a4 signed up
    const { app } = buildApp(t);
    const dim = (id: string) => `dims=${encodeURIComponent(`account:${id}`)}`;

    const many = await request(app).get(`/telemetry/api/rollups?as=account.signed_up&${dim('a0')}&${dim('a2')}`);
    expect(many.status).toBe(200);
    expect(many.body.rows.map((r: any) => r.dims[0]).sort()).toEqual(['account:a0', 'account:a2']);

    // one value is still one value — the single-dim URLs that exist keep working
    const one = await request(app).get(`/telemetry/api/rollups?as=account.signed_up&${dim('a1')}`);
    expect(one.body.rows.map((r: any) => r.dims[0])).toEqual(['account:a1']);

    // an unbounded $in from a URL is a scan wearing a filter's clothes
    const tooMany = await request(app).get(
      `/telemetry/api/rollups?as=account.signed_up&${Array.from({ length: 101 }, (_, i) => dim(`a${i}`)).join('&')}`,
    );
    expect(tooMany.status).toBe(400);
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

  it('the same boot call carries the derived catalog beside the projection', async () => {
    const t = buildTelemetry();
    const { app } = buildApp(t);
    const res = await request(app).get('/telemetry/api/registry');
    const facet = res.body.catalog.events['llm.completion'];
    // a page asks the catalog which measures exist rather than naming one
    const spend = facet.measures.find((m: any) => m.key === 'sum:cost_usd');
    expect(spend).toBeTruthy();
    expect(spend.exactVia).toEqual(['llm_cost']); // the family that answers it exactly
    expect(facet.dims.map((d: any) => d.key)).toContain('attr:gen_ai_request_model');
    expect(res.body.catalog.envelope.map((d: any) => d.key)).toContain('field:client.platform');
    expect(res.body.catalog.families.activity.feeders).toContain('data.first_viewed');
  });

  describe('views', () => {
    it('derives Reports — per event, family, namespace, meter and subject type; saved shadows by name', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const before = await request(app).get('/telemetry/api/views');
      const by = (name: string) => before.body.views.find((v: any) => v.name === name);

      // every derived view is a Report now — `query.source` is what says so, and
      // it is what makes a sidebar link and a saved view the same object
      const derived = by('error.unhandled');
      expect(derived).toMatchObject({
        origin: 'derived', page: 'errors', query: { source: { event: 'error.unhandled' }, range: '7d' },
      });
      expect(by('rollup: llm_cost')).toMatchObject({ query: { source: { family: 'llm_cost' } } });
      expect(by('namespace: account')).toMatchObject({
        page: 'explore', query: { source: { namespace: 'account' }, groupBy: ['field:name'] },
      });
      expect(by('spend: billing.ai_tokens')).toMatchObject({ page: 'usage', query: { measure: 'sum:cost_usd' } });
      expect(by('funnel: account')).toMatchObject({
        page: 'journeys',
        query: { measure: 'funnel', subjectType: 'account', stages: ['account.signed_up', 'data.first_viewed', 'account.converted'] },
      });
      // and each of them is a URL the report route actually answers
      const run = await request(app).get(
        `/telemetry/api/report?source=family:llm_cost&range=30d`,
      );
      expect(run.status).toBe(200);
      expect(run.body.plan.exactness).toBe('exact');

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

    it('reads the same counters the other way round — suggestions name the registry line that is missing', async () => {
      // reports §9: the page stops making the operator guess. Both sources are
      // already on this response, so the derivation costs no extra read.
      const t = buildTelemetry();
      await seed(t);
      // an attr nobody declared, and a name nobody registered
      await t.emit('account.signed_up', {
        tenantId: 'tn', subjects: [{ type: 'account', id: 'a9' }],
        occurredAt: at('2026-07-06T10:00:00Z'), attrs: { source: 'ads', codec: 'h264' } as any,
      });
      await t.emit('video.exported' as any, { tenantId: 'tn', occurredAt: at('2026-07-06T10:01:00Z') });
      await t.flush();

      const { app } = buildApp(t);
      const res = await request(app).get('/telemetry/api/system');
      expect(res.body.counters.undeclaredAttrs['account.signed_up|codec']).toBe(1);

      const attr = res.body.suggestions.find((s: any) => s.kind === 'undeclared_attr');
      expect(attr).toMatchObject({ target: 'account.signed_up', key: 'codec', count: 1 });
      expect(attr.message).toContain('not declared');
      expect(attr.fix).toBe('codec: z.string().max(64),'); // pasteable, not prose

      const unreg = res.body.suggestions.find((s: any) => s.kind === 'unregistered_event');
      expect(unreg.target).toBe('video.exported');
      expect(unreg.fix).toContain("kind: 'event'");
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

  // ── breakdown: the cap is on GROUPS, never on the scan (reports §6) ──
  describe('breakdown', () => {
    /**
     * Five plan values with five DISTINCT counts, so "the top three" is an
     * unambiguous assertion; platform and day alternate inside each plan so the
     * same rows answer the two-dim and the interval cases. Plus three priced
     * spans and one unpriced one — the missing-metric case has to live in the
     * SAME group as present ones or it proves nothing.
     */
    const PLANS: Array<readonly [string, number]> = [
      ['enterprise', 5], ['pro', 4], ['free', 3], ['team', 2], ['solo', 1],
    ];

    async function seedDims(t: Awaited<ReturnType<typeof buildTelemetry>>) {
      await t.syncIndexes();
      let u = 0;
      for (const [plan, n] of PLANS) {
        for (let k = 0; k < n; k++) {
          await t.emit('billing.plan_selected', {
            tenantId: 'tn',
            subjects: [{ type: 'user', id: `u_${u++}` }, { type: 'account', id: 'a0' }],
            client: { ...CLIENT, platform: k % 2 ? 'ios' : 'web' },
            occurredAt: at(k % 2 ? '2026-07-02T10:00:00Z' : '2026-07-01T10:00:00Z'),
            attrs: { plan },
          });
        }
      }
      const llm = (model: string, cost: number, iso: string, span: string) =>
        t.emit('llm.completion', {
          tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }],
          traceId: 'tr_0000bbbb', spanId: span, durationMs: 100, occurredAt: at(iso),
          attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: model, feature: 'chat' },
          metrics: { tokens_in: 1, tokens_out: 1, cost_usd: cost },
        });
      await llm('opus', 2, '2026-07-01T09:00:00Z', 's1');
      await llm('opus', 4, '2026-07-02T09:00:00Z', 's2');
      await llm('sonnet', 5, '2026-07-01T09:30:00Z', 's3');
      // a span with no cost_usd at all — same kind, same range, different metric
      await t.emit('ledger.charge', {
        tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }],
        traceId: 'tr_0000bbbb', spanId: 's4', durationMs: 5,
        occurredAt: at('2026-07-01T09:45:00Z'), metrics: { amount_usd: 9 },
      });
      // an event carrying no `plan` at all — the null group
      await t.emit('app.ping', {
        tenantId: 'tn', client: { ...CLIENT }, occurredAt: at('2026-07-01T12:00:00Z'),
      });
      // another tenant, same plan — invisible under 'tn', summed under '*'
      for (let k = 0; k < 3; k++) {
        await t.emit('billing.plan_selected', {
          tenantId: 'other',
          subjects: [{ type: 'user', id: `x_${k}` }, { type: 'account', id: 'ax' }],
          client: { ...CLIENT }, occurredAt: at('2026-07-01T10:00:00Z'),
          attrs: { plan: 'pro' },
        });
      }
      await t.flush();
    }

    const PLAN_ROWS = `${RANGE}&name=billing.plan_selected&groupBy=attr:plan`;

    it('groups one attr, orders by measure, and reports groups/truncated/dataSource', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const { app } = buildApp(t);
      const res = await request(app).get(`/telemetry/api/breakdown?${PLAN_ROWS}`);
      expect(res.status).toBe(200);
      expect(res.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([
        ['enterprise', 5], ['pro', 4], ['free', 3], ['team', 2], ['solo', 1],
      ]);
      expect(res.body.groups).toBe(5);
      expect(res.body.truncated).toBe(false);
      expect(res.body.dataSource).toBe('raw');
      expect(res.body.rows[0].at).toBeUndefined(); // no interval, no time axis
    });

    it('groups two dimensions into tuples, envelope paths included', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const { app } = buildApp(t);
      const res = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&name=billing.plan_selected&groupBy=attr:plan,field:client.platform`,
      );
      expect(res.status).toBe(200);
      const byTuple = Object.fromEntries(res.body.rows.map((r: any) => [r.dims.join('/'), r.value]));
      expect(byTuple['enterprise/web']).toBe(3);
      expect(byTuple['enterprise/ios']).toBe(2);
      expect(byTuple['solo/web']).toBe(1);
      expect(byTuple['solo/ios']).toBeUndefined();
      expect(res.body.groups).toBe(9);

      // subjectType reads the type prefix off the most specific subject ref
      const st = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&kind=span&groupBy=subjectType`,
      );
      expect(st.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([['org', 4]]);
    });

    // Every client SDK puts `anon` and `session` FIRST. Grouping on the first
    // key filed every desktop record under `anon` — 93% of machine-subject
    // records were invisible under subjectType=machine, which read as "the
    // desktop app sends nothing".
    it('groups subjectType by the most specific subject, not the SDK-prepended anon', async () => {
      const t = buildTelemetry({
        registry: defineRegistry({
          'desktop.opened': {
            kind: 'event', origin: 'any', subjects: ['anon', 'session', 'machine'],
            description: 'desktop client record — anon/session prepended by the SDK',
          },
          'web.viewed': {
            kind: 'event', origin: 'any', subjects: ['anon', 'session'],
            description: 'pre-identity web record — nothing more specific than anon',
          },
          'user.acted': {
            kind: 'event', origin: 'any', subjects: ['user'],
            description: 'a single-subject record',
          },
        }),
      });
      await t.syncIndexes();
      const generic = (n: number) => [{ type: 'anon', id: `an${n}` }, { type: 'session', id: `se${n}` }];
      const when = at('2026-07-01T10:00:00Z');
      for (let i = 0; i < 3; i++) {
        await t.emit('desktop.opened', {
          tenantId: 'tn', subjects: [...generic(i), { type: 'machine', id: `m${i}` }], occurredAt: when,
        });
      }
      for (let i = 0; i < 2; i++) {
        await t.emit('web.viewed', { tenantId: 'tn', subjects: generic(10 + i), occurredAt: when });
      }
      await t.emit('user.acted', { tenantId: 'tn', subjects: [{ type: 'user', id: 'u1' }], occurredAt: when });
      // another tenant's machines — must not leak into tn's machine group
      for (let i = 0; i < 5; i++) {
        await t.emit('desktop.opened', {
          tenantId: 'other', subjects: [...generic(20 + i), { type: 'machine', id: `x${i}` }], occurredAt: when,
        });
      }
      await t.flush();

      const { app } = buildApp(t);
      const res = await request(app).get(`/telemetry/api/breakdown?${RANGE}&groupBy=subjectType`);
      expect(res.status).toBe(200);
      expect(res.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([
        ['machine', 3], ['anon', 2], ['user', 1],
      ]);
    });

    it('sums and averages a metric — $sum treats a missing one as 0, $avg ignores the row', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const { app } = buildApp(t);
      const perModel = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&kind=span&groupBy=attr:gen_ai_request_model&measure=sum:cost_usd`,
      );
      expect(perModel.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([
        ['opus', 6], ['sonnet', 5], [null, 0], // the ledger span declares no model
      ]);

      // one group holding four spans, three of which carry cost_usd
      const sum = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&kind=span&groupBy=field:kind&measure=sum:cost_usd`,
      );
      expect(sum.body.rows).toEqual([{ dims: ['span'], value: 11 }]);
      const avg = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&kind=span&groupBy=field:kind&measure=avg:cost_usd`,
      );
      expect(avg.body.rows[0].value).toBeCloseTo(11 / 3, 10); // not 11/4
    });

    it('an interval splits each top group by bucket, rows ordered by `at`', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const { app } = buildApp(t);
      const res = await request(app).get(`/telemetry/api/breakdown?${PLAN_ROWS}&interval=day`);
      expect(res.status).toBe(200);
      expect(res.body.groups).toBe(5); // groups counts GROUPS, not rows
      const ent = res.body.rows.filter((r: any) => r.dims[0] === 'enterprise');
      expect(ent.map((r: any) => r.value)).toEqual([3, 2]); // two days, ascending
      expect(ent.map((r: any) => r.at)).toEqual([
        '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
      ]);
      // solo only ever happened once, so it contributes one row, not a zero-fill
      expect(res.body.rows.filter((r: any) => r.dims[0] === 'solo')).toHaveLength(1);
      const ats = res.body.rows.map((r: any) => r.at);
      expect([...ats].sort()).toEqual(ats);
      expect(res.body.bucketsTruncated).toBe(false);

      // the per-bucket pass has a ceiling of its own — buckets × groups — and
      // it says so rather than dropping periods of a group it DID return
      const { app: tight } = buildApp(t, undefined, { queryLimits: { series: 1 } });
      const cut = await request(tight).get(`/telemetry/api/breakdown?${PLAN_ROWS}&interval=day`);
      expect(cut.body.bucketsTruncated).toBe(true);
      expect(cut.body.truncated).toBe(false); // every GROUP still came back
      expect(cut.body.rows.length).toBe(5);
    });

    it('a record missing the attr is a null group, never a dropped row', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const { app } = buildApp(t);
      const res = await request(app).get(`/telemetry/api/breakdown?${RANGE}&kind=event&groupBy=attr:plan`);
      expect(res.body.groups).toBe(6); // the five plans plus "none"
      expect(res.body.rows.find((r: any) => r.dims[0] === null)).toEqual({ dims: [null], value: 1 });
      const total = res.body.rows.reduce((s: number, r: any) => s + r.value, 0);
      expect(total).toBe(16); // 15 plan_selected + the one app.ping
    });

    it('truncates on GROUPS and keeps the top ones by measure; queryLimits clamps the ask', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const cut = await request(buildApp(t).app).get(`/telemetry/api/breakdown?${PLAN_ROWS}&limit=3`);
      expect(cut.body.groups).toBe(3);
      expect(cut.body.truncated).toBe(true);
      expect(cut.body.rows.map((r: any) => r.dims[0])).toEqual(['enterprise', 'pro', 'free']);

      // the ask is a preference, the configured cap is the contract
      const { app } = buildApp(t, undefined, { queryLimits: { breakdown: 2 } });
      const clamped = await request(app).get(`/telemetry/api/breakdown?${PLAN_ROWS}&limit=10`);
      expect(clamped.body.groups).toBe(2);
      expect(clamped.body.truncated).toBe(true);
      expect(clamped.body.rows.map((r: any) => r.dims[0])).toEqual(['enterprise', 'pro']);
    });

    it('scopes to the tenant; the platform scope sums the same group across tenants', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const mine = await request(buildApp(t).app).get(`/telemetry/api/breakdown?${PLAN_ROWS}`);
      expect(mine.body.rows.find((r: any) => r.dims[0] === 'pro').value).toBe(4); // not 7

      const platform = buildApp(t, { tenantId: PLATFORM_SCOPE, role: 'admin' });
      const all = await request(platform.app).get(`/telemetry/api/breakdown?${PLAN_ROWS}`);
      expect(all.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([
        ['pro', 7], ['enterprise', 5], ['free', 3], ['team', 2], ['solo', 1],
      ]);
    });

    it('respects the customer toggle — an excluded actor type leaves no group behind', async () => {
      const t = buildTelemetry();
      await seed(t); // data.first_viewed carries actor user:u_0; the signups carry none
      const { app } = buildApp(t);
      const all = await request(app).get(`/telemetry/api/breakdown?${RANGE}&kind=event&groupBy=field:name`);
      expect(all.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([
        ['account.signed_up', 5], ['data.first_viewed', 1],
      ]);
      const customers = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&kind=event&groupBy=field:name&excludeActors=user`,
      );
      expect(customers.body.rows.map((r: any) => r.dims[0])).toEqual(['account.signed_up']);
      expect(customers.body.groups).toBe(1);

      // actorType groups the same rows by who did them, absent actor included
      const byActor = await request(app).get(`/telemetry/api/breakdown?${RANGE}&kind=event&groupBy=actorType`);
      expect(byActor.body.rows.map((r: any) => [r.dims[0], r.value])).toEqual([[null, 5], ['user', 1]]);
    });

    it('refuses an ungroupable path, too many dims, none at all, and a bad interval', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const { app } = buildApp(t);
      const get = (qs: string) => request(app).get(`/telemetry/api/breakdown?${RANGE}&${qs}`);

      // a $group on free-form user content is an unbounded scan of exactly the
      // payloads the rest of the package keeps out of aggregates
      const payload = await get('groupBy=field:data.secret');
      expect(payload.status).toBe(400);
      expect(payload.body.error).toMatch(/not groupable/);
      expect(payload.body.error).toMatch(/client\.platform/); // the message lists what IS allowed

      expect((await get('groupBy=attr:a,attr:b,attr:c')).status).toBe(400);
      expect((await get('groupBy=')).status).toBe(400);
      expect((await get('groupBy=nonsense')).status).toBe(400);
      const badInterval = await get('groupBy=attr:plan&interval=fortnight');
      expect(badInterval.status).toBe(400);
      expect(badInterval.body.error).toMatch(/interval must be one of/);
    });

    it('rejects an invalid range like every other range-bound primitive', async () => {
      const t = buildTelemetry();
      const { app } = buildApp(t);
      const res = await request(app).get(
        '/telemetry/api/breakdown?from=2026-07-02&to=2026-07-01&groupBy=attr:plan',
      );
      expect(res.status).toBe(400);
    });

    it('memoizes an identical read inside the TTL', async () => {
      const t = buildTelemetry();
      await seedDims(t);
      const q = createQueries({
        TelemetryModel: t.models.telemetry,
        RollupModel: t.models.rollups,
        registry: t.registry,
      });
      const range = { from: at('2026-06-30T00:00:00Z'), to: at('2026-07-10T00:00:00Z') };
      const first = await q.breakdown('tn', range, {}, { groupBy: ['attr:plan'] });
      const second = await q.breakdown('tn', range, {}, { groupBy: ['attr:plan'] });
      expect(second).toBe(first); // same promise, same object — not a re-read
      const other = await q.breakdown('tn', range, {}, { groupBy: ['attr:plan'], interval: 'day' });
      expect(other).not.toBe(first); // the key covers every argument
    });

    // ── /values: the lookup that turns free text into a picker (reports §5) ──
    // Nested here for `seedDims`: its five plans with five distinct counts are
    // exactly the fixture a values picker needs, and duplicating it to hoist
    // these two cases out one level would be the only reason to.
    describe('values', () => {
      it('needs a dim, and answers with the source it used', async () => {
        const t = buildTelemetry();
        await seedDims(t);
        const { app } = buildApp(t);

        const missing = await request(app).get(`/telemetry/api/values?${RANGE}`);
        expect(missing.status).toBe(400);
        expect(missing.body.error).toMatch(/dim required/);

        // the registry already declared this domain — no read, no range needed
        const kinds = await request(app).get('/telemetry/api/values?dim=field:kind');
        expect(kinds.status).toBe(200);
        expect(kinds.body).toMatchObject({ source: 'catalog', truncated: false });
        expect(kinds.body.values).toEqual(['event', 'error', 'span', 'state', 'usage']);

        // an indexed attr with no family, over a range, counted
        const plans = await request(app).get(
          `/telemetry/api/values?${RANGE}&dim=attr:plan&names=billing.plan_selected`,
        );
        expect(plans.body.source).toBe('raw');
        expect(plans.body.values).toEqual(['enterprise', 'pro', 'free', 'team', 'solo']);
        expect(plans.body.counts).toEqual([5, 4, 3, 2, 1]);

        // a family answers it exactly, and says which one. `names` is the
        // Report's source events, so the family picked is one they FEED —
        // without it `spend` would win on dim count and answer about a meter
        // this page never asked about
        const models = await request(app).get(
          '/telemetry/api/values?dim=attr:gen_ai_request_model&names=llm.completion',
        );
        expect(models.body).toMatchObject({ source: 'rollups', via: 'llm_cost' });
        expect(models.body.values.sort()).toEqual(['opus', 'sonnet']);

        // nothing can answer it cheaply — and that is a 200, not a 400: the
        // caller's fallback is a text box with a scan badge
        const none = await request(app).get(
          `/telemetry/api/values?${RANGE}&dim=attr:source&names=account.signed_up`,
        );
        expect(none.status).toBe(200);
        expect(none.body).toMatchObject({ source: 'none', values: [], truncated: false });
      });

      it('clamps the ask to queryLimits.values and reports truncation', async () => {
        const t = buildTelemetry();
        await seedDims(t);
        const { app } = buildApp(t, undefined, { queryLimits: { values: 2 } });
        const res = await request(app).get(
          `/telemetry/api/values?${RANGE}&dim=attr:plan&names=billing.plan_selected&limit=999`,
        );
        expect(res.body.values).toEqual(['enterprise', 'pro']);
        expect(res.body.truncated).toBe(true);
      });
    });
  });

  /**
   * The positional-args contract (reports §6). `Plan.args` claims it spreads
   * straight into the named primitive, and a plan that cannot be called is a
   * plan that lies — so every primitive the resolver can name is built here and
   * executed against a real database. The assertion is `dataSource`, not the
   * numbers: this proves the CALL, and report.test.ts proves the planning.
   */
  describe('report plans execute', () => {
    const RANGE_PAIR = { from: '2026-06-30T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z' };
    const cases: Array<[string, Report, string]> = [
      // page.view feeds no family, so nothing exact stands in front of the rows
      ['records', { source: { event: 'page.view' }, range: RANGE_PAIR }, 'raw'],
      ['series', { source: { event: 'account.signed_up' }, range: RANGE_PAIR, measure: 'count', interval: 'day' }, 'raw'],
      [
        'breakdown',
        {
          source: { event: 'account.signed_up' }, range: RANGE_PAIR,
          groupBy: ['attr:source'], measure: 'count',
        },
        'raw',
      ],
      ['distribution', { source: { event: 'llm.completion' }, range: RANGE_PAIR, measure: 'p95:cost_usd' }, 'raw'],
      [
        'rollups',
        {
          source: { family: 'llm_cost' }, range: RANGE_PAIR, interval: 'day',
          groupBy: ['attr:gen_ai_request_model'], measure: 'sum:cost_usd',
        },
        'rollups',
      ],
      [
        'distinctCount',
        { source: { event: 'account.signed_up' }, range: RANGE_PAIR, measure: 'distinct:account' },
        'rollups',
      ],
      [
        'funnel',
        {
          source: { event: 'account.signed_up' }, range: RANGE_PAIR, measure: 'funnel',
          stages: ['account.signed_up', 'data.first_viewed', 'account.converted'],
        },
        'rollups',
      ],
    ];

    it('spreads every plan straight into the primitive it names', async () => {
      const t = buildTelemetry();
      await seed(t);
      const catalog = deriveCatalog(t.registry);
      const q = createQueries({
        TelemetryModel: t.models.telemetry,
        RollupModel: t.models.rollups,
        registry: t.registry,
      });
      const seen: string[] = [];
      for (const [primitive, report, dataSource] of cases) {
        const plan = resolveReport(report, catalog);
        if ('unavailable' in plan) throw new Error(`${primitive}: ${plan.why}`);
        expect(plan.primitive, JSON.stringify(report)).toBe(primitive);
        // the contract, verbatim — no per-primitive adapter stands here
        const result: any = await (q as any)[plan.primitive]('tn', ...plan.args);
        expect(result.dataSource, primitive).toBe(dataSource);
        seen.push(plan.primitive);
      }
      expect(new Set(seen).size).toBe(7);
    });
  });

  /**
   * `GET /api/report` — the Report as a URL, executed. The plans themselves are
   * pinned without Mongo in report.test.ts; what is proven here is the half that
   * needs a database: that the route runs the plan the resolver picked, that a
   * folded rollup read returns the SAME numbers as the raw breakdown of the same
   * facts (the exactness claim, made real), and that a refusal is a 400 with its
   * reason on `/report` and a 200 with its reason on `/report/plan`.
   */
  describe('report execution', () => {
    /** costs chosen to be exact in binary — a fold and a $sum must agree bit for bit */
    async function seedCost(t: Awaited<ReturnType<typeof buildTelemetry>>) {
      await t.syncIndexes();
      const llm = (model: string, feature: string, cost: number, iso: string, span: string) =>
        t.emit('llm.completion', {
          tenantId: 'tn', subjects: [{ type: 'org', id: 'o1' }],
          traceId: 'tr_0000cccc', spanId: span, durationMs: 100, occurredAt: at(iso),
          attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: model, feature },
          metrics: { tokens_in: 1, tokens_out: 1, cost_usd: cost },
        });
      await llm('opus', 'chat', 1.5, '2026-07-01T09:00:00Z', 's1');
      await llm('opus', 'chat', 2.25, '2026-07-02T09:00:00Z', 's2');
      await llm('opus', 'summarize', 0.5, '2026-07-02T11:00:00Z', 's3');
      await llm('sonnet', 'chat', 4, '2026-07-01T09:30:00Z', 's4');
      await llm('sonnet', 'summarize', 0.25, '2026-07-03T09:30:00Z', 's5');
      await t.flush();
    }

    const report = (app: any, qs: string) => request(app).get(`/telemetry/api/report?${qs}`);

    it('runs a series plan and says which primitive answered', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const res = await report(app, `source=event:account.signed_up&${RANGE}&measure=count&interval=day`);
      expect(res.status).toBe(200);
      expect(res.body.plan.primitive).toBe('series');
      expect(res.body.plan.exactness).toBe('raw');
      expect(res.body.dataSource).toBe('raw');
      // five signups in tn, one in `other` — the route is scoped like every read
      expect(res.body.result.buckets.reduce((s: number, b: any) => s + b.value, 0)).toBe(5);
      // the Report it executed comes back, so a client can see what was run
      expect(res.body.report.source).toEqual({ event: 'account.signed_up' });
    });

    it('runs a breakdown plan, groups and all', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const res = await report(app, `source=event:account.signed_up&${RANGE}&measure=count&groupBy=attr:source`);
      expect(res.status).toBe(200);
      expect(res.body.plan.primitive).toBe('breakdown');
      expect(res.body.result.rows).toEqual([
        { dims: ['organic'], value: 3 },
        { dims: ['ads'], value: 2 },
      ]);
      expect(res.body.result.groups).toBe(2);
    });

    it('folds a rollups plan into the SAME numbers the raw breakdown reports', async () => {
      const t = buildTelemetry();
      await seedCost(t);
      const { app } = buildApp(t);
      const dims = 'groupBy=attr:gen_ai_request_model&measure=sum:cost_usd';

      const exact = await report(app, `source=family:llm_cost&${RANGE}&${dims}`);
      expect(exact.status).toBe(200);
      expect(exact.body.plan.primitive).toBe('rollups');
      expect(exact.body.plan.exactness).toBe('exact');
      expect(exact.body.plan.via).toBe('llm_cost');
      // folded into breakdown's own row shape — a renderer cannot tell which
      // store answered, which is the entire point of planning an exact read
      expect(exact.body.result.dataSource).toBe('rollups');

      const raw = await request(app).get(`/telemetry/api/breakdown?${RANGE}&name=llm.completion&${dims}`);
      expect(raw.status).toBe(200);
      expect(exact.body.result.rows).toEqual(raw.body.rows);
      expect(exact.body.result.groups).toBe(raw.body.groups);
      // opus 1.5 + 2.25 + 0.5, sonnet 4 + 0.25 — a tie, broken on the dim
      expect(raw.body.rows).toEqual([
        { dims: ['opus'], value: 4.25 },
        { dims: ['sonnet'], value: 4.25 },
      ]);

      // and again with a time axis, where the fold re-truncates bucket starts
      const byDay = await report(app, `source=family:llm_cost&${RANGE}&${dims}&interval=day`);
      const rawByDay = await request(app).get(
        `/telemetry/api/breakdown?${RANGE}&name=llm.completion&${dims}&interval=day`,
      );
      expect(byDay.body.result.rows).toEqual(rawByDay.body.rows);
    });

    it('runs a funnel plan off the lifetime milestone families', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const res = await report(
        app,
        `source=event:account.signed_up&${RANGE}&measure=funnel` +
          '&stages=account.signed_up,data.first_viewed,account.converted',
      );
      expect(res.status).toBe(200);
      expect(res.body.plan.primitive).toBe('funnel');
      expect(res.body.dataSource).toBe('rollups');
      expect(res.body.result.stages.map((s: any) => s.subjects)).toEqual([5, 1, 0]);
    });

    it('answers `compare=previous` with the window immediately before, same length', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const res = await report(
        app,
        'source=event:account.signed_up&from=2026-07-04T00:00:00Z&to=2026-07-10T00:00:00Z' +
          '&measure=count&interval=day&compare=previous',
      );
      expect(res.status).toBe(200);
      const total = (r: any) => r.buckets.reduce((s: number, b: any) => s + b.value, 0);
      expect(total(res.body.result)).toBe(2); // 07-04, 07-05
      expect(total(res.body.previous)).toBe(3); // the six days before: 07-01..07-03
      expect(res.body.plan.previous.args[0]).toEqual({
        from: '2026-06-28T00:00:00.000Z',
        to: '2026-07-04T00:00:00.000Z',
      });
    });

    it('returns records UNREDACTED — the dashboard viewer is already inside the tenant', async () => {
      const t = buildTelemetry();
      await t.syncIndexes();
      await t.emit('page.view', {
        tenantId: 'tn',
        subjects: [{ type: 'user', id: 'u_0' }, { type: 'account', id: 'a0' }, { type: 'session', id: 's0' }],
        actor: 'user:u_0', client: { ...CLIENT },
        occurredAt: at('2026-07-02T11:00:00Z'), data: { secret: 'visible-here' },
      });
      await t.flush();
      const { app } = buildApp(t);
      const res = await report(app, `source=event:page.view&${RANGE}`);
      expect(res.body.plan.primitive).toBe('records');
      // mcp.ts passes a redactor to executeReport because an agent is outside
      // the tenant boundary; this route passes none, and says so by returning
      // the payload the viewer could already read on /records
      expect(res.body.result.items[0].data).toEqual({ secret: 'visible-here' });
    });

    it('/report/plan is a dry run: a refusal is a 200 with its reason, not an error', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const refused = 'source=event:page.view&' + RANGE + '&measure=sum:cost_usd';

      const dry = await request(app).get(`/telemetry/api/report/plan?${refused}`);
      expect(dry.status).toBe(200);
      expect(dry.body.unavailable).toBe(true);
      expect(dry.body.why).toMatch(/names a metric no source event declares/);

      // asking for the DATA is a different question, and the answer is a 400
      const run = await report(app, refused);
      expect(run.status).toBe(400);
      expect(run.body.error).toMatch(/names a metric no source event declares/);

      // and a planable one comes back as the plan, unexecuted
      const ok = await request(app).get(
        `/telemetry/api/report/plan?source=family:llm_cost&${RANGE}&groupBy=attr:feature&measure=sum:cost_usd`,
      );
      expect(ok.body).toMatchObject({ primitive: 'rollups', exactness: 'exact', via: 'llm_cost' });
      expect(ok.body.result).toBeUndefined();
    });

    it('400s a malformed report URL, naming the param', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const bad = await report(app, `source=metric:cost_usd&${RANGE}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/`source` must be/);
      const term = await report(app, `source=event:page.view&${RANGE}&filter=attr:plan`);
      expect(term.status).toBe(400);
      expect(term.body.error).toMatch(/`filter`/);
    });

    it('reads a SET of event names in one call — `name=a,b` is an $in, not two reads', async () => {
      const t = buildTelemetry();
      await seed(t);
      const { app } = buildApp(t);
      const res = await request(app).get(
        `/telemetry/api/records?${RANGE}&name=account.signed_up,data.first_viewed`,
      );
      expect(res.status).toBe(200);
      expect(new Set(res.body.items.map((r: any) => r.name))).toEqual(
        new Set(['account.signed_up', 'data.first_viewed']),
      );
      expect(res.body.items).toHaveLength(6); // 5 signups + 1 first_viewed, `other` excluded
    });
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
