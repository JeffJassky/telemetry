import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createIngest, newId } from '../src/server/index.js';
import { buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * The wire contract (instrumentation §3–4, traps §16/§19). Suite names state
 * the failure, per standards/testing.md.
 */

async function buildIngestApp(
  keyInput: Record<string, unknown> = {},
  ingestOpts: Record<string, unknown> = {},
) {
  const t = buildTelemetry();
  await t.syncIndexes();
  const { key } = await t.createKey({
    kind: 'publishable',
    tenantMode: 'fixed',
    tenantId: 'tn',
    service: 'webapp',
    env: 'prod',
    ...keyInput,
  } as any);
  const app = express();
  app.use('/telemetry/ingest', createIngest({ telemetry: t, ...ingestOpts } as any));
  return { t, key, app };
}

const batch = (records: unknown[], extra: Record<string, unknown> = {}) => ({
  sdk: { name: 'test', version: '0' },
  sentAt: new Date().toISOString(),
  release: 'app@1.0.0',
  client: { platform: 'web', appVersion: '1.0.0' },
  context: {},
  records,
  ...extra,
});

const ping = (over: Record<string, unknown> = {}) => ({
  _id: newId(),
  name: 'app.ping',
  occurredAt: new Date().toISOString(),
  ...over,
});

const post = (app: express.Express, key: string, body: unknown) =>
  request(app).post('/telemetry/ingest').set('authorization', `Bearer ${key}`).send(body as object);

describe('ingest — the wire contract', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('accepts a batch and stamps facts from the KEY — tenant, service, env, origin', async () => {
    const { t, key, app } = await buildIngestApp();
    const res = await post(app, key, batch([ping(), ping()]));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2, rejected: 0 });
    const rows = await t.models.telemetry.find({ name: 'app.ping' }).lean() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].tenantId).toBe('tn');
    expect(rows[0].service).toBe('webapp');
    expect(rows[0].env).toBe('prod');
    expect(rows[0].origin).toBe('client');
    expect(rows[0].release).toBe('app@1.0.0');
  });

  it('a retried batch inserts nothing new AND rolls up nothing new — insert gates aggregation (§16)', async () => {
    const { t, key, app } = await buildIngestApp();
    const rec = {
      _id: newId(),
      name: 'data.first_viewed',
      occurredAt: new Date().toISOString(),
    };
    const b = batch([rec], { context: { subjects: [{ type: 'account', id: 'a1' }] } });
    await post(app, key, b);
    const retry = await post(app, key, b); // sendBeacon died mid-flush, client retries
    expect(retry.body.accepted).toBe(1);   // told "accepted" — it IS stored
    expect(await t.models.telemetry.countDocuments({ name: 'data.first_viewed' })).toBe(1);
    const roll = await t.models.rollups.findOne({ as: 'data.first_viewed' }).lean() as any;
    expect(roll.count).toBe(1); // the milestone did not double
  });

  it('corrects occurredAt by the clock skew BEFORE rollups see it', async () => {
    const { t, key, app } = await buildIngestApp();
    const skew = 120_000; // client clock two minutes fast
    const now = Date.now();
    await post(app, key, {
      ...batch([ping({ occurredAt: new Date(now + skew - 5000).toISOString() })]),
      sentAt: new Date(now + skew).toISOString(),
    });
    const row = await t.models.telemetry.findOne({ name: 'app.ping' }).lean() as any;
    const stored = new Date(row.occurredAt).getTime();
    expect(Math.abs(stored - (now - 5000))).toBeLessThan(3000); // skew removed
    expect(Math.abs(row.client.clockSkewMs - skew)).toBeLessThan(3000);
  });

  it('ignores a claimed tenantId — a claim is not a fact, and not an attack either', async () => {
    const { t, key, app } = await buildIngestApp();
    const res = await post(app, key, batch([ping({ tenantId: 'someone-else' })]));
    expect(res.body.accepted).toBe(1);
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(row.tenantId).toBe('tn');
  });

  it('strips plane fields — a wire record cannot force-keep itself or claim a sampleRate', async () => {
    const { t, key, app } = await buildIngestApp();
    await post(app, key, batch([ping({ forced: true, sampleRate: 0.01, expiresAt: '2099-01-01' })]));
    const row = await t.models.telemetry.findOne({}).lean() as any;
    expect(row.forced).toBe(false);
    expect(row.sampleRate).toBe(1);
    expect(new Date(row.expiresAt).getFullYear()).toBeLessThan(2090); // kind retention, not the claim
  });

  it('pk_ may not write usage, state (unless allowlisted), or server-origin names', async () => {
    const { t, key, app } = await buildIngestApp();
    const res = await post(app, key, batch([
      { _id: newId(), name: 'billing.ai_tokens', occurredAt: new Date().toISOString(), usage: { meter: 'm', quantity: 1, unit: 'u', idempotencyKey: 'k', billedTo: 'org:o' } },
      { _id: newId(), name: 'account.lifecycle', occurredAt: new Date().toISOString(), state: { key: 'lifecycle', to: 'active' } },
      { _id: newId(), name: 'account.converted', occurredAt: new Date().toISOString() }, // server-origin
    ]));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 0, rejected: 3 });
    expect(await t.models.telemetry.countDocuments({})).toBe(0);
    expect(await t.collections.rejects().countDocuments({})).toBe(3);
  });

  it('accepts a client-origin state through a key that explicitly allowlists the kind', async () => {
    const { t, key, app } = await buildIngestApp({ allowedKinds: ['event', 'error', 'span', 'state'] });
    const res = await post(app, key, batch(
      [{ _id: newId(), name: 'ui.mode', occurredAt: new Date().toISOString(), state: { key: 'theme', from: 'light', to: 'dark' } }],
    ));
    expect(res.body.accepted).toBe(1);
    expect(await t.models.telemetry.countDocuments({ kind: 'state' })).toBe(1);
  });

  it('one bad record never kills a batch — per-record acceptance', async () => {
    const { t, key, app } = await buildIngestApp();
    const res = await post(app, key, batch([
      ping(),
      { _id: newId(), name: 'not.registered', occurredAt: new Date().toISOString() },
      { name: 'app.ping', occurredAt: new Date().toISOString() }, // no _id: no idempotency
      ping(),
    ]));
    expect(res.body).toEqual({ accepted: 2, rejected: 2 });
    expect(await t.models.telemetry.countDocuments({})).toBe(2);
  });

  describe('pk_ never 4xxes (traps §19)', () => {
    it('no credential → 202, drop', async () => {
      const { app } = await buildIngestApp();
      const res = await request(app).post('/telemetry/ingest').send(batch([ping()]));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 0, rejected: 0 });
    });

    it('unknown or revoked pk_ → 202, drop', async () => {
      const { t, key, app } = await buildIngestApp({}, { keyCacheMs: 0 });
      const unknown = await post(app, 'pk_live_tk_000000000000000000000000', batch([ping()]));
      expect(unknown.status).toBe(202);
      await t.models.keys.updateMany({}, { $set: { revokedAt: new Date() } });
      const revoked = await post(app, key, batch([ping()]));
      expect(revoked.status).toBe(202);
      expect(await t.models.telemetry.countDocuments({})).toBe(0);
    });

    it('malformed JSON → 202, counted', async () => {
      const { key, app } = await buildIngestApp();
      const res = await request(app)
        .post('/telemetry/ingest')
        .set('authorization', `Bearer ${key}`)
        .set('content-type', 'application/json')
        .send('{"records": [');
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 0, rejected: 1 });
    });

    it('over the batch cap → keep the head, count the tail, 202', async () => {
      const { key, app } = await buildIngestApp({}, { maxRecords: 2 });
      const res = await post(app, key, batch([ping(), ping(), ping(), ping()]));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 2, rejected: 2 });
    });

    it('over the per-key rate limit → keep what fits, count the rest, 202', async () => {
      const { key, app } = await buildIngestApp({ maxPerMinute: 2 });
      const res = await post(app, key, batch([ping(), ping(), ping(), ping(), ping()]));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 2, rejected: 3 });
    });
  });

  describe('sk_ callers are programmers and get honest errors', () => {
    it('a tampered secret → 401 (constant-time verified)', async () => {
      const { t, app } = await buildIngestApp();
      const { key: sk } = await t.createKey({
        kind: 'secret', tenantMode: 'claimed', service: 'api', env: 'prod',
      } as any);
      const tampered = sk.slice(0, -1) + (sk.endsWith('0') ? '1' : '0');
      const res = await post(app, tampered, batch([ping()], { context: { tenantId: 'acc_z' } }));
      expect(res.status).toBe(401);
    });

    it('claimed mode without a tenant → 400; over the cap → 413; over the rate → 429', async () => {
      const { t, app } = await buildIngestApp({}, { maxRecords: 2 });
      const { key: sk } = await t.createKey({
        kind: 'secret', tenantMode: 'claimed', service: 'api', env: 'prod', maxPerMinute: 1,
      } as any);
      const noTenant = await post(app, sk, batch([ping()]));
      expect(noTenant.status).toBe(400);
      const tooBig = await post(app, sk, batch([ping(), ping(), ping()], { context: { tenantId: 'acc_z' } }));
      expect(tooBig.status).toBe(413);
      await post(app, sk, batch([ping()], { context: { tenantId: 'acc_z' } })); // spends the budget
      const limited = await post(app, sk, batch([ping()], { context: { tenantId: 'acc_z' } }));
      expect(limited.status).toBe(429);
    });

    it('sk_ claimed writes usage — replayed idempotencyKey still lands ONE row', async () => {
      const { t, app } = await buildIngestApp();
      const { key: sk } = await t.createKey({
        kind: 'secret', tenantMode: 'claimed', service: 'api', env: 'prod',
      } as any);
      const usage = {
        _id: newId(),
        name: 'billing.ai_tokens',
        occurredAt: new Date().toISOString(),
        attrs: { gen_ai_request_model: 'm', feature: 'chat' },
        metrics: { cost_usd: 0.05 },
        usage: { meter: 'ai_tokens', quantity: 100, unit: 'token', idempotencyKey: 'wire:1', billedTo: 'org:o1' },
      };
      const b = batch([usage], { context: { tenantId: 'acc_z', subjects: [{ type: 'org', id: 'o1' }] } });
      await post(app, sk, b);
      // same money, new record id — the webhook fired twice
      await post(app, sk, batch([{ ...usage, _id: newId() }], { context: { tenantId: 'acc_z', subjects: [{ type: 'org', id: 'o1' }] } }));
      expect(await t.models.telemetry.countDocuments({ kind: 'usage' })).toBe(1);
      const spend = await t.models.rollups.findOne({ as: 'spend' }).lean() as any;
      expect(spend.count).toBe(1);
    });
  });

  describe('identity', () => {
    it('the host context outranks the JS claim — session cookie beats payload', async () => {
      const { t, key, app } = await buildIngestApp(
        { tenantMode: 'session', tenantId: undefined },
        {
          contextAdapter: {
            resolveContext: () => ({
              tenantId: 'tn_host',
              subjects: [{ type: 'user', id: 'u_real' }],
              actor: 'user:u_real',
            }),
          },
        },
      );
      const res = await post(app, key, batch(
        [{ _id: newId(), name: 'billing.plan_selected', occurredAt: new Date().toISOString(), attrs: { plan: 'pro' } }],
        { context: { subjects: [{ type: 'user', id: 'u_claimed' }, { type: 'account', id: 'a1' }], actor: 'user:u_claimed' } },
      ));
      expect(res.body.accepted).toBe(1);
      const row = await t.models.telemetry.findOne({}).lean() as any;
      expect(row.tenantId).toBe('tn_host');
      expect(row.subjectKeys).toContain('user:u_real');       // host won
      expect(row.subjectKeys).not.toContain('user:u_claimed');
      expect(row.subjectKeys).toContain('account:a1');        // claim types the host didn't speak to survive
      expect(row.actor).toBe('user:u_real');
    });

    it('session mode with no session: pk drops the batch politely, never 401s a browser', async () => {
      const { key, app } = await buildIngestApp(
        { tenantMode: 'session', tenantId: undefined },
        { contextAdapter: { resolveContext: () => null } },
      );
      const res = await post(app, key, batch([ping()]));
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 0, rejected: 1 });
    });

    it('an $identify control record upserts the alias and stores no telemetry row', async () => {
      const { t, key, app } = await buildIngestApp();
      const res = await post(app, key, batch([
        { _id: newId(), name: '$identify', occurredAt: new Date().toISOString(), anonRef: 'anon:anon_9f3c', userRef: 'user:u_123' },
      ]));
      expect(res.body.accepted).toBe(1);
      expect(await t.models.telemetry.countDocuments({})).toBe(0);
      const alias = await t.collections.aliases().findOne({ anonRef: 'anon:anon_9f3c' }) as any;
      expect(alias._id).toBe('tn|anon:anon_9f3c');
      expect(alias.userRef).toBe('user:u_123');
    });
  });

  describe('browser origins', () => {
    it('an allowlisted Origin gets CORS headers; anything else is dropped without them', async () => {
      const { t, key, app } = await buildIngestApp({ origins: ['https://ok.app'] });
      const ok = await request(app)
        .post('/telemetry/ingest')
        .set('authorization', `Bearer ${key}`)
        .set('origin', 'https://ok.app')
        .send(batch([ping()]));
      expect(ok.status).toBe(202);
      expect(ok.body.accepted).toBe(1);
      expect(ok.headers['access-control-allow-origin']).toBe('https://ok.app');

      const evil = await request(app)
        .post('/telemetry/ingest')
        .set('authorization', `Bearer ${key}`)
        .set('origin', 'https://evil.app')
        .send(batch([ping()]));
      expect(evil.status).toBe(202); // still no 4xx
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      expect(await t.models.telemetry.countDocuments({})).toBe(1); // only the ok one landed
    });

    it('preflight answers 204 with the CORS handshake', async () => {
      const { app } = await buildIngestApp();
      const res = await request(app)
        .options('/telemetry/ingest')
        .set('origin', 'https://anywhere.app')
        .set('access-control-request-method', 'POST');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-headers']).toContain('authorization');
    });

    it('the pk_ key may ride the query string — sendBeacon cannot set headers', async () => {
      const { t, key, app } = await buildIngestApp();
      const res = await request(app)
        .post(`/telemetry/ingest?key=${encodeURIComponent(key)}`)
        .send(batch([ping()]));
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(1);
      expect(await t.models.telemetry.countDocuments({})).toBe(1);
    });

    it('an sk_ in the query string is refused — secrets do not belong in URLs', async () => {
      const { t, app } = await buildIngestApp();
      const { key: sk } = await t.createKey({
        kind: 'secret', tenantMode: 'claimed', service: 'api', env: 'prod',
      } as any);
      const res = await request(app)
        .post(`/telemetry/ingest?key=${encodeURIComponent(sk)}`)
        .send(batch([ping()], { context: { tenantId: 'acc_z' } }));
      expect(res.status).toBe(401);
    });
  });
});
