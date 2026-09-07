import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRegistry } from '../src/server/index.js';
import { deriveCatalog } from '../src/server/catalog.js';
import {
  intervalForRange, normalizeQuery, rangeOf, resolveReport,
  type Plan, type Report, type Unavailable,
} from '../src/server/report.js';
import { deriveViews } from '../src/server/views.js';
import { paperRegistry } from './helpers.js';

/**
 * The resolver is inference, so it is pinned the way the catalog and
 * summarizeStages are: pure, no Mongo, one case per rule and one per refusal.
 * Every plan here is a claim about which primitive answers a question and how
 * exactly — and a wrong `exactness` is a scan sold as a lookup, while a wrong
 * `args` shape is a TypeError at the database. The second half of that contract
 * is proven in dashboard.test.ts, where these plans are actually executed.
 */

const catalog = deriveCatalog(paperRegistry());

/** a bucketed multi-dim family with sums — the shapes paperRegistry has no room for */
const shopCatalog = deriveCatalog(
  defineRegistry({
    'shop.order': {
      kind: 'event', origin: 'server', subjects: ['customer'],
      attrs: z.object({ region: z.string(), channel: z.string() }),
      indexedAttrs: ['region'],
      metrics: z.object({ amount_usd: z.number(), tax_usd: z.number() }),
      rollups: [
        { as: 'orders_wide', by: ['attr:region', 'attr:channel'], bucket: 'day', sum: ['amount_usd'] },
        { as: 'orders_narrow', by: ['attr:region'], bucket: 'day', sum: ['amount_usd'] },
      ],
      description: 'An order was placed',
    },
    'shop.refund': {
      kind: 'event', origin: 'server', subjects: ['customer'],
      attrs: z.object({ region: z.string() }),
      indexedAttrs: ['region'],
      metrics: z.object({ amount_usd: z.number() }),
      rollups: [{ as: 'refunds_weekly', by: ['attr:region'], bucket: 'week', sum: ['amount_usd'] }],
      description: 'An order was refunded',
    },
  }) as any,
);

const NOW = new Date('2026-07-10T00:00:00.000Z');
const PAIR = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' };

const plan = (report: Report, c = catalog): Plan => {
  const out = resolveReport(report, c, { now: NOW });
  if ('unavailable' in out) throw new Error(`expected a plan, got: ${out.why}`);
  return out;
};
const refusal = (report: Report, c = catalog): Unavailable => {
  const out = resolveReport(report, c, { now: NOW });
  if (!('unavailable' in out)) throw new Error(`expected a refusal, got ${out.primitive}`);
  return out;
};

describe('rangeOf', () => {
  it('resolves every shorthand the UI offers, ending at the injected now', () => {
    expect(rangeOf('1h', NOW)).toEqual({ from: new Date('2026-07-09T23:00:00.000Z'), to: NOW });
    expect(rangeOf('24h', NOW)).toEqual({ from: new Date('2026-07-09T00:00:00.000Z'), to: NOW });
    expect(rangeOf('7d', NOW)).toEqual({ from: new Date('2026-07-03T00:00:00.000Z'), to: NOW });
    expect(rangeOf('30d', NOW)).toEqual({ from: new Date('2026-06-10T00:00:00.000Z'), to: NOW });
    expect(rangeOf('90d', NOW)).toEqual({ from: new Date('2026-04-11T00:00:00.000Z'), to: NOW });
    // the generic form a stored view may carry
    expect(rangeOf('14d', NOW).from).toEqual(new Date('2026-06-26T00:00:00.000Z'));
  });

  it('takes an explicit ISO pair, and refuses an inverted one with a 400', () => {
    expect(rangeOf(PAIR)).toEqual({ from: new Date(PAIR.from), to: new Date(PAIR.to) });
    let thrown: any;
    try {
      rangeOf({ from: PAIR.to, to: PAIR.from });
    } catch (e) {
      thrown = e;
    }
    expect(thrown.status).toBe(400);
    expect(thrown.message).toMatch(/strictly before/);
    expect(() => rangeOf({ from: 'yesterday', to: PAIR.to })).toThrow(/not valid/);
  });

  it('refuses an unknown shorthand rather than silently answering about 7 days', () => {
    let thrown: any;
    try {
      rangeOf('all-time', NOW);
    } catch (e) {
      thrown = e;
    }
    expect(thrown.status).toBe(400);
    expect(thrown.message).toMatch(/all-time/);
  });

  it('picks the interval util.js picks, and extends the rule to explicit pairs', () => {
    expect(intervalForRange('1h', NOW)).toBe('hour');
    expect(intervalForRange('24h', NOW)).toBe('hour');
    expect(intervalForRange('7d', NOW)).toBe('day');
    expect(intervalForRange('30d', NOW)).toBe('day');
    expect(intervalForRange('90d', NOW)).toBe('week');
    expect(intervalForRange(PAIR)).toBe('day');
    expect(intervalForRange({ from: '2026-01-01T00:00:00Z', to: '2026-07-01T00:00:00Z' })).toBe('week');
  });
});

