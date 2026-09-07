import { describe, expect, it } from 'vitest';
import { foldRollups, type RollupDoc } from '../src/server/execute.js';
import {
  parseReportQuery, reportToQuery, type PlanShape, type Report,
} from '../src/server/report.js';

/**
 * Two pure halves of the executor, pinned without a database.
 *
 * `foldRollups` is the one translation the executor performs, and it is the
 * whole exactness claim: a family's docs ARE the groups, so the fold must
 * produce the same numbers and the same row shape `breakdown()` returns over
 * the same facts. dashboard.test.ts proves the numbers against real Mongo; this
 * file pins the arithmetic, the filters, the bucketing and the order.
 *
 * `parseReportQuery`/`reportToQuery` are inverses, and that is a property, not
 * an example: a Report is a URL (reports §11.4), so anything that survives one
 * direction and not the other is a saved view that opens as a different
 * question than the one someone saved.
 */

// ── foldRollups ─────────────────────────────────────────────────────────────

const shape = (over: Partial<PlanShape> = {}): PlanShape => ({
  groupBy: ['attr:region'],
  labels: ['region'],
  measure: 'count',
  ...over,
});

/** a two-dim bucketed family: `by: ['attr:region', 'attr:channel']`, `sum: ['amount_usd']` */
const orders: RollupDoc[] = [
  { dims: ['region=eu', 'channel=web'], bucketAt: new Date('2026-07-06T00:00:00Z'), count: 3, sums: { amount_usd: 30 } },
  { dims: ['region=eu', 'channel=app'], bucketAt: new Date('2026-07-07T00:00:00Z'), count: 1, sums: { amount_usd: 5 } },
  { dims: ['region=us', 'channel=web'], bucketAt: new Date('2026-07-07T00:00:00Z'), count: 6, sums: { amount_usd: 12 } },
  { dims: ['region=us', 'channel=web'], bucketAt: new Date('2026-07-13T00:00:00Z'), count: 2, sums: { amount_usd: 8 } },
  { dims: ['region=apac', 'channel=app'], bucketAt: new Date('2026-07-13T00:00:00Z'), count: 4, sums: {} },
];

describe('foldRollups', () => {
  it('counts a family into the groups the requested dim names, top first', () => {
    const out = foldRollups(orders, shape());
    // eu and apac tie at 4, and the tie breaks on the dim tuple — the same
    // order breakdown()'s `{ value: -1, _id: 1 }` sort produces
    expect(out.rows).toEqual([
      { dims: ['us'], value: 8 },
      { dims: ['apac'], value: 4 },
      { dims: ['eu'], value: 4 },
    ]);
    expect(out.groups).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.dataSource).toBe('rollups');
    // no interval asked for, no time axis returned — exactly like breakdown()
    expect(out.rows.every((r) => r.at === undefined)).toBe(true);
  });

  it('sums a metric off `sums`, and averages it as Σsums / Σcount off the same docs', () => {
    expect(foldRollups(orders, shape({ measure: 'sum:amount_usd' })).rows).toEqual([
      { dims: ['eu'], value: 35 },
      { dims: ['us'], value: 20 },
      { dims: ['apac'], value: 0 },
    ]);
    // eu: 35/4, us: 20/8 — NOT the mean of the two docs' own averages, which
    // would weight a one-record bucket like a thousand-record one
    expect(foldRollups(orders, shape({ measure: 'avg:amount_usd' })).rows).toEqual([
      { dims: ['eu'], value: 8.75 },
      { dims: ['us'], value: 2.5 },
      { dims: ['apac'], value: 0 },
    ]);
  });

  it('groups by two dims, keeping the tuple in the requested order', () => {
    const out = foldRollups(orders, shape({ groupBy: ['attr:channel', 'attr:region'], labels: ['channel', 'region'] }));
    expect(out.rows).toEqual([
      { dims: ['web', 'us'], value: 8 },
      { dims: ['app', 'apac'], value: 4 },
      { dims: ['web', 'eu'], value: 3 },
      { dims: ['app', 'eu'], value: 1 },
    ]);
    expect(out.groups).toBe(4);
  });

  it('applies an `eq` filter on a family dim the groupBy does not mention', () => {
    const out = foldRollups(
      orders,
      shape({ filters: [{ dim: 'attr:channel', label: 'channel', op: 'eq', value: 'web' }] }),
    );
    expect(out.rows).toEqual([
      { dims: ['us'], value: 8 },
      { dims: ['eu'], value: 3 },
    ]);
    expect(out.groups).toBe(2); // apac is app-only, so it is not a group at all
  });

  it('applies an `in` filter as set membership', () => {
    const out = foldRollups(
      orders,
      shape({ filters: [{ dim: 'attr:region', label: 'region', op: 'in', value: ['eu', 'apac'] }] }),
    );
    expect(out.rows.map((r) => r.dims[0])).toEqual(['apac', 'eu']);
  });

  it('keeps a subject dim as its native `type:id` ref — no `label=` prefix was ever written', () => {
    const activity: RollupDoc[] = [
      { dims: ['account:a1'], bucketAt: new Date('2026-07-06T00:00:00Z'), count: 2 },
      { dims: ['account:a1'], bucketAt: new Date('2026-07-07T00:00:00Z'), count: 1 },
      { dims: ['account:a2'], bucketAt: new Date('2026-07-07T00:00:00Z'), count: 5 },
    ];
    const out = foldRollups(activity, shape({ groupBy: ['subjectType'], labels: ['subject'] }));
    expect(out.rows).toEqual([
      { dims: ['account:a2'], value: 5 },
      { dims: ['account:a1'], value: 3 },
    ]);
    // and a filter compares against the whole ref
    expect(
      foldRollups(
        activity,
        shape({
          groupBy: ['subjectType'],
          labels: ['subject'],
          filters: [{ dim: 'subjectType', label: 'subject', op: 'eq', value: 'account:a1' }],
        }),
      ).rows,
    ).toEqual([{ dims: ['account:a1'], value: 3 }]);
  });

  it('rolls day buckets up into Monday-start weeks and orders rows by `at`', () => {
    const out = foldRollups(orders, shape({ interval: 'week' }));
    // 2026-07-06 and -07-07 are the same (Monday) week; -07-13 is the next
    expect(out.rows).toEqual([
      { dims: ['eu'], at: new Date('2026-07-06T00:00:00Z'), value: 4 },
      { dims: ['us'], at: new Date('2026-07-06T00:00:00Z'), value: 6 },
      { dims: ['apac'], at: new Date('2026-07-13T00:00:00Z'), value: 4 },
      { dims: ['us'], at: new Date('2026-07-13T00:00:00Z'), value: 2 },
    ]);
    // `groups` counts GROUPS, never rows — the same thing breakdown() reports
    expect(out.groups).toBe(3);
  });

  it('truncates on the primitive it folded rather than re-deriving it', () => {
    expect(foldRollups(orders, shape(), true).truncated).toBe(true);
    expect(foldRollups([], shape()).rows).toEqual([]);
    expect(foldRollups([], shape()).groups).toBe(0);
  });

  it('reads `sums` off a hydrated Map as readily as off a lean object', () => {
    const rows: RollupDoc[] = [
      { dims: ['region=eu'], count: 2, sums: new Map([['amount_usd', 9]]) },
    ];
    expect(foldRollups(rows, shape({ measure: 'sum:amount_usd' })).rows).toEqual([
      { dims: ['eu'], value: 9 },
    ]);
  });
});

