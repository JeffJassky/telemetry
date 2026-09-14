import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { GenMapping, addMapping, setSourceContent, toEncodedMap } from '@jridgewell/gen-mapping';
import { createDashboard } from '../src/server/index.js';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * Read-time symbolication: a record keeps the minified frames it arrived
 * with; the dashboard translates them against the map registered for the
 * record's release — including maps registered after the error was written.
 */

const SOURCE = ['export function boom() {', '  throw new Error("boom");', '}'].join('\n');

function mapFor(file: string) {
  const g = new GenMapping({ file });
  setSourceContent(g, 'webpack:///src/boom.ts', SOURCE);
  // minified 1:50 (1-based col 51) ← original line 2, col 2, name `boom`
  addMapping(g, {
    generated: { line: 1, column: 50 },
    source: 'webpack:///src/boom.ts',
    original: { line: 2, column: 2 },
    name: 'boom',
  });
  return toEncodedMap(g);
}

const FRAME = { filename: 'https://x.test/js/app.abc123.js?v=1', fn: 'e', lineno: 1, colno: 51 };

async function seedError(t: any, release: string) {
  await t.emit('error.unhandled', {
    tenantId: 'tn', occurredAt: at('2026-07-03T09:00:01Z'), service: 'web', release,
    error: { type: 'Error', message: 'boom', handled: false, fingerprint: 'fp-sm', frames: [FRAME] },
  } as any);
  await t.flush();
}

const RANGE = 'from=2026-06-30T00:00:00Z&to=2026-07-10T00:00:00Z&kind=error';

describe('sourcemaps', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('translates a frame against the map registered for its release, after the fact', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    await seedError(t, 'r1');
    const r = await t.sourcemaps.register({
      tenantId: 'tn', service: 'web', release: 'r1',
      files: [{ file: 'app.abc123.js.map', map: mapFor('app.abc123.js') }, { file: 'app.abc123.js', map: mapFor('app.abc123.js') }],
    });
    expect(r.stored).toBe(2);

    const app = express();
    app.use('/telemetry', createDashboard({
      telemetry: t, viewerAdapter: { resolveViewer: () => ({ tenantId: 'tn', role: 'admin', viewerRef: 'user:me' }) },
    }));
    const res = await request(app).get(`/telemetry/api/records?${RANGE}`);
    expect(res.status).toBe(200);
    const frame = res.body.items.find((i: any) => i.error?.fingerprint === 'fp-sm').error.frames[0];
    expect(frame.original).toEqual({
      source: 'src/boom.ts', line: 2, column: 3, name: 'boom', context: 'throw new Error("boom");',
    });
    // the minified location is kept, not replaced
    expect(frame.lineno).toBe(1);
    expect(frame).not.toHaveProperty('original.map');
  });

  it('leaves frames untouched when the release has no map, and refuses release "unknown"', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    expect(
      await t.sourcemaps.resolve({ tenantId: 'tn', service: 'web', release: 'nope', filename: FRAME.filename }, 1, 51),
    ).toBeNull();
    await expect(
      t.sourcemaps.register({ tenantId: 'tn', service: 'web', release: 'unknown', files: [] }),
    ).rejects.toThrow(/unknown/);
    const rec = { kind: 'error', tenantId: 'tn', service: 'web', release: 'nope', error: { frames: [FRAME] } };
    expect(await t.sourcemaps.symbolicate(rec)).toEqual(rec);
  });

  it('is scoped by tenant — another tenant\'s map never translates this tenant\'s frame', async () => {
    const t = buildTelemetry();
    await t.syncIndexes();
    await t.sourcemaps.register({
      tenantId: 'other', service: 'web', release: 'r2', files: [{ file: 'app.abc123.js', map: mapFor('app.abc123.js') }],
    });
    expect(
      await t.sourcemaps.resolve({ tenantId: 'tn', service: 'web', release: 'r2', filename: FRAME.filename }, 1, 51),
    ).toBeNull();
  });
});
