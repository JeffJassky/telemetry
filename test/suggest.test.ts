import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COUNTER_OVERFLOW_KEY, MAX_SUGGESTIONS, defineRegistry, deriveCatalog, deriveSuggestions,
  type Suggestion, type TelemetryCounters,
} from '../src/server/index.js';

/**
 * deriveSuggestions is pure — counters + catalog + the quarantine rows the
 * caller already has, in; registry lines, out. No Mongo, like deriveCatalog and
 * resolveReport, and pinned the same way (reports §11.6).
 *
 * The assertion that matters in every case is `fix`: it has to be code someone
 * can paste into their registry, not a description of the code they should
 * write. A suggestion whose fix reads "add the attr" would be worth nothing.
 */

const REGISTRY = defineRegistry({
  'import.started': {
    kind: 'event', origin: 'client', subjects: ['user'],
    attrs: z.object({ source: z.string().max(64) }),
    description: 'An import began',
  },
  'screen.viewed': {
    kind: 'event', origin: 'client', subjects: ['user'],
    // no `attrs` at all — the whole-block fix variant
    rollups: [{ as: 'screens_viewed', by: ['attr:name'] }],
    description: 'A screen was shown',
  },
  'screen.closed': {
    kind: 'event', origin: 'client', subjects: ['user'],
    attrs: z.object({ name: z.string().max(64).optional() }),
    // a SECOND feeder of the same family — `dimDefault` is declared per event,
    // so the fix has to name both specs to open
    rollups: [{ as: 'screens_viewed', by: ['attr:name'] }],
    description: 'A screen was dismissed',
  },
});

const CATALOG = deriveCatalog(REGISTRY);

/** counters with only the two attributed maps filled — the rest never read here */
const counters = (over: Partial<TelemetryCounters> = {}): TelemetryCounters => ({
  rejected: 0, defaulted: 0, sampled: 0, capped: 0, rollupSkipped: 0,
  deduped: 0, truncated: 0, rollupSkippedBy: {}, undeclaredAttrs: {},
  ...over,
});

const derive = (over: Partial<TelemetryCounters> = {}, quarantine?: any[]): Suggestion[] =>
  deriveSuggestions({ counters: counters(over), catalog: CATALOG, quarantine });

const one = (s: Suggestion[], kind: Suggestion['kind']) => s.find((x) => x.kind === kind)!;

