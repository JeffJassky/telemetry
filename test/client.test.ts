import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createClient } from '../src/client/core.js';
import { createCliTelemetry } from '../src/client/cli.js';
import { createIngest, newId } from '../src/server/index.js';
import { buildTelemetry, startDb, stopDb } from './helpers.js';

/** a transport that records every batch and answers as told */
function fakeTransport(plan: Array<{ ok: boolean }> = []) {
  const batches: any[] = [];
  let call = 0;
  const transport = async (_url: string, body: string) => {
    batches.push(JSON.parse(body));
    return plan[call++] ?? { ok: true };
  };
  return { batches, transport };
}

const opts = (transport: any, over: Record<string, unknown> = {}) => ({
  key: 'pk_live_tk_000000000000000000000000',
  url: 'https://x/ingest',
  release: 'app@1.0.0',
  flushIntervalMs: 0, // tests drive flush() by hand
  transport,
  ...over,
});

describe('client core', () => {
  it('a batch carries sdk, sentAt, release, context subjects (anon + session), and UUIDv7 record ids', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport));
    c.track('app.ping', { attrs: { n: '1' } });
    c.track('app.ping');
    await c.flush();

    expect(batches).toHaveLength(1);
    const b = batches[0];
    expect(b.sdk.name).toBe('@jeffjassky/telemetry');
    expect(b.release).toBe('app@1.0.0');
    expect(Date.parse(b.sentAt)).toBeGreaterThan(0);
    const types = b.context.subjects.map((s: any) => s.type).sort();
    expect(types).toEqual(['anon', 'session']);
    expect(b.records).toHaveLength(2);
    const [r1, r2] = b.records;
    expect(r1._id).not.toBe(r2._id);
    expect(r1._id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a failed flush retries the SAME _ids — idempotency lives in the record, not the connection', async () => {
    const { batches, transport } = fakeTransport([{ ok: false }, { ok: true }]);
    const c = createClient(opts(transport));
    c.track('app.ping');
    await c.flush(); // fails, record stays queued
    await c.flush(); // succeeds
    expect(batches).toHaveLength(2);
    expect(batches[0].records[0]._id).toBe(batches[1].records[0]._id);
  });

  it('abandons a batch after maxRetries instead of retrying forever', async () => {
    const { batches, transport } = fakeTransport([{ ok: false }, { ok: false }, { ok: true }]);
    const c = createClient(opts(transport, { maxRetries: 2 }));
    c.track('app.ping');
    await c.flush();
    await c.flush(); // second failure hits maxRetries → dropped
    c.track('app.ping');
    await c.flush();
    expect(batches).toHaveLength(3);
    expect(batches[2].records).toHaveLength(1); // only the new record — the old one is gone
  });

  it('the queue is a ring — beyond the cap the OLDEST records drop', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport, { maxQueueSize: 3, maxBatchSize: 10 }));
    for (let i = 0; i < 5; i++) c.track('app.ping', { attrs: { n: String(i) } });
    await c.flush();
    expect(batches[0].records.map((r: any) => r.attrs.n)).toEqual(['2', '3', '4']);
  });

  it('identify swaps subjects, sets the actor, and posts exactly one $identify per new user', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport));
    c.identify({ user: 'u_1', org: 'o_9' });
    c.identify({ user: 'u_1' }); // same user again — no second alias
    c.track('app.ping');
    await c.flush();

    const b = batches[0];
    const aliases = b.records.filter((r: any) => r.name === '$identify');
    expect(aliases).toHaveLength(1);
    expect(aliases[0].userRef).toBe('user:u_1');
    expect(aliases[0].anonRef).toMatch(/^anon:anon_/);
    const types = b.context.subjects.map((s: any) => s.type).sort();
    expect(types).toEqual(['anon', 'org', 'session', 'user']); // anon stays — stitching consumes the alias
    expect(b.context.actor).toBe('user:u_1');
  });

  it('spans nest: child carries the parent spanId, a track inside a span joins its trace', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport));
    const outer = c.startSpan('outer');
    const inner = c.startSpan('inner');
    c.track('app.ping');
    inner.end({ metrics: { bytes: 10 } });
    outer.end();
    await c.flush();

    const recs = batches[0].records;
    const evt = recs.find((r: any) => r.name === 'app.ping');
    const innerRec = recs.find((r: any) => r.name === 'inner');
    const outerRec = recs.find((r: any) => r.name === 'outer');
    expect(innerRec.traceId).toBe(outerRec.traceId);
    expect(innerRec.parentId).toBe(outerRec.spanId);
    expect(evt.traceId).toBe(outerRec.traceId);
    expect(evt.parentId).toBe(innerRec.spanId);
    expect(innerRec.durationMs).toBeGreaterThanOrEqual(0);
    expect(innerRec.metrics.bytes).toBe(10);
  });

  it('captureError fingerprints stably and parses frames', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport));
    const boom = () => new Error('x is not a function');
    c.captureError(boom(), { handled: false });
    c.captureError(boom(), { handled: false });
    await c.flush();
    const [e1, e2] = batches[0].records;
    expect(e1.error.fingerprint).toBe(e2.error.fingerprint); // same crash = same group
    expect(e1.error.handled).toBe(false);
    expect(e1.severity).toBe('error');
    expect(e1.error.frames.length).toBeGreaterThan(0);
    expect(e1.error.frames[0].filename).toContain('client.test');
  });

  it('consent=false drops the queue instead of sending OR hoarding', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport, { consent: () => false }));
    c.track('app.ping');
    await c.flush();
    expect(batches).toHaveLength(0);
    c.identify({ user: 'u' }); // queue must not grow unboundedly while opted out
    await c.flush();
    expect(batches).toHaveLength(0);
  });
});

