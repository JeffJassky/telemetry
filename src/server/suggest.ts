import type { Catalog } from './catalog.js';
import { COUNTER_OVERFLOW_KEY, type TelemetryCounters } from './types.js';

/**
 * The loop closed in the other direction (reports §9).
 *
 * Everywhere else in this package the registry tells the data what is allowed.
 * Here the data tells the registry what it is missing — and it can, because
 * nothing was ever dropped silently: `undeclaredAttrs` knows which attr key
 * keeps arriving undeclared, `rollupSkippedBy` knows which family keeps losing
 * which dim, and the quarantine knows which name nobody registered.
 *
 * Each of those is one registry line away from being fixed, so each suggestion
 * carries that line as `fix` — pasteable, not prose. Nothing here writes
 * anything: the host still edits the registry by hand. The package just stops
 * making it guess.
 *
 * Pure — no Mongo, no I/O — and unit-tested that way, like `deriveCatalog` and
 * `resolveReport`.
 */

export interface Suggestion {
  kind: 'undeclared_attr' | 'missing_dim_default' | 'unregistered_event';
  /** the registry entry to touch — an event name, or a rollup family name */
  target: string;
  /** attr key or dim label, when the suggestion is about one */
  key?: string;
  count: number;
  /** one sentence a human reads */
  message: string;
  /** the registry change, as code */
  fix: string;
}

export interface DeriveSuggestionsInput {
  counters: TelemetryCounters;
  catalog: Catalog;
  /**
   * The quarantine rows the caller already fetched. `name` and `reason` are all
   * that is read; the index signature is there so a driver's `WithId<Document>`
   * passes straight in without a cast.
   */
  quarantine?: readonly { name?: unknown; reason?: unknown; [k: string]: unknown }[];
}

/**
 * emit.ts and ingest.ts both quarantine an unknown name with exactly this
 * reason, and model.ts's hook throws `telemetry: unregistered event "x"` for
 * the direct-model path — a substring test matches all three without matching
 * anything else.
 */
const UNREGISTERED_REASON = 'unregistered event';

/** the returned list, capped. A System page is a thing a human reads. */
export const MAX_SUGGESTIONS = 50;

/**
 * Quarantine names are client-controlled, and `fix` is rendered as code. Cap
 * the length and quote anything that is not plainly a bare name, so a hostile
 * event name cannot be dressed up as surrounding syntax.
 */
const NAME_MAX = 120;
const quote = (s: string) => (/^[A-Za-z0-9_.:$-]+$/.test(s) ? `'${s}'` : JSON.stringify(s));
/** an object key that needs no quoting is written bare, the way a registry does */
const prop = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : quote(s));
const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`;

/** split `${target}|${key}` on the FIRST '|' — the key half may contain more */
const split = (k: string): [string, string] => {
  const i = k.indexOf('|');
  return i === -1 ? [k, ''] : [k.slice(0, i), k.slice(i + 1)];
};

export function deriveSuggestions(input: DeriveSuggestionsInput): Suggestion[] {
  const { counters, catalog, quarantine = [] } = input;
  const out: Suggestion[] = [];

  // ── undeclared attrs: the zod line that would let the record through ──
  for (const [k, count] of Object.entries(counters.undeclaredAttrs ?? {})) {
    // the fold-here bucket names no event and no key, so there is no line to
    // paste — it is a counter to look at, not a suggestion to act on
    if (k === COUNTER_OVERFLOW_KEY || !count) continue;
    const [name, key] = split(k);
    if (!name || !key) continue;

    const facet = catalog.events[name];
    const line = `${prop(key)}: z.string().max(64),`;
    // No attr dims at all means the spec declares no `attrs` object, and a bare
    // key line would have nothing to land in — so hand over the whole block.
    const hasAttrs = !!facet?.dims.some((d) => d.key.startsWith('attr:'));
    out.push({
      kind: 'undeclared_attr',
      target: name,
      key,
      count,
      message: `\`${name}\` has been sent with attr \`${key}\` ${times(count)} — not declared`,
      fix: hasAttrs ? line : `attrs: z.object({ ${prop(key)}: z.string().max(64) }),`,
    });
  }

  // ── skipped rollups: the dimDefault that would make the drop a group ──
  for (const [k, count] of Object.entries(counters.rollupSkippedBy ?? {})) {
    if (k === COUNTER_OVERFLOW_KEY || !count) continue;
    const [as, dim] = split(k);
    if (!as || !dim) continue;

    // Naming the feeders matters: `dimDefault` is declared per rollup on an
    // EVENT, not on the family, so "add it to `screens_viewed`" is not yet an
    // instruction — the catalog knows which specs to open.
    const feeders = catalog.families[as]?.feeders ?? [];
    const where = feeders.length
      ? `// on the \`${as}\` rollup of ${feeders.map((f) => `\`${f}\``).join(', ')}\n`
      : '';
    out.push({
      kind: 'missing_dim_default',
      target: as,
      key: dim,
      count,
      message:
        `\`${as}\` skipped ${count} record${count === 1 ? '' : 's'} with no \`${dim}\` — ` +
        'declare `dimDefault`',
      fix: `${where}dimDefault: 'unknown',`,
    });
  }

  // ── unregistered names: the stub that would stop the quarantine ──
  const unregistered = new Map<string, number>();
  for (const row of quarantine) {
    if (typeof row?.reason !== 'string' || !row.reason.includes(UNREGISTERED_REASON)) continue;
    const name = typeof row.name === 'string' ? row.name.slice(0, NAME_MAX) : '';
    if (!name || name === '(unnamed)') continue;
    unregistered.set(name, (unregistered.get(name) ?? 0) + 1);
  }
  for (const [name, count] of unregistered) {
    out.push({
      kind: 'unregistered_event',
      target: name,
      count,
      message: `\`${name}\` was rejected ${times(count)} — not in the registry`,
      // the minimum that boots: validateRegistry wants a kind, an origin, and
      // a subjects array, and nothing here can guess the rest
      fix: `${quote(name)}: { kind: 'event', origin: 'client', subjects: [], description: '' },`,
    });
  }

  // Loudest first. Ties break on target then key so the same counters always
  // produce the same page — a list that reshuffles between refreshes is one
  // nobody trusts.
  out.sort(
    (a, b) =>
      b.count - a.count ||
      a.target.localeCompare(b.target) ||
      (a.key ?? '').localeCompare(b.key ?? ''),
  );
  return out.slice(0, MAX_SUGGESTIONS);
}
