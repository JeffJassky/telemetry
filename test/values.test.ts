import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PLATFORM_SCOPE, defineRegistry, deriveCatalog } from '../src/server/index.js';
import { createValues } from '../src/server/values.js';
import { CLIENT, at, buildTelemetry, startDb, stopDb } from './helpers.js';

/**
 * `/values` — the observed domain of a dimension (reports §5).
 *
 * The contract under test is the ORDER: catalog, then rollups, then raw, then
 * nothing — cheapest first, each step named in the response. A dimension that
 * qualifies for two steps must get the earlier one, or the package is paying
 * for a read it already had the answer to; and the last step must be an empty
 * answer rather than a throw, because the caller's fallback is a text box with
 * a *scan* badge, not an error page.
 */

/**
 * One synthetic host, chosen so every step is reachable from a single event:
 * `tier` is a closed enum AND indexed AND keyed by a family (catalog must still
 * win), `model` is indexed AND keyed by a family (rollups must win over raw),
 * and `operation` sits in two families so "fewest dims wins" has something to
 * choose between.
 */
const syntheticRegistry = () =>
  defineRegistry({
    'ai.call': {
      kind: 'event',
      origin: 'server',
      subjects: ['account'],
      attrs: z.object({
        model: z.string().max(64),
        operation: z.string().max(64),
        tier: z.enum(['free', 'pro', 'enterprise']),
      }),
      indexedAttrs: ['model', 'tier'],
      rollups: [
        { as: 'ai_usage', by: ['attr:model', 'attr:operation'], bucket: 'day' },
        { as: 'op_totals', by: ['attr:operation'], bucket: 'day' },
        { as: 'tier_totals', by: ['attr:tier'], bucket: 'day' },
        { as: 'ai_actors', by: ['subject'], subjects: ['account'] },
      ],
      description: 'Synthetic — every values step is reachable from one event',
    },
  });

/** [model, operation, tier, day] — model: claude 4, gpt 3, gemini 1 */
const CALLS: Array<readonly [string, string, 'free' | 'pro' | 'enterprise', 1 | 2]> = [
  ['claude', 'chat', 'pro', 1],
  ['claude', 'chat', 'pro', 2],
  ['claude', 'embed', 'free', 1],
  ['claude', 'embed', 'free', 2],
  ['gpt', 'chat', 'free', 1],
  ['gpt', 'chat', 'free', 2],
  ['gpt', 'embed', 'pro', 1],
  ['gemini', 'chat', 'enterprise', 1],
];

async function seedSynthetic(t: Awaited<ReturnType<typeof buildTelemetry>>) {
  await t.syncIndexes();
  let i = 0;
  for (const [model, operation, tier, day] of CALLS) {
    await t.emit('ai.call', {
      tenantId: 'tn',
      subjects: [{ type: 'account', id: `a${i++ % 3}` }],
      occurredAt: at(`2026-07-0${day}T10:00:00Z`),
      attrs: { model, operation, tier },
    });
  }
  // a second tenant, with a model 'tn' has never seen
  await t.emit('ai.call', {
    tenantId: 'other',
    subjects: [{ type: 'account', id: 'ax' }],
    occurredAt: at('2026-07-01T10:00:00Z'),
    attrs: { model: 'llama', operation: 'chat', tier: 'free' },
  });
  await t.flush();
}

/** five plan values with five distinct counts, so "the top three" is unambiguous */
const PLANS: Array<readonly [string, number]> = [
  ['enterprise', 5], ['pro', 4], ['free', 3], ['team', 2], ['solo', 1],
];

async function seedPaper(t: Awaited<ReturnType<typeof buildTelemetry>>) {
  await t.syncIndexes();
  let u = 0;
  for (const [plan, n] of PLANS) {
    for (let k = 0; k < n; k++) {
      await t.emit('billing.plan_selected', {
        tenantId: 'tn',
        subjects: [{ type: 'user', id: `u_${u++}` }, { type: 'account', id: 'a0' }],
        client: { ...CLIENT },
        // half on day one, half on day two, so a narrowed range changes counts
        occurredAt: at(k % 2 ? '2026-07-02T10:00:00Z' : '2026-07-01T10:00:00Z'),
        attrs: { plan },
      });
    }
  }
  // account.signed_up carries `source`: declared, NOT indexed, and only in a
  // family's `capture` — never in a `by`. It is also a record with no `plan` at
  // all, which is the null group the raw step must drop.
  await t.emit('account.signed_up', {
    tenantId: 'tn', subjects: [{ type: 'account', id: 'a0' }],
    occurredAt: at('2026-07-01T09:00:00Z'), attrs: { source: 'organic' },
  });
  await t.emit('billing.plan_selected', {
    tenantId: 'other',
    subjects: [{ type: 'user', id: 'x_0' }, { type: 'account', id: 'ax' }],
    client: { ...CLIENT },
    occurredAt: at('2026-07-01T10:00:00Z'), attrs: { plan: 'other_only' },
  });
  await t.flush();
}

