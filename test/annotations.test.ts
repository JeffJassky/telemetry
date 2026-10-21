import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PLATFORM_SCOPE, createDashboard } from '../src/server/index.js';
import { createTelemetryMcp } from '../src/server/mcp.js';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * Annotations — the change log charts are read against. The store's own
 * contract (validation, overlap, scope, idempotency), then the two doors to it:
 * the dashboard routes and the list_annotations tool, then erasure.
 */

let t: ReturnType<typeof buildTelemetry>;

beforeAll(async () => {
  await startDb();
  t = buildTelemetry();
  await t.syncIndexes();
});
afterAll(stopDb);

/** a tenant's own rows — global ('*') annotations from other tests also overlap W */
const own = (res: { items: any[] }, tenant: string) => res.items.filter((x) => x.tenantId === tenant);

const W = { from: at('2026-07-01T00:00:00Z'), to: at('2026-07-08T00:00:00Z') };

function buildApp(viewer: any) {
  const state = { viewer };
  const app = express();
  app.use('/telemetry', createDashboard({ telemetry: t, viewerAdapter: { resolveViewer: () => state.viewer } }));
  return { app, state };
}

describe('annotations store', () => {
  it('creates with defaults and reads back the stored shape', async () => {
    const a = await t.annotations.create({ tenantId: 's1', at: '2026-07-02T10:00:00Z', title: '  Removed Meta pixel  ' });
    expect(a).toMatchObject({
      tenantId: 's1', title: 'Removed Meta pixel', category: 'change', source: 'api',
      endAt: null, body: null, service: null, env: null, tags: [], url: null, key: null,
    });
    expect(a.at).toEqual(at('2026-07-02T10:00:00Z'));
    expect(await t.annotations.get('s1', a.id)).toEqual(a);
  });

  it.each([
    [{ title: '' }, /title/],
    [{ title: 'x'.repeat(201) }, /title/],
    [{ at: 'not a date' }, /at/],
    [{ endAt: '2026-07-01T00:00:00Z' }, /endAt/],
    [{ category: 'Big Change' }, /category/],
    [{ url: 'javascript:alert(1)' }, /http or https/],
    [{ url: 'nope' }, /valid URL/],
    [{ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, /tags/],
    [{ tenantId: '' }, /tenantId/],
  ])('refuses %j with a 400', async (patch, msg) => {
    const err: any = await t.annotations
      .create({ tenantId: 's1', at: '2026-07-02T00:00:00Z', title: 'ok', ...(patch as any) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(msg);
  });

  it('lists what overlaps the window: points inside, spans crossing in, oldest first', async () => {
    const T = 'overlap';
    const mk = (title: string, a: string, endAt?: string) => t.annotations.create({ tenantId: T, at: a, endAt, title });
    await mk('before', '2026-06-30T00:00:00Z');
    await mk('span-in', '2026-06-25T00:00:00Z', '2026-07-01T12:00:00Z');
    await mk('inside', '2026-07-03T00:00:00Z');
    await mk('at-from', '2026-07-01T00:00:00Z');
    await mk('at-to', '2026-07-08T00:00:00Z');
    await mk('span-past', '2026-06-01T00:00:00Z', '2026-06-30T23:59:59Z');
    const res = await t.annotations.list(T, W);
    expect(own(res, T).map((x) => x.title)).toEqual(['span-in', 'at-from', 'inside']);
    expect(res.truncated).toBe(false);
  });

  it('scope: a tenant sees its own plus global; the platform sees global only', async () => {
    await t.annotations.create({ tenantId: 'sa', at: '2026-07-02T00:00:00Z', title: 'a-only' });
    await t.annotations.create({ tenantId: 'sb', at: '2026-07-02T00:00:00Z', title: 'b-only' });
    await t.annotations.create({ tenantId: PLATFORM_SCOPE, at: '2026-07-02T00:00:00Z', title: 'global deploy' });
    const titles = async (scope: string) => (await t.annotations.list(scope, W)).items.map((x) => x.title);
    expect(await titles('sa')).toEqual(expect.arrayContaining(['a-only', 'global deploy']));
    expect(await titles('sa')).not.toContain('b-only');
    const platform = await titles(PLATFORM_SCOPE);
    expect(platform).toContain('global deploy');
    expect(platform).not.toContain('a-only');
  });

  it('service/env narrow but keep the unscoped ones; category and tags filter', async () => {
    const T = 'narrow';
    const base = { tenantId: T, at: '2026-07-02T00:00:00Z' };
    await t.annotations.create({ ...base, title: 'all' });
    await t.annotations.create({ ...base, title: 'api', service: 'api', category: 'deploy', tags: ['backend'] });
    await t.annotations.create({ ...base, title: 'web', service: 'web', env: 'prod', category: 'tracking' });
    const titles = async (q: any) => own(await t.annotations.list(T, { ...W, ...q }), T).map((x) => x.title).sort();
    expect(await titles({ service: 'api' })).toEqual(['all', 'api']);
    expect(await titles({ env: 'staging' })).toEqual(['all', 'api']);
    expect(await titles({ category: ['deploy', 'tracking'] })).toEqual(['api', 'web']);
    expect(await titles({ tags: ['backend'] })).toEqual(['api']);
  });

  it('caps the list and says so', async () => {
    const T = 'cap';
    for (let i = 0; i < 4; i++) {
      await t.annotations.create({ tenantId: T, at: `2026-07-0${i + 2}T00:00:00Z`, title: `n${i}` });
    }
    const res = await t.annotations.list(T, { ...W, limit: 3 });
    expect(res.items).toHaveLength(3);
    expect(res.truncated).toBe(true);
  });

  it('a limit that is not a number is the default, never "no limit"', async () => {
    const res = await t.annotations.list('cap', { ...W, limit: Number('abc') });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.length).toBeLessThanOrEqual(500);
    const { app } = buildApp({ tenantId: 'cap', role: 'member' });
    const http = await request(app).get('/telemetry/api/annotations')
      .query({ from: W.from.toISOString(), to: W.to.toISOString(), limit: 'abc' });
    expect(http.status).toBe(200);
  });

  it('a key makes create() an upsert — a retried deploy hook draws one line', async () => {
    const input = { tenantId: 'idem', at: '2026-07-02T00:00:00Z', title: 'Deploy 1.4', key: 'deploy:1.4', category: 'deploy' };
    const [a, b] = await Promise.all([t.annotations.create(input), t.annotations.create(input)]);
    expect(a.id).toBe(b.id);
    const c = await t.annotations.create({ ...input, title: 'Deploy 1.4 (rolled back)' });
    expect(c.id).toBe(a.id);
    expect(c.createdAt).toEqual(a.createdAt);
    const res = await t.annotations.list('idem', W);
    expect(own(res, 'idem').map((x) => x.title)).toEqual(['Deploy 1.4 (rolled back)']);
  });

  it('update and remove match scope literally', async () => {
    const a = await t.annotations.create({ tenantId: 'lit', at: '2026-07-02T00:00:00Z', title: 'x' });
    expect(await t.annotations.update(PLATFORM_SCOPE, a.id, { title: 'hijack' })).toBeNull();
    expect(await t.annotations.update('other', a.id, { title: 'hijack' })).toBeNull();
    expect(await t.annotations.remove('other', a.id)).toEqual({ removed: 0 });
    const u = await t.annotations.update('lit', a.id, { title: 'y', endAt: '2026-07-03T00:00:00Z' });
    expect(u).toMatchObject({ title: 'y', tenantId: 'lit' });
    expect(u!.endAt).toEqual(at('2026-07-03T00:00:00Z'));
    await expect(t.annotations.update('lit', a.id, { at: '2026-07-04T00:00:00Z' })).rejects.toThrow(/endAt/);
    expect(await t.annotations.remove('lit', a.id)).toEqual({ removed: 1 });
  });
});

describe('dashboard routes', () => {
  const me = { tenantId: 'dash', role: 'member', viewerRef: 'user:u_me' };
  const q = { from: W.from.toISOString(), to: W.to.toISOString() };

  it('POST stamps tenant, author and source from the viewer, never the body', async () => {
    const { app } = buildApp(me);
    const res = await request(app).post('/telemetry/api/annotations').send({
      at: '2026-07-02T00:00:00Z', title: 'GTM v42 published', category: 'tracking',
      tenantId: 'someone-else', authorRef: 'user:forged', source: 'forged', key: 'forged',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenantId: 'dash', authorRef: 'user:u_me', source: 'dashboard', key: null, category: 'tracking',
    });
  });

  it('POST validation errors are 400 with the message', async () => {
    const { app } = buildApp(me);
    const res = await request(app).post('/telemetry/api/annotations').send({ at: '2026-07-02T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
  });

  it('GET lists the window, and needs a viewer', async () => {
    const { app, state } = buildApp(me);
    const res = await request(app).get('/telemetry/api/annotations').query(q);
    expect(res.status).toBe(200);
    expect(res.body.items.map((x: any) => x.title)).toContain('GTM v42 published');
    state.viewer = null;
    expect((await request(app).get('/telemetry/api/annotations').query(q)).status).toBe(401);
  });

  it('edit/delete: your own, or admin — others get 403', async () => {
    const { app, state } = buildApp(me);
    const made = await request(app).post('/telemetry/api/annotations').send({ at: '2026-07-02T00:00:00Z', title: 'mine' });
    const id = made.body.id;

    state.viewer = { tenantId: 'dash', role: 'member', viewerRef: 'user:u_other' };
    expect((await request(app).patch(`/telemetry/api/annotations/${id}`).send({ title: 'theirs' })).status).toBe(403);
    expect((await request(app).delete(`/telemetry/api/annotations/${id}`)).status).toBe(403);

    state.viewer = me;
    const edited = await request(app).patch(`/telemetry/api/annotations/${id}`).send({ title: 'mine, edited', tenantId: 'x' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'mine, edited', tenantId: 'dash' });

    state.viewer = { tenantId: 'other-tenant', role: 'admin', viewerRef: 'user:root' };
    expect((await request(app).patch(`/telemetry/api/annotations/${id}`).send({ title: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/telemetry/api/annotations/${id}`)).body).toEqual({ removed: 0 });

    state.viewer = { tenantId: 'dash', role: 'admin', viewerRef: 'user:root' };
    expect((await request(app).delete(`/telemetry/api/annotations/${id}`)).body).toEqual({ removed: 1 });
  });

  it('the platform viewer writes global annotations every tenant then sees', async () => {
    const { app, state } = buildApp({ tenantId: PLATFORM_SCOPE, role: 'admin', viewerRef: 'user:root' });
    const made = await request(app).post('/telemetry/api/annotations').send({ at: '2026-07-05T00:00:00Z', title: 'platform deploy' });
    expect(made.body.tenantId).toBe(PLATFORM_SCOPE);
    state.viewer = me;
    const res = await request(app).get('/telemetry/api/annotations').query(q);
    expect(res.body.items.map((x: any) => x.title)).toContain('platform deploy');
  });
});

describe('list_annotations tool', () => {
  it('lists the window without the author, and narrows only inside a platform grant', async () => {
    await t.annotations.create({ tenantId: 'mcp', at: '2026-07-03T00:00:00Z', title: 'consent banner on', category: 'consent', authorRef: 'user:u_1' });
    const state: { viewer: any } = { viewer: { tenantId: 'mcp', role: 'member' } };
    const tool = createTelemetryMcp({ telemetry: t, viewerAdapter: { resolveViewer: () => state.viewer } })
      .find((x) => x.name === 'list_annotations')!;
    const res: any = await tool.handler({ from: q0(W.from), to: q0(W.to), category: ['consent'] }, {});
    expect(res.items.map((x: any) => x.title)).toEqual(['consent banner on']);
    expect(res.items[0]).not.toHaveProperty('authorRef');
    await expect(tool.handler({ from: q0(W.from), to: q0(W.to), tenant: 'other' }, {})).rejects.toThrow(/platform/);
    state.viewer = { tenantId: PLATFORM_SCOPE, role: 'admin' };
    const narrowed: any = await tool.handler({ from: q0(W.from), to: q0(W.to), tenant: 'mcp' }, {});
    expect(narrowed.items.map((x: any) => x.title)).toContain('consent banner on');
  });
});

describe('forget()', () => {
  it('keeps the annotation and rekeys its author', async () => {
    const a = await t.annotations.create({ tenantId: 'fg', at: '2026-07-02T00:00:00Z', title: 'kept', authorRef: 'user:gone' });
    const res = await t.forget('fg', 'user:gone');
    expect(res.annotations).toBe(1);
    const after = await t.annotations.get('fg', a.id);
    expect(after!.title).toBe('kept');
    expect(after!.authorRef).toMatch(/^user:redacted_/);
  });
});

const q0 = (d: Date) => d.toISOString();
