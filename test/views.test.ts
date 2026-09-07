import { describe, expect, it } from 'vitest';
import { deriveCatalog, deriveViews, resolveReport, type Report, type Unavailable } from '../src/server/index.js';
import { paperRegistry } from './helpers.js';

/**
 * Derived views, pinned without Mongo — the same way deriveCatalog and
 * resolveReport are (reports §11.6). Three properties matter here and none of
 * them needs a database:
 *
 *   1. the five SHAPES exist, and each is generated for exactly the registry
 *      entries that can carry it;
 *   2. every derived query RESOLVES — a sidebar link that 400s is worse than
 *      no link, and nothing else in the package checks that these are legal;
 *   3. the list is DETERMINISTIC, because these names are the sidebar and a
 *      list that reshuffles is one nobody can bookmark.
 */

const registry = paperRegistry();
const catalog = deriveCatalog(registry);
const NOW = new Date('2026-07-10T00:00:00Z');

const views = () => deriveViews(registry);
const named = (prefix: string) => views().filter((v) => v.name.startsWith(prefix));
const query = (name: string) => views().find((v) => v.name === name)?.query as Report;

describe('deriveViews', () => {
  it('writes one Report per event, routed to its kind page', () => {
    const events = Object.keys(catalog.events);
    for (const name of events) {
      const v = views().find((x) => x.name === name);
      expect(v, `no view for ${name}`).toBeTruthy();
      expect(v!.query).toEqual({ source: { event: name }, range: '7d', interval: 'day' });
    }
    // the kind decides the page, exactly as it did before Reports
    expect(views().find((v) => v.name === 'error.unhandled')!.page).toBe('errors');
    expect(views().find((v) => v.name === 'llm.completion')!.page).toBe('traces');
    expect(views().find((v) => v.name === 'billing.ai_tokens')!.page).toBe('usage');
    expect(views().find((v) => v.name === 'account.lifecycle')!.page).toBe('journeys');
    expect(views().find((v) => v.name === 'page.view')!.page).toBe('events');
  });

  it('writes one Report per rollup family — the family read, which is always exact', () => {
    const families = Object.keys(catalog.families);
    expect(named('rollup: ')).toHaveLength(families.length);
    expect(query('rollup: llm_cost')).toEqual({ source: { family: 'llm_cost' }, range: '30d' });
    expect(resolveReport(query('rollup: llm_cost'), catalog, { now: NOW })).toMatchObject({
      primitive: 'rollups', exactness: 'exact', via: 'llm_cost',
    });
  });

  it('writes one Report per namespace, and skips namespaces of one event', () => {
    const multi = Object.entries(catalog.namespaces).filter(([, n]) => n.length > 1).map(([ns]) => ns);
    expect(multi.length).toBeGreaterThan(0);
    expect(named('namespace: ').map((v) => v.name.slice('namespace: '.length)).sort()).toEqual([...multi].sort());
    // `llm` has exactly one event, so it would be llm.completion's own view under
    // a second name — not a second question
    expect(query('namespace: llm')).toBeUndefined();
    expect(query('namespace: account')).toEqual({
      source: { namespace: 'account' }, range: '30d', interval: 'day', groupBy: ['field:name'],
    });
    expect(named('namespace: ').every((v) => v.page === 'explore')).toBe(true);
  });

  it('writes one spend Report per usage event that meters money, and none for the rest', () => {
    const usd = Object.entries(catalog.events).filter(
      ([, e]) => e.kind === 'usage' && e.measures.some((m) => m.key.startsWith('sum:') && m.key.endsWith('_usd')),
    );
    expect(named('spend: ')).toHaveLength(usd.length);
    expect(query('spend: billing.ai_tokens')).toEqual({
      source: { event: 'billing.ai_tokens' }, range: '30d', interval: 'day', measure: 'sum:cost_usd',
    });
    // and it is the exact read, off the family that already sums it
    expect(resolveReport(query('spend: billing.ai_tokens'), catalog, { now: NOW })).toMatchObject({
      primitive: 'rollups', exactness: 'exact', via: 'spend',
    });
  });

  it('writes one funnel per subject type with two or more milestones', () => {
    const milestones = (t: string) =>
      Object.values(catalog.families).filter(
        (f) => f.lifetime && f.by.length === 1 && f.by[0] === 'subject' && f.subjectTypes.includes(t),
      );
    const eligible = catalog.subjectTypes.filter((t) => milestones(t).length >= 2);
    expect(named('funnel: ')).toHaveLength(eligible.length);
    // 'user' has exactly one milestone family in the paper registry — one stage
    // is a count, not a funnel, and there is already a view for it
    expect(query('funnel: user')).toBeUndefined();
    expect(query('funnel: account')).toEqual({
      source: { family: 'account.signed_up' },
      range: '30d',
      interval: 'week',
      measure: 'funnel',
      stages: ['account.signed_up', 'data.first_viewed', 'account.converted'],
      anchor: 'account.signed_up',
      subjectType: 'account',
    });
    expect(named('funnel: ').every((v) => v.page === 'journeys')).toBe(true);
  });

  it('every derived Report resolves — a sidebar link that 400s is worse than no link', () => {
    for (const v of views()) {
      const plan = resolveReport(v.query as Report, catalog, { now: NOW });
      expect('primitive' in plan, `${v.name}: ${(plan as Unavailable).why}`).toBe(true);
    }
  });

  it('is deterministic, and derives its own catalog when none is passed', () => {
    expect(deriveViews(registry)).toEqual(deriveViews(registry));
    expect(deriveViews(registry, catalog)).toEqual(deriveViews(registry));
  });
});
