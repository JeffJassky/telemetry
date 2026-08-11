/**
 * Formatting is convention, not configuration (dashboards §4):
 * *_usd → currency · *_ms / duration* → duration · tokens_* / counts →
 * compact · timestamps → relative under 24h.
 */

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

/** range shorthand → {from,to} ISO pair */
export function rangeToDates(range) {
  const to = new Date();
  const ms = { '1h': 36e5, '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '90d': 90 * 864e5 }[range] ?? 7 * 864e5;
  return { from: new Date(to.getTime() - ms).toISOString(), to: to.toISOString() };
}

export const RANGES = ['1h', '24h', '7d', '30d', '90d'];

/** interval that keeps a range under ~120 buckets */
export function intervalFor(range) {
  return range === '1h' || range === '24h' ? 'hour' : range === '90d' ? 'week' : 'day';
}

/* ── URL state: the hash IS the view (dashboards law 6) ── */

export function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs ?? ''));
  const [page, ...rest] = (path || 'overview').split('/');
  // toHash() encodes the arg; decode symmetrically or refs like 'user:u_1'
  // reach the API as 'user%3Au_1' and silently match nothing
  return { page: page || 'overview', arg: rest.length ? decodeURIComponent(rest.join('/')) : null, params };
}

export function toHash(page, params = {}, arg = null) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  return `#/${page}${arg ? `/${encodeURIComponent(arg)}` : ''}${qs.size ? `?${qs}` : ''}`;
}

export function navigate(page, params = {}, arg = null) {
  window.location.hash = toHash(page, params, arg);
}
