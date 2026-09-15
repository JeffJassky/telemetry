import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, installProcessErrorHandlers } from '../src/client/core.js';
import { createMainTelemetry, createRendererTelemetry } from '../src/client/electron.js';
import { createTelemetryPlugin } from '../src/client/vue.js';
import { coerceError, describeError, fingerprint, normalizeMessage, parseFrames } from '../src/client/errors.js';
import { z } from 'zod';
import { buildTelemetry, paperRegistry, startDb, stopDb } from './helpers.js';

function fakeTransport() {
  const batches: any[] = [];
  const transport = async (_url: string, body: string) => {
    batches.push(JSON.parse(body));
    return { ok: true };
  };
  return { batches, transport };
}

const opts = (transport: any, over: Record<string, unknown> = {}) => ({
  key: 'pk_live_tk_000000000000000000000000',
  url: 'https://x/ingest',
  flushIntervalMs: 0,
  transport,
  ...over,
});

describe('error shaping (client/errors.ts)', () => {
  it('normalizes UUIDs and 24-hex ids before digits, so one bug is one fingerprint', () => {
    const a = fingerprint('CastError', 'Cast to ObjectId failed for value "65f3aa11bb22cc33dd44ee55"', 'x.js');
    const b = fingerprint('CastError', 'Cast to ObjectId failed for value "6aa8b270f7915eeb7dc0bb11"', 'x.js');
    expect(a).toBe(b);
    expect(normalizeMessage('row 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at 12')).toBe('row <uuid> at N');
    expect(fingerprint('TypeError', 'x', 'x.js')).not.toBe(fingerprint('RangeError', 'x', 'x.js'));
  });

  it('parses V8 frames with and without a function name, capped at 20', () => {
    const stack = ['Error: boom', '    at handler (/app/server/a.js:10:5)', '    at /app/node_modules/b.js:3:4']
      .concat(Array.from({ length: 30 }, (_, i) => `    at f${i} (/app/c.js:${i}:1)`))
      .join('\n');
    const frames = parseFrames(stack);
    expect(frames[0]).toEqual({ fn: 'handler', filename: '/app/server/a.js', lineno: 10, colno: 5 });
    expect(frames[1].fn).toBeUndefined();
    expect(frames).toHaveLength(20);
  });

  it('a thrown object is described by its kind and never serialised', () => {
    const e = coerceError({ transcript: 'private words' });
    expect(e.message).toBe('Non-Error thrown (Object)');
    expect(e.stack).not.toContain('private');
    expect(coerceError('plain string').message).toBe('plain string');
    const real = new Error('x');
    expect(coerceError(real)).toBe(real);
  });

  it('describeError carries handled through', () => {
    expect(describeError(new Error('x'), false).handled).toBe(false);
  });
});

describe('client error options', () => {
  it('errorAttrs are stamped under the call site attrs on every error', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport, { errorAttrs: { process: 'worker', source: 'default' } }));
    c.captureError(new Error('a'));
    c.captureError(new Error('b'), { attrs: { source: 'log_bridge' } });
    await c.flush();
    const [a, b] = batches[0].records;
    expect(a.attrs).toEqual({ process: 'worker', source: 'default' });
    expect(b.attrs).toEqual({ process: 'worker', source: 'log_bridge' });
  });

  it('ignoreErrors drops by message on the core, so an app-initiated captureError is filtered too', async () => {
    const { batches, transport } = fakeTransport();
    const seen: string[] = [];
    const c = createClient(
      opts(transport, {
        ignoreErrors: ['third-party', /^Script error/],
        beforeSend: (rec: any) => {
          seen.push(rec.error?.message ?? rec.name);
          return rec;
        },
      }),
    );
    c.captureError(new Error('a third-party widget died'));
    c.captureError(new Error('Script error.'));
    c.captureError(new Error('ours'));
    await c.flush();
    expect(batches[0].records.map((r: any) => r.error.message)).toEqual(['ours']);
    expect(seen).toEqual(['ours']); // the host hook never sees the noise
  });

  it('installProcessErrorHandlers reports both hooks with a source, and uninstalls', async () => {
    const { batches, transport } = fakeTransport();
    const c = createClient(opts(transport));
    const before = process.listenerCount('uncaughtException');
    const uninstall = installProcessErrorHandlers(c);
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    // drive the listeners directly — actually throwing would take vitest down
    const onException = process.listeners('uncaughtException').at(-1) as (e: unknown) => void;
    const onRejection = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void;
    onException(new Error('crash'));
    onRejection(new Error('reject'));
    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
    await c.flush();
    const [a, b] = batches[0].records;
    expect(a.error.handled).toBe(false);
    expect(a.attrs).toEqual({ source: 'uncaught_exception' });
    expect(b.attrs).toEqual({ source: 'unhandled_rejection' });
  });
});