const RANGE = { from: at('2026-06-30T00:00:00Z'), to: at('2026-07-10T00:00:00Z') };
const DAY_ONE = { from: at('2026-07-01T00:00:00Z'), to: at('2026-07-02T00:00:00Z') };

const makeValues = (t: any, limits?: any) =>
  createValues({
    catalog: deriveCatalog(t.registry),
    TelemetryModel: t.models.telemetry,
    RollupModel: t.models.rollups,
    limits,
  });

let synth: Awaited<ReturnType<typeof buildTelemetry>>;
let paper: Awaited<ReturnType<typeof buildTelemetry>>;

describe('values — the observed domain of a dimension', () => {
  beforeAll(async () => {
    await startDb();
    synth = buildTelemetry({ registry: syntheticRegistry() });
    paper = buildTelemetry();
    await seedSynthetic(synth);
    await seedPaper(paper);
  });
  afterAll(stopDb);

  // ── 1. catalog — the registry already said so, so nothing is read ──
  describe('catalog', () => {
    it('serves a declared enum in schema order without touching the database', async () => {
      const v = makeValues(synth);
      const rollupRead = vi.spyOn(synth.models.rollups, 'aggregate');
      const rawRead = vi.spyOn(synth.models.telemetry, 'aggregate');
      // attr:tier is ALSO indexed and ALSO keyed by `tier_totals` — the earlier
      // step has to win, or the package pays for a read it had the answer to
      const res = await v('tn', { dim: 'attr:tier', names: ['ai.call'], range: RANGE });
      expect(res.source).toBe('catalog');
      expect(res.dataSource).toBe('catalog');
      expect(res.values).toEqual(['free', 'pro', 'enterprise']); // schema order, not count order
      expect(res.counts).toBeUndefined();
      expect(res.truncated).toBe(false);
      expect(rollupRead).not.toHaveBeenCalled();
      expect(rawRead).not.toHaveBeenCalled();
      rollupRead.mockRestore();
      rawRead.mockRestore();
    });

    it('serves the envelope enums — every kind and every env', async () => {
      const v = makeValues(paper);
      expect(await v('tn', { dim: 'field:env' })).toMatchObject({
        source: 'catalog', values: ['prod', 'staging', 'dev'],
      });
      expect((await v('tn', { dim: 'field:kind' })).values).toEqual([
        'event', 'error', 'span', 'state', 'usage',
      ]);
    });
  });

  // ── 2. rollups — every value that ever hit an aggregate, in one indexed read ──
  describe('rollups', () => {
    it('sums a family dim across its buckets, strips the label prefix, and names the family', async () => {
      const res = await makeValues(synth)('tn', { dim: 'attr:model' });
      expect(res.source).toBe('rollups');
      expect(res.dataSource).toBe('rollups');
      expect(res.via).toBe('ai_usage');
      // `model=claude` is what rollups.ts writes; a picker must not offer that
      expect(res.values).toEqual(['claude', 'gpt', 'gemini']);
      // one doc per (model, operation, day) — the counts are summed across all of them
      expect(res.counts).toEqual([4, 3, 1]);
      expect(res.truncated).toBe(false);
    });

    it('picks the family with the fewest dims — fewer dims is fewer docs for the same domain', async () => {
      const res = await makeValues(synth)('tn', { dim: 'attr:operation' });
      expect(res.via).toBe('op_totals'); // not ai_usage, which is keyed by two
      expect(res.values).toEqual(['chat', 'embed']);
      expect(res.counts).toEqual([5, 3]);
    });

    it('serves a subject family as native `type:id` refs, which is how erasure matches them', async () => {
      const res = await makeValues(synth)('tn', { dim: 'subject' });
      expect(res.source).toBe('rollups');
      expect(res.via).toBe('ai_actors');
      expect(res.values).toEqual(['account:a0', 'account:a1', 'account:a2']);
      expect(res.counts).toEqual([3, 3, 2]);
    });

    it('restricts to families the named events actually feed', async () => {
      // no feeder of any family is called 'page.view', so nothing here can answer
      const res = await makeValues(synth)('tn', { dim: 'attr:model', names: ['page.view'] });
      expect(res.source).toBe('none');
    });
  });

  // ── 3. raw — an index answers it, and only over a range ──
  describe('raw', () => {
    it('groups an indexed attr with no family, honouring names and the range', async () => {
      const v = makeValues(paper);
      const res = await v('tn', {
        dim: 'attr:plan', names: ['billing.plan_selected'], range: RANGE,
      });
      expect(res.source).toBe('raw');
      expect(res.dataSource).toBe('raw');
      expect(res.via).toBeUndefined();
      expect(res.values).toEqual(['enterprise', 'pro', 'free', 'team', 'solo']);
      expect(res.counts).toEqual([5, 4, 3, 2, 1]);

      // the range is a real filter, not decoration — day one is the even k's
      const narrowed = await v('tn', {
        dim: 'attr:plan', names: ['billing.plan_selected'], range: DAY_ONE,
      });
      expect(narrowed.counts).toEqual([3, 2, 2, 1, 1]);
    });

    it('restricts to the named events — an envelope dim over one name is that name', async () => {
      const v = makeValues(paper);
      const one = await v('tn', { dim: 'field:name', names: ['billing.plan_selected'], range: RANGE });
      expect(one.source).toBe('raw');
      expect(one.values).toEqual(['billing.plan_selected']);
      expect(one.counts).toEqual([15]);

      const all = await v('tn', { dim: 'field:name', range: RANGE });
      expect(all.values).toEqual(['billing.plan_selected', 'account.signed_up']);
    });

    it('drops the null group — "no value" is not a value anyone can pick', async () => {
      // no `names`, so account.signed_up is in the scan and carries no `plan`
      const res = await makeValues(paper)('tn', { dim: 'attr:plan', range: RANGE });
      expect(res.source).toBe('raw');
      expect(res.values).not.toContain(null as any);
      expect(res.values).toHaveLength(5);
      expect(res.counts!.reduce((a, b) => a + b, 0)).toBe(15); // not 16
    });

    it('answers `none` for an unindexed attr rather than selling a scan as a lookup', async () => {
      // `source` is declared on account.signed_up and captured by its family, but
      // it is in no `by` and no index. The UI's answer is the FilterBar's
      // free-text box with its *scan* badge — this endpoint just says so.
      const res = await makeValues(paper)('tn', {
        dim: 'attr:source', names: ['account.signed_up'], range: RANGE,
      });
      expect(res).toEqual({ values: [], source: 'none', truncated: false, dataSource: 'none' });
    });

    it('answers `none` without a range instead of throwing — the caller offers free text', async () => {
      const res = await makeValues(paper)('tn', { dim: 'attr:plan', names: ['billing.plan_selected'] });
      expect(res.source).toBe('none');
      expect(res.values).toEqual([]);
    });

    it('answers `none` for a dimension no primitive would group on', async () => {
      const v = makeValues(paper);
      expect((await v('tn', { dim: 'field:data.secret', range: RANGE })).source).toBe('none');
      expect((await v('tn', { dim: 'nonsense', range: RANGE })).source).toBe('none');
    });
  });

  // ── the cap: on values RETURNED, never on rows scanned ──
  describe('the cap', () => {
    it('keeps the top values by count and says it truncated', async () => {
      const res = await makeValues(paper)('tn', {
        dim: 'attr:plan', names: ['billing.plan_selected'], range: RANGE, limit: 3,
      });
      expect(res.values).toEqual(['enterprise', 'pro', 'free']);
      expect(res.counts).toEqual([5, 4, 3]);
      expect(res.truncated).toBe(true);
    });

    it('clamps the ask to the configured cap — the ask is a preference, the cap is the contract', async () => {
      const res = await makeValues(paper, { values: 2 })('tn', {
        dim: 'attr:plan', names: ['billing.plan_selected'], range: RANGE, limit: 999,
      });
      expect(res.values).toEqual(['enterprise', 'pro']);
      expect(res.truncated).toBe(true);
    });

    it('caps the rollups step the same way', async () => {
      const res = await makeValues(synth)('tn', { dim: 'attr:model', limit: 2 });
      expect(res.values).toEqual(['claude', 'gpt']);
      expect(res.truncated).toBe(true);
    });
  });

  // ── tenancy: the same rule the primitives hold ──
  describe('tenancy', () => {
    it('never leaks another tenant\'s values, and unions them under the platform scope', async () => {
      const v = makeValues(synth);
      const mine = await v('tn', { dim: 'attr:model' });
      expect(mine.values).not.toContain('llama');

      const all = await v(PLATFORM_SCOPE, { dim: 'attr:model' });
      expect(all.values).toContain('llama');
      expect(all.values.sort()).toEqual(['claude', 'gemini', 'gpt', 'llama']);
    });

    it('holds on the raw step too', async () => {
      const v = makeValues(paper);
      const mine = await v('tn', { dim: 'attr:plan', names: ['billing.plan_selected'], range: RANGE });
      expect(mine.values).not.toContain('other_only');

      const all = await v(PLATFORM_SCOPE, {
        dim: 'attr:plan', names: ['billing.plan_selected'], range: RANGE,
      });
      expect(all.values).toContain('other_only');
    });
  });

  it('memoizes an identical lookup inside the TTL', async () => {
    const v = makeValues(synth);
    const first = await v('tn', { dim: 'attr:model' });
    const second = await v('tn', { dim: 'attr:model' });
    expect(second).toBe(first); // the same object — not a re-read
    const other = await v('tn', { dim: 'attr:model', limit: 2 });
    expect(other).not.toBe(first); // the key covers every argument
  });
});
