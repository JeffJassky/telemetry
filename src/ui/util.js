import {
  intervalForRange, normalizeQuery, parseReportQuery, rangeOf, reportToQuery, resolveReport,
} from '../server/report.ts';

/**
 * Formatting is convention, not configuration (dashboards §4):
 * *_usd → currency · *_ms / duration* → duration · tokens_* / counts →
 * compact · timestamps → relative under 24h.
 *
 * And ONE encoder, ONE resolver. `report.ts` is pure — type-only imports, no
 * Mongo, no express — so the SPA imports the same file the router does rather
 * than reimplementing the grammar beside it. A second implementation of
 * `filter=<dim>:<op>:<value>` is a shared link that means two different things
 * depending on which half of the package read it. (Verify after every build:
 * `grep -c mongoose dist/ui/_assets/*.js` must be 0. If it ever is not, the
 * fix is report.ts's imports, never a copy of them here.)
 */
export {
  intervalForRange, normalizeQuery, parseReportQuery, rangeOf, reportToQuery, resolveReport,
};

export const KIND_COLOR = {
  error: 'var(--red)',
  state: 'var(--amber)',
  event: 'var(--blue)',
  span: 'var(--violet)',
  usage: 'var(--green)',
};

export const KIND_PILL = { error: 'red', state: 'amber', event: 'blue', span: 'violet', usage: 'green' };

export const SEVERITY_PILL = { fatal: 'red', error: 'red', warn: 'amber', info: 'blue', debug: '' };

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat();

export function fmtNumber(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return Math.abs(v) >= 10_000 ? compact.format(v) : plain.format(Math.round(v * 100) / 100);
}

export function fmtUsd(v) {
  if (v == null) return '—';
  // exactly nothing is "$0", not "$0.0000" — sub-cent precision is for
  // amounts that exist but are small
  if (v === 0) return '$0';
  return v < 1
    ? `$${v.toFixed(v < 0.01 ? 4 : 2)}`
    : `$${plain.format(Math.round(v * 100) / 100)}`;
}

export function fmtMs(v) {
  if (v == null) return '—';
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${(v / 60_000).toFixed(1)}m`;
  if (v < 86_400_000) return `${(v / 3_600_000).toFixed(1)}h`;
  return `${(v / 86_400_000).toFixed(1)}d`;
}

/** the convention dispatcher — key decides the format */
export function fmtMetric(key, v) {
  if (/_usd$/.test(key)) return fmtUsd(v);
  if (/_ms$/.test(key) || /^duration/.test(key)) return fmtMs(v);
  return fmtNumber(v);
}

/**
 * A MeasureFacet.key formats as its metric: a `sum:` of a `*_usd` key is money,
 * a `p95:` of a `*_ms` one is a duration, and the rest are numbers.
 * Same convention as fmtMetric, reached from the other end.
 */
export function fmtMeasure(measure, v) {
  return fmtMetric(metricOf(measure), v);
}

/** the metric a measure key names, or 'count' when it names none */
export function metricOf(measure = 'count') {
  const cut = measure.indexOf(':');
  return cut === -1 ? measure : measure.slice(cut + 1);
}

export function fmtTime(iso) {
  const d = new Date(iso);
  const ago = Date.now() - d.getTime();
  if (ago < 60_000) return 'just now';
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtClock(iso) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
}

/** a 0–100 percentage. Display rounds; the API value never does. */
export function fmtPct(v) {
  if (v == null) return '—';
  return `${Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;
}

/** fractional days as a human span — under a day reads better in hours */
export function fmtDays(v) {
  if (v == null) return '—';
  if (Math.abs(v) < 1) return `${Math.round(v * 24 * 10) / 10}h`;
  return `${Math.round(v * 10) / 10}d`;
}

/**
 * range shorthand → {from,to} ISO pair, off the server's own arithmetic. A
 * shorthand the server does not know THROWS there and defaults to 7d here: on
 * the client a wrong default draws a chart nobody asked for, which is worse
 * than a chart of the last week.
 */
export function rangeToDates(range) {
  const iso = (r) => {
    const { from, to } = rangeOf(r);
    return { from: from.toISOString(), to: to.toISOString() };
  };
  try {
    return iso(range);
  } catch {
    return iso('7d');
  }
}

/**
 * Every shorthand `rangeOf` knows. '1y' is deliberately absent: report.ts
 * recognises `<n>h`/`<n>d` and the five below, and a chip the server would
 * refuse is exactly the "greyed option beats a 400" rule inverted.
 */
export const RANGES = ['1h', '24h', '7d', '30d', '90d'];

/** interval that keeps a range under ~120 buckets — the server's rule, shared */
export function intervalFor(range) {
  try {
    return intervalForRange(range);
  } catch {
    return 'day';
  }
}

/* ── URL state: the hash IS the view (dashboards law 6) ── */

/**
 * A repeated param becomes an array, exactly as express's parser hands one to
 * `parseReportQuery` — `filter` is the key that repeats, because an `in` list is
 * itself a comma list and could not be joined with one. Every other param is a
 * single string and reads as one.
 */
export function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const params = {};
  for (const [k, v] of new URLSearchParams(qs ?? '')) {
    if (k in params) params[k] = Array.isArray(params[k]) ? [...params[k], v] : [params[k], v];
    else params[k] = v;
  }
  const [page, ...rest] = (path || 'overview').split('/');
  // toHash() encodes the arg; decode symmetrically or refs like 'user:u_1'
  // reach the API as 'user%3Au_1' and silently match nothing
  return { page: page || 'overview', arg: rest.length ? decodeURIComponent(rest.join('/')) : null, params };
}

