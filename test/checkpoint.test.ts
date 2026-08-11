import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { at, buildTelemetry, startDb, stopDb } from './helpers.js';

describe('checkpoint — the pull-importer watermark', () => {
  beforeAll(startDb);
  afterAll(stopDb);

  it('returns null on the first run — the caller decides what "from the beginning" means', async () => {
    const t = buildTelemetry();
    expect(await t.checkpoint('mailery-bridge').get()).toBeNull();
  });

  it('advance() then get() round-trips, and keys are independent', async () => {
    const t = buildTelemetry();
    const bridge = t.checkpoint('mailery-bridge');
    const stripe = t.checkpoint('stripe-backfill');
    await bridge.advance(at('2026-07-01T00:00:00Z'));
    await stripe.advance(at('2026-06-01T00:00:00Z'));
    expect((await bridge.get())!.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect((await stripe.get())!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('re-advancing moves the watermark — including BACKWARD, for the safety-overlap rewind', async () => {
    const t = buildTelemetry();
    const cp = t.checkpoint('scanner');
    await cp.advance(at('2026-07-02T00:00:00Z'));
    await cp.advance(at('2026-07-01T23:00:00Z')); // rewind by overlap; dedupe downstream absorbs it
    expect((await cp.get())!.toISOString()).toBe('2026-07-01T23:00:00.000Z');
  });
});