describe('electron adapters', () => {
  it('main stamps process:main and wires the process hooks by default', async () => {
    const { batches, transport } = fakeTransport();
    const before = process.listenerCount('unhandledRejection');
    const c = createMainTelemetry(opts(transport, { errorAttrs: { app: 'shell' } }));
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    const onRejection = process.listeners('unhandledRejection').at(-1) as (r: unknown) => void;
    onRejection(new TypeError('late'));
    process.removeListener('unhandledRejection', onRejection as any);
    process.removeListener('uncaughtException', process.listeners('uncaughtException').at(-1) as any);
    await c.flush();
    expect(batches[0].records[0].attrs).toEqual({ process: 'main', app: 'shell', source: 'unhandled_rejection' });
  });

  it('renderer stamps process:renderer, filters benign errors, and forwards records over IPC', async () => {
    const sent: unknown[][] = [];
    const c = createRendererTelemetry(
      { invoke: async (_ch: string, records: unknown[]) => void sent.push(records) },
      { flushIntervalMs: 0, ignoreErrors: ['widget'] },
    );
    c.captureError(new Error('ResizeObserver loop limit exceeded'));
    c.captureError(new Error('the widget died'));
    c.captureError(new Error('real'), { attrs: { source: 'vue' } });
    await c.flush();
    expect(sent).toHaveLength(1);
    const records = sent[0] as any[];
    expect(records).toHaveLength(1);
    expect(records[0].attrs).toEqual({ process: 'renderer', source: 'vue' });
  });

  it('main re-runs its own beforeSend on records the renderer forwarded', async () => {
    const { batches, transport } = fakeTransport();
    let handler: ((event: unknown, records: unknown) => unknown) | undefined;
    const main = createMainTelemetry(
      opts(transport, {
        captureProcessErrors: false,
        ipcMain: { handle: (_ch: string, fn: any) => void (handler = fn) },
        beforeSend: (rec: any) => ({ ...rec, error: { ...rec.error, message: rec.error.message.replace('alice', '<user>') } }),
      }),
    );
    const renderer = createRendererTelemetry(
      { invoke: async (_ch: string, records: unknown[]) => handler!({}, records) },
      { flushIntervalMs: 0 },
    );
    renderer.captureError(new Error('ENOENT /Users/alice/file'));
    await renderer.flush();
    await main.flush();
    expect(batches[0].records[0].error.message).toBe('ENOENT /Users/<user>/file');
  });
});

describe('vue plugin', () => {
  it('reports component errors as unhandled with source:vue, then chains the previous handler', () => {
    const { transport } = fakeTransport();
    const c = createClient(opts(transport));
    const previous: unknown[] = [];
    const app = { config: { errorHandler: (e: unknown) => previous.push(e) }, provide: () => {} };
    createTelemetryPlugin(c, { attrs: { app: 'shell' } }).install(app);
    const boom = new Error('render');
    app.config.errorHandler(boom, null, 'render function');
    const rec = (c._internal.queue as any[])[0];
    expect(rec.error.handled).toBe(false);
    expect(rec.attrs).toEqual({ app: 'shell', source: 'vue', vue_info: 'render function' });
    expect(previous).toEqual([boom]);
  });
});

describe('server captureError', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  // the paper registry's error spec declares only `route`; this host also
  // declares where an error came from, the way a real one would
  const registry = () => {
    const reg = paperRegistry() as any;
    return {
      ...reg,
      'error.unhandled': {
        ...reg['error.unhandled'],
        attrs: z.object({
          route: z.string().max(200).optional(),
          process: z.string().max(32).optional(),
          source: z.string().max(32).optional(),
        }),
      },
    };
  };

  it('writes an error-kind row shaped like a client record, redacted, with subjects and stamped attrs', async () => {
    const t = buildTelemetry({
      registry: registry(),
      captureError: { errorAttrs: { process: 'api' }, redact: (s: string) => s.replace(/alice/g, '<user>') },
    });
    const err = new Error('ENOENT /Users/alice/x');
    err.stack = 'Error: ENOENT /Users/alice/x\n    at run (/Users/alice/app/server.js:1:2)';
    const result = await t.captureError(err, {
      tenantId: 'tn',
      subjects: [{ type: 'user', id: 'u_1' }],
      attrs: { route: '/api/alice', source: 'middleware' },
      handled: false,
    });
    expect(['written', 'queued']).toContain(result?.outcome); // fire-and-forget by default
    await t.flush();
    const row = await t.models.telemetry.findOne({ kind: 'error' }).lean() as any;
    expect(row.name).toBe('error.unhandled');
    expect(row.error.message).toBe('ENOENT /Users/<user>/x');
    expect(row.error.frames[0].filename).toBe('/Users/<user>/app/server.js');
    expect(row.error.handled).toBe(false);
    expect(row.error.fingerprint).toBe(describeError(err, false).fingerprint); // same algorithm as the clients
    expect(row.attrs).toEqual({ process: 'api', route: '/api/<user>', source: 'middleware' });
    expect(row.subjectKeys).toContain('user:u_1');
  });

  it('a throwing redact drops the record rather than shipping it raw', async () => {
    const t = buildTelemetry({ captureError: { redact: () => { throw new Error('nope'); } } });
    const result = await t.captureError(new Error('secret'), { tenantId: 'tn' });
    expect(result).toBeNull();
    await t.flush();
    expect(await t.models.telemetry.countDocuments({ kind: 'error' })).toBe(0);
  });
});