describe('deriveSuggestions — the data tells the registry', () => {
  it('no counters and no quarantine is an empty list, not a page of encouragement', () => {
    expect(derive()).toEqual([]);
    expect(deriveSuggestions({ counters: counters(), catalog: CATALOG })).toEqual([]);
  });

  it('an undeclared attr on a spec that HAS attrs suggests the one zod line to add', () => {
    const s = one(derive({ undeclaredAttrs: { 'import.started|codec': 41 } }), 'undeclared_attr');
    expect(s.target).toBe('import.started');
    expect(s.key).toBe('codec');
    expect(s.count).toBe(41);
    expect(s.message).toBe(
      '`import.started` has been sent with attr `codec` 41 times — not declared',
    );
    // pasteable INTO the existing z.object, because there is one
    expect(s.fix).toBe('codec: z.string().max(64),');
  });

  it('an undeclared attr on a spec with NO attrs schema suggests the whole block', () => {
    // a bare `codec: …` line would have nothing to land in — the catalog knows
    // this event declares no attr dims at all
    const s = one(derive({ undeclaredAttrs: { 'screen.viewed|codec': 3 } }), 'undeclared_attr');
    expect(s.fix).toBe('attrs: z.object({ codec: z.string().max(64) }),');
    expect(s.message).toContain('3 times');
  });

  it('a skipped rollup dim suggests dimDefault, and names every spec that feeds the family', () => {
    const s = one(derive({ rollupSkippedBy: { 'screens_viewed|name': 12 } }), 'missing_dim_default');
    expect(s.target).toBe('screens_viewed');
    expect(s.key).toBe('name');
    expect(s.message).toBe(
      '`screens_viewed` skipped 12 records with no `name` — declare `dimDefault`',
    );
    // the family is not a place you can edit — the two feeders are
    expect(s.fix).toBe(
      "// on the `screens_viewed` rollup of `screen.viewed`, `screen.closed`\ndimDefault: 'unknown',",
    );
  });

  it('an unknown family still suggests the line, just without the feeders comment', () => {
    const s = one(derive({ rollupSkippedBy: { 'gone|dim': 1 } }), 'missing_dim_default');
    expect(s.fix).toBe("dimDefault: 'unknown',");
    expect(s.message).toContain('skipped 1 record with no'); // singular
  });

  it('unregistered names group out of the quarantine into one stub per name', () => {
    const s = derive({}, [
      { name: 'video.exported', reason: 'unregistered event' },
      { name: 'video.exported', reason: 'unregistered event' },
      { name: 'video.exported', reason: 'telemetry: unregistered event "video.exported"' },
      { name: 'import.started', reason: 'telemetry: attrs invalid for "import.started": …' },
      { name: '(unnamed)', reason: 'unregistered event' },
    ]);
    expect(s).toHaveLength(1); // the attrs failure is a different reason; (unnamed) names nothing
    expect(s[0]!.kind).toBe('unregistered_event');
    expect(s[0]!.target).toBe('video.exported');
    expect(s[0]!.count).toBe(3); // both wordings of the same refusal
    expect(s[0]!.key).toBeUndefined();
    expect(s[0]!.message).toBe('`video.exported` was rejected 3 times — not in the registry');
    expect(s[0]!.fix).toBe(
      "'video.exported': { kind: 'event', origin: 'client', subjects: [], description: '' },",
    );
  });

  it('the fold-here bucket is a counter to look at, never a suggestion — it names no registry entry', () => {
    const s = derive({
      undeclaredAttrs: { [COUNTER_OVERFLOW_KEY]: 9_000, 'import.started|codec': 1 },
      rollupSkippedBy: { [COUNTER_OVERFLOW_KEY]: 9_000 },
    });
    expect(s.map((x) => x.target)).toEqual(['import.started']);
  });

  it('loudest first, and capped at 50 — a System page is a thing a human reads', () => {
    const undeclaredAttrs: Record<string, number> = {};
    for (let i = 0; i < 80; i++) undeclaredAttrs[`import.started|k${i}`] = i + 1;
    const s = derive({ undeclaredAttrs });

    expect(s).toHaveLength(MAX_SUGGESTIONS);
    expect(s[0]!.count).toBe(80);
    expect(s[MAX_SUGGESTIONS - 1]!.count).toBe(31); // the top 50 of 80, by count
    expect(s.map((x) => x.count)).toEqual([...s.map((x) => x.count)].sort((a, b) => b - a));
  });

  it('ties break deterministically, so the same counters never reshuffle between refreshes', () => {
    const input = {
      undeclaredAttrs: { 'import.started|zeta': 5, 'import.started|alpha': 5 },
      rollupSkippedBy: { 'screens_viewed|name': 5 },
    };
    const first = derive(input).map((x) => `${x.target}|${x.key}`);
    expect(first).toEqual(derive(input).map((x) => `${x.target}|${x.key}`));
    expect(first).toEqual(['import.started|alpha', 'import.started|zeta', 'screens_viewed|name']);
  });

  it('all three kinds come back from one call, each carrying its own fix', () => {
    const s = derive(
      {
        undeclaredAttrs: { 'import.started|codec': 41 },
        rollupSkippedBy: { 'screens_viewed|name': 12 },
      },
      [{ name: 'video.exported', reason: 'unregistered event' }],
    );
    expect(s.map((x) => x.kind)).toEqual([
      'undeclared_attr', 'missing_dim_default', 'unregistered_event',
    ]);
    for (const x of s) expect(x.fix.length).toBeGreaterThan(0);
  });

  it('a hostile event name cannot dress itself up as surrounding syntax', () => {
    // the quarantine `name` is whatever a client sent; `fix` is rendered as code
    const s = derive({}, [{ name: "x', origin: 'server", reason: 'unregistered event' }]);
    expect(s[0]!.fix).toContain('"x\', origin: \'server"'); // quoted, not spliced
    expect(s[0]!.fix.startsWith('"')).toBe(true);
  });
});