describe('cli adapter', () => {
  it('persists the unsent queue on exit-shape and replays it on the next run — minus stale records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-cli-'));
    const fresh = { _id: newId(), name: 'app.ping', occurredAt: new Date().toISOString() };
    const stale = { _id: newId(), name: 'app.ping', occurredAt: new Date(Date.now() - 30 * 864e5).toISOString() };
    writeFileSync(join(dir, 'telemetry-queue.json'), JSON.stringify([fresh, stale]));

    const { transport } = fakeTransport();
    const c = createCliTelemetry({ key: 'pk_live_tk_000000000000000000000000', url: 'https://x', configDir: dir, flushIntervalMs: 0, transport });
    const ids = (c as any)._internal.queue.map((r: any) => r._id);
    expect(ids).toEqual([fresh._id]); // the month-old record did not replay into today

    // anon id persists across runs
    const anon1 = (c as any)._internal.anonId;
    expect(readFileSync(join(dir, 'telemetry_anon.txt'), 'utf8')).toBe(anon1);
  });

  it('DO_NOT_TRACK yields a working client that never sends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-cli-'));
    const { batches, transport } = fakeTransport();
    const prev = process.env.DO_NOT_TRACK;
    process.env.DO_NOT_TRACK = '1';
    try {
      const c = createCliTelemetry({ key: 'pk_live_tk_000000000000000000000000', url: 'https://x', configDir: dir, transport });
      c.track('app.ping'); // must not throw
      await c.flush();
      expect(batches).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.DO_NOT_TRACK;
      else process.env.DO_NOT_TRACK = prev;
    }
  });
});

describe('client ↔ ingest integration', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('a tracked event travels the real wire into Mongo with the anon/session subjects attached', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    const { key } = await t.createKey({
      kind: 'publishable', tenantMode: 'fixed', tenantId: 'tn',
      service: 'webapp', env: 'prod',
    } as any);
    const app = express();
    app.use('/ingest', createIngest({ telemetry: t }));

    const c = createClient(opts(
      async (_url: string, body: string, headers: Record<string, string>) => {
        const res = await request(app).post('/ingest').set(headers).send(JSON.parse(body));
        return { ok: res.status < 300, status: res.status };
      },
      { key },
    ));
    c.track('app.ping', { attrs: { n: '42' } });
    await c.flush();

    const row = await t.models.telemetry.findOne({ name: 'app.ping' }).lean() as any;
    expect(row).toBeTruthy();
    expect(row.tenantId).toBe('tn');
    expect(row.attrs.n).toBe('42');
    expect(row.subjectKeys.some((k: string) => k.startsWith('anon:'))).toBe(true);
    expect(row.subjectKeys.some((k: string) => k.startsWith('session:'))).toBe(true);
    expect(row.client.clockSkewMs).toBeDefined();
  });
});