// ── the URL form ────────────────────────────────────────────────────────────

/**
 * Every field, every shape a Report can take — and the encoding hazards on
 * purpose: a value carrying a `:`, a dim that is itself `attr:x` (so the term
 * has three colons before the value), several filters (the repeated param),
 * and an `in` list (the reason a filter cannot be comma-joined into one param).
 */
const ROUND_TRIP: Array<[string, Report]> = [
  ['the smallest thing that is a Report', { source: { event: 'page.view' }, range: '7d' }],
  [
    'a namespace source with an explicit ISO pair',
    { source: { namespace: 'billing' }, range: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' } },
  ],
  ['a kind source', { source: { kind: 'error' as any }, range: '24h', measure: 'count', interval: 'hour' }],
  [
    'a family source with every rendering hint',
    {
      source: { family: 'llm_cost' },
      range: '30d',
      interval: 'day',
      measure: 'sum:cost_usd',
      groupBy: ['attr:gen_ai_request_model', 'attr:feature'],
      sort: 'value',
      limit: 25,
      compare: 'previous',
    },
  ],
  [
    'one filter whose dim is itself prefixed',
    {
      source: { event: 'llm.completion' },
      range: '7d',
      filters: [{ dim: 'attr:gen_ai_request_model', op: 'eq', value: 'opus' }],
    },
  ],
  [
    'a filter whose VALUE contains a colon',
    {
      source: { event: 'page.view' },
      range: '7d',
      filters: [{ dim: 'field:subject', op: 'eq', value: 'user:u_1' }],
    },
  ],
  [
    'several filters, an `in` list and a numeric bound among them',
    {
      source: { event: 'llm.completion' },
      range: '7d',
      filters: [
        { dim: 'attr:gen_ai_request_model', op: 'in', value: ['opus', 'sonnet'] },
        { dim: 'field:env', op: 'eq', value: 'prod' },
        { dim: 'attr:cost_usd', op: 'gte', value: 0.5 },
      ],
      excludeActorTypes: ['admin', 'system'],
    },
  ],
  [
    'a funnel, with every cohort field',
    {
      source: { event: 'account.signed_up' },
      range: '90d',
      measure: 'funnel',
      interval: 'week',
      stages: ['account.signed_up', 'data.first_viewed', 'account.converted'],
      anchor: 'account.signed_up',
      exits: ['account.lifecycle'],
      subjectType: 'account',
    },
  ],
  [
    'a distinct count with a groupBy-free shape',
    { source: { event: 'account.signed_up' }, range: '30d', measure: 'distinct:account', interval: 'day' },
  ],
];

describe('parseReportQuery / reportToQuery', () => {
  it.each(ROUND_TRIP)('round-trips %s', (_label, report) => {
    expect(parseReportQuery(reportToQuery(report) as Record<string, unknown>)).toEqual(report);
  });

  it('writes the flat URL a person can read, and repeats `filter` rather than joining it', () => {
    const q = reportToQuery({
      source: { event: 'llm.completion' },
      range: '7d',
      measure: 'sum:cost_usd',
      groupBy: ['attr:gen_ai_request_model', 'field:client.platform'],
      filters: [
        { dim: 'attr:feature', op: 'eq', value: 'chat' },
        { dim: 'field:env', op: 'in', value: ['prod', 'staging'] },
      ],
      excludeActorTypes: ['admin'],
      compare: 'previous',
    });
    expect(q).toEqual({
      source: 'event:llm.completion',
      range: '7d',
      measure: 'sum:cost_usd',
      groupBy: 'attr:gen_ai_request_model,field:client.platform',
      filter: ['attr:feature:eq:chat', 'field:env:in:prod,staging'],
      excludeActors: 'admin',
      compare: 'previous',
    });
    // one term stays a string — the shape express hands back for a single param
    expect(
      reportToQuery({ source: { event: 'x' }, range: '7d', filters: [{ dim: 'field:env', op: 'eq', value: 'prod' }] }).filter,
    ).toBe('field:env:eq:prod');
  });

  it('accepts a single `filter` as a string and several as the repeated-param array', () => {
    const one = parseReportQuery({ source: 'event:x', range: '7d', filter: 'field:env:eq:prod' });
    const two = parseReportQuery({
      source: 'event:x', range: '7d', filter: ['field:env:eq:prod', 'attr:plan:in:pro,team'],
    });
    expect(one.filters).toEqual([{ dim: 'field:env', op: 'eq', value: 'prod' }]);
    expect(two.filters).toEqual([
      { dim: 'field:env', op: 'eq', value: 'prod' },
      { dim: 'attr:plan', op: 'in', value: ['pro', 'team'] },
    ]);
  });

  it('ignores params it does not know rather than refusing a URL with a scroll position in it', () => {
    const r = parseReportQuery({ source: 'event:x', range: '7d', page: 'events', cursor: 'abc', display: 'series' });
    expect(r).toEqual({ source: { event: 'x' }, range: '7d' });
  });

  it('refuses a malformed filter with a 400 naming the param', () => {
    for (const term of ['attr:plan', 'attr:plan:like:pro', 'eq:pro', 'attr:plan:eq:']) {
      let thrown: any;
      try {
        parseReportQuery({ source: 'event:x', range: '7d', filter: term });
      } catch (e) {
        thrown = e;
      }
      expect(thrown?.status, term).toBe(400);
      expect(thrown.message, term).toMatch(/`filter`/);
    }
    let bound: any;
    try {
      parseReportQuery({ source: 'event:x', range: '7d', filter: 'attr:cost:gte:cheap' });
    } catch (e) {
      bound = e;
    }
    expect(bound.status).toBe(400);
    expect(bound.message).toMatch(/is not a number/);
  });

  it('refuses an unknown source prefix, a missing source, and a missing range', () => {
    const bad = (q: Record<string, unknown>) => {
      let thrown: any;
      try {
        parseReportQuery(q);
      } catch (e) {
        thrown = e;
      }
      expect(thrown?.status).toBe(400);
      return thrown.message as string;
    };
    expect(bad({ source: 'metric:cost_usd', range: '7d' })).toMatch(/`source` must be/);
    expect(bad({ source: 'llm.completion', range: '7d' })).toMatch(/`source` must be/);
    expect(bad({ source: 'event:', range: '7d' })).toMatch(/`source` must be/);
    expect(bad({ range: '7d' })).toMatch(/`source` is required/);
    expect(bad({ source: 'event:x' })).toMatch(/range is required/);
    expect(bad({ source: 'event:x', from: '2026-07-01T00:00:00Z' })).toMatch(/range is required/);
  });

  it('refuses the enumerated params rather than silently answering a different question', () => {
    const bad = (q: Record<string, unknown>) => {
      try {
        parseReportQuery({ source: 'event:x', range: '7d', ...q });
      } catch (e: any) {
        return e.message as string;
      }
      throw new Error(`expected a refusal for ${JSON.stringify(q)}`);
    };
    expect(bad({ interval: 'fortnight' })).toMatch(/`interval` must be/);
    expect(bad({ sort: 'sideways' })).toMatch(/`sort` must be/);
    expect(bad({ compare: 'last-year' })).toMatch(/`compare` takes only/);
    expect(bad({ limit: '0' })).toMatch(/`limit` must be/);
    expect(bad({ limit: 'many' })).toMatch(/`limit` must be/);
  });

  it('prefers the range shorthand when a URL carries both it and the shell\'s from/to', () => {
    const r = parseReportQuery({
      source: 'event:x', range: '24h', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z',
    });
    expect(r.range).toBe('24h');
  });
});