export function toHash(page, params = {}, arg = null) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    // append, never set: the repeated form is the only way a URL can carry two
    // filter terms whose values contain commas
    if (Array.isArray(v)) for (const one of v) { if (one != null && one !== '') qs.append(k, String(one)); }
    else qs.set(k, String(v));
  }
  return `#/${page}${arg ? `/${encodeURIComponent(arg)}` : ''}${qs.size ? `?${qs}` : ''}`;
}

export function navigate(page, params = {}, arg = null) {
  window.location.hash = toHash(page, params, arg);
}

/* ── the hash IS a Report (reports §11.4) ── */

/** a ReportSource → the `source=` term, which is the only encoding of one */
export function sourceParam(source) {
  if (!source) return undefined;
  if (source.event) return `event:${source.event}`;
  if (source.namespace) return `namespace:${source.namespace}`;
  if (source.kind) return `kind:${source.kind}`;
  if (source.family) return `family:${source.family}`;
  return undefined;
}

/** the human half of the same thing — what a picker shows for a source */
export function sourceLabel(source) {
  return sourceParam(source) ?? '—';
}

/** `source=` term → a ReportSource, read by the same parser the router uses */
export function sourceFromParam(term) {
  if (!term) return null;
  try {
    return parseReportQuery({ source: term, range: '7d' }).source;
  } catch {
    return null;
  }
}

/**
 * The event names a source expands to — what `/values` needs for `names`, and
 * what tells the FilterBar which dims exist. It mirrors the resolver's own
 * expansion; a source it cannot expand yields nothing rather than everything,
 * because a filter offered over every event in the instance is a filter that
 * lies about what it will match.
 */
export function sourceEvents(catalog, source) {
  if (!catalog || !source) return [];
  if (source.event) return catalog.events[source.event] ? [source.event] : [];
  if (source.namespace) return [...(catalog.namespaces[source.namespace] ?? [])];
  if (source.kind) return Object.keys(catalog.events).filter((n) => catalog.events[n].kind === source.kind);
  if (source.family) return [...(catalog.families[source.family]?.feeders ?? [])];
  return [];
}

/**
 * The route's params, read as a Report. `null` on a partial or empty URL — an
 * Explore page with no source yet is not a broken report, it is a builder
 * waiting for its first control, and asking anyway would 400.
 */
export function reportFromRoute(route) {
  try {
    return parseReportQuery(route.params ?? {});
  } catch {
    return null;
  }
}

/**
 * The same, for a page whose source is fixed by the page rather than the URL
 * (Events is `kind: 'event'` and Journeys' funnel is its anchor family). The
 * range defaults the way the shell's chips do, so a bare `#/events` still asks
 * a whole question.
 */
export function reportFromParams(params = {}, source, fallbackRange = '7d') {
  const term = sourceParam(source);
  if (!term) return null;
  try {
    return parseReportQuery({ range: fallbackRange, ...params, source: term });
  } catch {
    return null;
  }
}

/** a Report → the hash that reproduces it. `parseReportQuery` reads it back. */
export function hashForReport(page, report, arg = null) {
  return toHash(page, reportToQuery(report), arg);
}

/**
 * The `filter=` terms already on a URL, parsed by the SAME grammar the server
 * uses. The parser only exists as part of a whole Report, so it is handed a
 * throwaway source and range and asked for the filters it found — cheaper than
 * a second implementation of an escaping rule, and it cannot drift from one.
 */
export function filtersFromParams(params = {}) {
  if (params.filter == null) return [];
  try {
    return parseReportQuery({ source: 'kind:event', range: '7d', filter: params.filter }).filters ?? [];
  } catch {
    return [];
  }
}

/** the inverse — filter terms back onto a params object, dropping the key when empty */
export function paramsWithFilters(params, filters) {
  const terms = filters.map(
    (f) => `${f.dim}:${f.op}:${Array.isArray(f.value) ? f.value.join(',') : String(f.value)}`,
  );
  return { ...params, filter: terms.length ? terms : undefined };
}