describe('rule 1 — funnel', () => {
  const stages = ['account.signed_up', 'data.first_viewed', 'account.converted'];

  it('plans a three-stage cohort funnel off the lifetime milestone families', () => {
    const p = plan({ source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel', stages });
    expect(p.primitive).toBe('funnel');
    expect(p.exactness).toBe('exact');
    expect(p.via).toBe('account.signed_up');
    expect(p.args).toEqual([
      {
        stages: stages.map((as) => ({ as })),
        anchor: 'account.signed_up',
        cohort: rangeOf('30d', NOW),
      },
    ]);
  });

  it('passes exits through and honours an explicit anchor, subjectType and interval', () => {
    const p = plan({
      source: { event: 'account.signed_up' }, range: PAIR, measure: 'funnel',
      stages, anchor: 'account.signed_up', exits: ['report.shared'],
      subjectType: 'account', interval: 'week', limit: 100,
    });
    expect(p.args[0]).toEqual({
      stages: stages.map((as) => ({ as })),
      anchor: 'account.signed_up',
      exits: [{ as: 'report.shared' }],
      cohort: rangeOf(PAIR),
      subjectType: 'account',
      interval: 'week',
      limit: 100,
    });
  });

  it('refuses a bucketed family as a stage, naming it and the reason', () => {
    const why = refusal({
      source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel',
      stages: ['account.signed_up', 'activity'],
    }).why;
    expect(why).toMatch(/"activity"/);
    expect(why).toMatch(/BUCKETED/);
    expect(why).toMatch(/count the same subject repeatedly/);
  });

  it('refuses a multi-dim family as a stage, and an undeclared one with the block to add', () => {
    expect(refusal({
      source: { event: 'llm.completion' }, range: '30d', measure: 'funnel', stages: ['llm_cost'],
    }).why).toMatch(/BUCKETED|keyed by exactly one subject dim/);
    expect(refusal({
      source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel', stages: ['account.activated'],
    }).why).toMatch(/by: \['subject'\], subjects: \[\.\.\.\]/);
  });

  it('refuses stages drawn from two subject populations', () => {
    const why = refusal({
      source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel',
      stages: ['account.signed_up', 'report.shared'],
    }).why;
    expect(why).toMatch(/account/);
    expect(why).toMatch(/user/);
    expect(why).toMatch(/cannot convert into each other/);
  });

  it('refuses a subjectType no stage is declared for, and an hourly slice', () => {
    expect(refusal({
      source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel', stages, subjectType: 'org',
    }).why).toMatch(/"org" is not one of the stages' subjects/);
    expect(refusal({
      source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel', stages, interval: 'hour',
    }).why).toMatch(/day, week or month/);
  });

  it('refuses `measure: funnel` with no stages, naming what stages are', () => {
    expect(refusal({ source: { event: 'account.signed_up' }, range: '30d', measure: 'funnel' }).why)
      .toMatch(/needs `stages`/);
  });

  it('shifts the cohort window under compare', () => {
    const p = plan({
      source: { event: 'account.signed_up' }, range: PAIR, measure: 'funnel', stages, compare: 'previous',
    });
    expect((p.previous!.args[0] as any).cohort).toEqual({
      from: new Date('2026-06-24T00:00:00.000Z'),
      to: new Date(PAIR.from),
    });
    // everything else about the previous call is the same call
    expect((p.previous!.args[0] as any).stages).toEqual(stages.map((as) => ({ as })));
  });
});

describe('rule 2 — distinct', () => {
  it('finds the bucketed single-subject family that covers the source', () => {
    const p = plan({ source: { event: 'account.signed_up' }, range: '30d', measure: 'distinct:account' });
    expect(p.primitive).toBe('distinctCount');
    expect(p.exactness).toBe('exact');
    expect(p.via).toBe('activity');
    expect(p.args).toEqual([{ as: 'activity', subjectType: 'account', range: rangeOf('30d', NOW) }]);
  });

  it('says so when the family it found is fed by more than the source', () => {
    const p = plan({ source: { event: 'account.signed_up' }, range: '30d', measure: 'distinct:account' });
    expect(p.why).toMatch(/SUPERSET/);
    expect(p.why).toMatch(/data\.first_viewed/);
    // the family source names exactly its own feeders, so nothing to warn about
    const exact = plan({ source: { family: 'activity' }, range: '30d', measure: 'distinct:account' });
    expect(exact.why).not.toMatch(/SUPERSET/);
  });

  it('carries an explicit interval into the params', () => {
    const p = plan({
      source: { family: 'activity' }, range: '30d', measure: 'distinct:account', interval: 'week',
    });
    expect(p.args[0]).toEqual({
      as: 'activity', subjectType: 'account', range: rangeOf('30d', NOW), interval: 'week',
    });
  });

  it('refuses when no bucketed subject family covers the source, naming the block to declare', () => {
    const why = refusal({ source: { event: 'llm.completion' }, range: '30d', measure: 'distinct:org' }).why;
    expect(why).toMatch(/llm\.completion/);
    expect(why).toMatch(/bucket: 'day'/);
  });

  it('refuses an unknown subject type and a groupBy it cannot honour', () => {
    expect(refusal({ source: { event: 'account.signed_up' }, range: '30d', measure: 'distinct:robot' }).why)
      .toMatch(/"robot"/);
    expect(refusal({
      source: { event: 'account.signed_up' }, range: '30d', measure: 'distinct:account', groupBy: ['field:env'],
    }).why).toMatch(/take no groupBy/);
  });
});

describe('rule 3 — exact via rollups', () => {
  it('reads a family source directly, on bucketAt when bucketed and firstAt when lifetime', () => {
    const bucketed = plan({ source: { family: 'llm_cost' }, range: '30d' });
    expect(bucketed.primitive).toBe('rollups');
    expect(bucketed.exactness).toBe('exact');
    expect(bucketed.args).toEqual([
      { as: 'llm_cost', on: 'bucketAt', range: rangeOf('30d', NOW), sort: 'bucketAt' },
    ]);

    const lifetime = plan({ source: { family: 'account.signed_up' }, range: '30d' });
    expect(lifetime.args).toEqual([
      { as: 'account.signed_up', on: 'firstAt', range: rangeOf('30d', NOW), sort: 'count' },
    ]);
  });

  it('groups by the family own dims and describes the fold', () => {
    const p = plan({
      source: { family: 'llm_cost' }, range: '30d', interval: 'day',
      groupBy: ['attr:gen_ai_request_model'], measure: 'sum:cost_usd',
    });
    expect(p.primitive).toBe('rollups');
    expect(p.exactness).toBe('exact');
    expect(p.shape).toEqual({
      groupBy: ['attr:gen_ai_request_model'],
      labels: ['gen_ai_request_model'],
      measure: 'sum:cost_usd',
      interval: 'day',
    });
  });

  it('rolls a finer bucket up into a coarser interval, and refuses the other direction', () => {
    const up = plan({
      source: { event: 'shop.order' }, range: '30d', interval: 'week',
      groupBy: ['attr:region'], measure: 'sum:amount_usd',
    }, shopCatalog);
    expect(up.primitive).toBe('rollups');
    expect(up.why).toMatch(/day buckets roll up into week/);

    // a weekly family cannot answer a daily question — one bucket spans seven
    const down = plan({
      source: { event: 'shop.refund' }, range: '30d', interval: 'day',
      groupBy: ['attr:region'], measure: 'sum:amount_usd',
    }, shopCatalog);
    expect(down.primitive).toBe('breakdown');
  });

  it('is exact for a summed metric and falls to raw for one the family does not carry', () => {
    const summed = plan({
      source: { event: 'shop.order' }, range: '30d', groupBy: ['attr:region'], measure: 'sum:amount_usd',
    }, shopCatalog);
    expect(summed.primitive).toBe('rollups');

    const unsummed = plan({
      source: { event: 'shop.order' }, range: '30d', groupBy: ['attr:region'], measure: 'sum:tax_usd',
    }, shopCatalog);
    expect(unsummed.primitive).toBe('breakdown');
  });

  it('treats avg of a summed metric as exact and says the executor divides', () => {
    const p = plan({
      source: { event: 'shop.order' }, range: '30d', groupBy: ['attr:region'], measure: 'avg:amount_usd',
    }, shopCatalog);
    expect(p.primitive).toBe('rollups');
    expect(p.exactness).toBe('exact');
    expect(p.why).toMatch(/divides sums\.amount_usd by count/);
  });

  it('picks the family with the fewest dims when two of them match', () => {
    const p = plan({
      source: { event: 'shop.order' }, range: '30d', interval: 'day',
      groupBy: ['attr:region'], measure: 'sum:amount_usd',
    }, shopCatalog);
    expect(p.via).toBe('orders_narrow');
    // both dims asked for, and only the wide family can answer
    const wide = plan({
      source: { event: 'shop.order' }, range: '30d', interval: 'day',
      groupBy: ['attr:region', 'attr:channel'], measure: 'sum:amount_usd',
    }, shopCatalog);
    expect(wide.via).toBe('orders_wide');
  });

  it('falls to raw when a filter names a dim the family is not keyed by', () => {
    const off = plan({
      source: { event: 'shop.order' }, range: '30d', groupBy: ['attr:region'], measure: 'sum:amount_usd',
      filters: [{ dim: 'field:env', op: 'eq', value: 'prod' }],
    }, shopCatalog);
    expect(off.primitive).toBe('breakdown');

    // …and stays exact when the filter IS one of its dims, folded on the way out
    const on = plan({
      source: { event: 'shop.order' }, range: '30d', groupBy: ['attr:region'], measure: 'sum:amount_usd',
      filters: [{ dim: 'attr:region', op: 'eq', value: 'eu' }],
    }, shopCatalog);
    expect(on.primitive).toBe('rollups');
    expect(on.shape!.filters).toEqual([{ dim: 'attr:region', label: 'region', op: 'eq', value: 'eu' }]);
  });

  it('keeps a name filter that admits every feeder, and drops the family when it does not', () => {
    const kept = plan({
      source: { family: 'activity' }, range: '30d',
      filters: [{ dim: 'field:name', op: 'in', value: ['account.signed_up', 'data.first_viewed'] }],
    });
    expect(kept.primitive).toBe('rollups');

    const narrowed = plan({
      source: { family: 'activity' }, range: '30d',
      filters: [{ dim: 'field:name', op: 'eq', value: 'account.signed_up' }],
    });
    expect(narrowed.primitive).toBe('records');
  });

  it('shifts the rollup range under compare, keeping the same `on` field', () => {
    const p = plan({ source: { family: 'llm_cost' }, range: PAIR, compare: 'previous' });
    expect(p.previous!.args).toEqual([
      {
        as: 'llm_cost',
        on: 'bucketAt',
        range: { from: new Date('2026-06-24T00:00:00.000Z'), to: new Date(PAIR.from) },
        sort: 'bucketAt',
      },
    ]);
  });
});

describe('rules 4 and 5 — raw breakdown and series', () => {
  it('is `raw` when every dim it touches is indexed, and `scan` when one is not', () => {
    const indexed = plan({
      source: { event: 'billing.plan_selected' }, range: '7d', groupBy: ['attr:plan'], measure: 'count',
    });
    expect(indexed.primitive).toBe('breakdown');
    expect(indexed.exactness).toBe('raw');
    expect(indexed.args).toEqual([
      rangeOf('7d', NOW), { name: 'billing.plan_selected' }, { groupBy: ['attr:plan'], measure: 'count' },
    ]);

    const scanned = plan({
      source: { event: 'error.unhandled' }, range: '7d', groupBy: ['attr:route'], measure: 'count',
    });
    expect(scanned.exactness).toBe('scan');
    expect(scanned.why).toMatch(/"attr:route" has no index/);
    expect(scanned.why).toMatch(/indexedAttrs/);
  });

  it('takes two dims, an interval and a limit; refuses three and an unknown one', () => {
    // `field:env` is not one of llm_cost's dims, so no family answers this
    const p = plan({
      source: { event: 'llm.completion' }, range: '7d', interval: 'day', limit: 10,
      groupBy: ['attr:gen_ai_request_model', 'field:env'], measure: 'sum:cost_usd',
    });
    expect(p.primitive).toBe('breakdown');
    expect(p.args[2]).toEqual({
      groupBy: ['attr:gen_ai_request_model', 'field:env'], measure: 'sum:cost_usd',
      interval: 'day', limit: 10,
    });
    expect(refusal({
      source: { event: 'llm.completion' }, range: '7d',
      groupBy: ['attr:gen_ai_request_model', 'attr:feature', 'field:env'],
    }).why).toMatch(/at most 2 dimensions/);
    expect(refusal({ source: { event: 'page.view' }, range: '7d', groupBy: ['attr:nonesuch'] }).why)
      .toMatch(/"attr:nonesuch" is not a dimension/);
  });

  it('groups by the subjectType pseudo-dim', () => {
    const p = plan({ source: { event: 'page.view' }, range: '7d', groupBy: ['subjectType'] });
    expect(p.primitive).toBe('breakdown');
    expect((p.args[2] as any).groupBy).toEqual(['subjectType']);
  });

  it('defaults the series interval from the range, exactly as the UI does', () => {
    expect((plan({ source: { event: 'page.view' }, range: '24h', measure: 'count' }).args[2] as any).interval)
      .toBe('hour');
    expect((plan({ source: { event: 'page.view' }, range: '90d', measure: 'count' }).args[2] as any).interval)
      .toBe('week');
    const week = plan({ source: { event: 'page.view' }, range: '7d', measure: 'count' });
    expect(week.primitive).toBe('series');
    expect(week.args).toEqual([rangeOf('7d', NOW), { name: 'page.view' }, { measure: 'count', interval: 'day' }]);
  });

  it('refuses a sum of a metric no source event declares, listing what there is', () => {
    const why = refusal({ source: { event: 'page.view' }, range: '7d', measure: 'sum:cost_usd' }).why;
    expect(why).toMatch(/cost_usd/);
    expect(why).toMatch(/`metrics` object of page\.view/);
  });

  it('shifts the range under compare', () => {
    const p = plan({ source: { event: 'page.view' }, range: PAIR, measure: 'count', compare: 'previous' });
    expect(p.previous!.args[0]).toEqual({
      from: new Date('2026-06-24T00:00:00.000Z'), to: new Date(PAIR.from),
    });
  });
});

describe('rule 6 — distribution', () => {
  it('plans a percentile off a declared metric', () => {
    const p = plan({ source: { event: 'llm.completion' }, range: '7d', measure: 'p95:cost_usd' });
    expect(p.primitive).toBe('distribution');
    expect(p.args).toEqual([rangeOf('7d', NOW), { name: 'llm.completion' }, { measure: 'cost_usd' }]);
    expect(p.why).toMatch(/approximate/);
  });

  it('reads a span durationMs, which lives on the envelope rather than in metrics', () => {
    const p = plan({ source: { event: 'llm.completion' }, range: '7d', measure: 'p50:durationMs' });
    expect(p.args[2]).toEqual({ measure: 'durationMs' });
  });

  it('answers avg:durationMs off series — the accumulator reads the envelope field', () => {
    // a span's duration is on the ENVELOPE, not in `metrics`. series() and
    // breakdown() know that now, so this is an ordinary raw plan rather than
    // the refusal it used to be
    const p = plan({ source: { event: 'llm.completion' }, range: '7d', measure: 'avg:durationMs' });
    expect(p.primitive).toBe('series');
    expect(p.args[2]).toEqual({ measure: 'avg:durationMs', interval: 'day' });
    expect(p.exactness).toBe('raw');

    const grouped = plan({
      source: { event: 'llm.completion' }, range: '7d', measure: 'avg:durationMs',
      groupBy: ['attr:gen_ai_request_model'],
    });
    expect(grouped.primitive).toBe('breakdown');
  });

  it('refuses a percentile per group — one distribution() per group is an open item', () => {
    expect(refusal({
      source: { event: 'llm.completion' }, range: '7d', measure: 'p95:cost_usd', groupBy: ['attr:feature'],
    }).why).toMatch(/per group are not offered yet/);
  });
});

describe('rule 7 — records, and the refusals', () => {
  it('returns the rows when nothing is asked about them', () => {
    const p = plan({ source: { event: 'page.view' }, range: '7d' });
    expect(p.primitive).toBe('records');
    expect(p.args).toEqual([rangeOf('7d', NOW), { name: 'page.view' }, {}]);
    expect(plan({ source: { event: 'page.view' }, range: '7d', limit: 20 }).args[2]).toEqual({ limit: 20 });
  });

  it('names the unknown event, namespace, family, measure and dim it was given', () => {
    expect(refusal({ source: { event: 'nope.gone' }, range: '7d' }).why).toMatch(/"nope\.gone"/);
    expect(refusal({ source: { namespace: 'nope' }, range: '7d' }).why).toMatch(/"nope\."/);
    expect(refusal({ source: { family: 'nope' }, range: '7d' }).why).toMatch(/as: 'nope'/);
    expect(refusal({ source: { kind: 'nope' as any }, range: '7d' }).why).toMatch(/kind "nope"/);
    expect(refusal({ source: { event: 'page.view' }, range: '7d', measure: 'median:x' }).why)
      .toMatch(/is not a measure/);
  });
});

describe('the record filter', () => {
  it('pins a namespace by the SET of names it expands to, which is exact', () => {
    const p = plan({ source: { namespace: 'dim' }, range: '7d', measure: 'count' });
    expect(p.args[1]).toEqual({ name: ['dim.probe', 'dim.defaulted'] });
    // an `$in` over the registry's own names is the source itself, not a
    // widening of it — so nothing here is a scan
    expect(p.exactness).toBe('raw');
    expect(p.why).not.toMatch(/no name-set term/);
  });

  it('spans two kinds without widening to both of them', () => {
    const p = plan({ source: { namespace: 'billing' }, range: '7d', measure: 'count' });
    expect(p.args[1]).toEqual({ name: ['billing.plan_selected', 'billing.ai_tokens'] });
    expect(p.exactness).toBe('raw');
  });

  it('pins a one-event namespace by name instead, which is exact', () => {
    const p = plan({ source: { namespace: 'page' }, range: '7d', measure: 'count' });
    expect(p.args[1]).toEqual({ name: 'page.view' });
    expect(p.exactness).toBe('raw');
    expect(p.why).not.toMatch(/no name-set term/);
  });

  it('takes a kind source as a complete term, since kind IS the filter', () => {
    const p = plan({ source: { kind: 'state' }, range: '7d', measure: 'count' });
    expect(p.args[1]).toEqual({ kind: 'state' });
    expect(p.exactness).toBe('raw');
  });

  it('maps envelope, attr and metric-bound filters, and passes excludeActorTypes through', () => {
    const p = plan({
      source: { event: 'llm.completion' }, range: '7d', measure: 'count',
      excludeActorTypes: ['admin'],
      filters: [
        { dim: 'field:env', op: 'eq', value: 'prod' },
        { dim: 'field:subject', op: 'eq', value: 'org:o1' },
        { dim: 'attr:feature', op: 'eq', value: 'chat' },
        { dim: 'attr:cost_usd', op: 'gte', value: 1 },
        { dim: 'attr:cost_usd', op: 'lte', value: 9 },
      ],
    });
    expect(p.args[1]).toEqual({
      name: 'llm.completion',
      env: 'prod',
      subject: 'org:o1',
      attrs: { feature: 'chat' },
      metrics: { cost_usd: { gte: 1, lte: 9 } },
      excludeActorTypes: ['admin'],
    });
    // env is not a base index, so touching it is a scan
    expect(p.exactness).toBe('scan');
  });

  it('refuses the filters RecordFilter cannot express, naming the alternative', () => {
    expect(refusal({
      source: { event: 'page.view' }, range: '7d', measure: 'count',
      filters: [{ dim: 'subjectType', op: 'eq', value: 'user' }],
    }).why).toMatch(/derived at query time from `subjectKeys`/);
    expect(refusal({
      source: { event: 'page.view' }, range: '7d', measure: 'count',
      filters: [{ dim: 'actorType', op: 'eq', value: 'admin' }],
    }).why).toMatch(/excludeActorTypes/);
    expect(refusal({
      source: { event: 'page.view' }, range: '7d', measure: 'count',
      filters: [{ dim: 'field:env', op: 'in', value: ['prod', 'dev'] }],
    }).why).toMatch(/equality only/);
    expect(refusal({
      source: { event: 'llm.completion' }, range: '7d', measure: 'count',
      filters: [{ dim: 'attr:feature', op: 'gte', value: 2 }],
    }).why).toMatch(/only a declared metric can carry/);
    expect(refusal({
      source: { event: 'llm.completion' }, range: '7d', measure: 'count',
      filters: [{ dim: 'field:client.platform', op: 'eq', value: 'web' }],
    }).why).toMatch(/not filterable on the raw path/);
  });
});

describe('normalizeQuery', () => {
  it('lifts every legacy key onto a Report', () => {
    expect(normalizeQuery({ range: '30d', filters: { name: 'page.view' } })).toEqual({
      source: { event: 'page.view' }, range: '30d',
    });
    expect(normalizeQuery({ filters: { kind: 'error' } })).toEqual({
      source: { kind: 'error' }, range: '7d',
    });
    expect(normalizeQuery({ range: '30d', filters: { rollup: 'llm_cost' } })).toEqual({
      source: { family: 'llm_cost' }, range: '30d',
    });
    expect(
      normalizeQuery({
        range: '7d',
        filters: {
          name: 'llm.completion', env: 'prod', service: 'api', release: 'r1', severity: 'error',
          subject: 'org:o1', traceId: 'tr_1', attrs: 'feature:chat,model:opus',
          excludeActorTypes: ['admin'],
        },
        groupBy: 'attr:feature',
        sort: 'value',
      }),
    ).toEqual({
      source: { event: 'llm.completion' },
      range: '7d',
      filters: [
        { dim: 'field:env', op: 'eq', value: 'prod' },
        { dim: 'field:service', op: 'eq', value: 'api' },
        { dim: 'field:release', op: 'eq', value: 'r1' },
        { dim: 'field:severity', op: 'eq', value: 'error' },
        { dim: 'field:subject', op: 'eq', value: 'org:o1' },
        { dim: 'field:traceId', op: 'eq', value: 'tr_1' },
        { dim: 'attr:feature', op: 'eq', value: 'chat' },
        { dim: 'attr:model', op: 'eq', value: 'opus' },
      ],
      groupBy: ['attr:feature'],
      sort: 'value',
      excludeActorTypes: ['admin'],
    });
    // the object form of attrs, and a kind kept beside a name source
    expect(normalizeQuery({ filters: { name: 'page.view', kind: 'event', attrs: { plan: 'pro' } } })!.filters)
      .toEqual([
        { dim: 'field:kind', op: 'eq', value: 'event' },
        { dim: 'attr:plan', op: 'eq', value: 'pro' },
      ]);
  });

  it('returns null when nothing identifies a source, and passes a Report through', () => {
    expect(normalizeQuery({ range: '7d' })).toBeNull();
    expect(normalizeQuery(undefined as any)).toBeNull();
    const report = { source: { event: 'page.view' }, range: '7d' } as const;
    expect(normalizeQuery(report)).toBe(report);
  });

  it('lifts every derived view into a Report the resolver accepts', () => {
    for (const view of deriveViews(paperRegistry())) {
      const report = normalizeQuery(view.query);
      expect(report, `${view.name} did not normalize`).not.toBeNull();
      const out = resolveReport(report!, catalog, { now: NOW });
      expect('primitive' in out, `${view.name}: ${(out as Unavailable).why}`).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('returns deep-equal plans for the same inputs', () => {
    const report: Report = {
      source: { event: 'llm.completion' }, range: '7d', interval: 'day',
      groupBy: ['attr:gen_ai_request_model'], measure: 'sum:cost_usd', compare: 'previous',
    };
    expect(resolveReport(report, catalog, { now: NOW })).toEqual(resolveReport(report, catalog, { now: NOW }));
  });
});
