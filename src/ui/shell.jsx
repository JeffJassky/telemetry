import React from 'react';
import {
  RANGES, filtersFromParams, hashForReport, navigate, normalizeQuery,
  paramsWithFilters, rangeToDates, sourceEvents, toHash,
} from './util.js';

/**
 * Shell chrome (dashboards §3) — exists because the ENVELOPE guarantees the
 * field: range/bucket, env/service, kind/name, subject scope, severity, and
 * the catalog-generated filter bar. Every control writes URL state.
 *
 * Nothing here names an event, an attr or a metric (reports §11.1). The page
 * list is the only literal vocabulary in this file, and a page is a route.
 */

const PAGES = [
  ['overview', 'Overview', '◎'],
  ['errors', 'Errors', '⚠'],
  ['traces', 'Traces', '⋔'],
  ['events', 'Events', '◷'],
  ['explore', 'Explore', '◈'],
  ['journeys', 'Journeys', '➾'],
  ['usage', 'Usage', '¤'],
  ['system', 'System', '⚙'],
];

/** derived views per section before the fold — the sidebar is a menu, not an index */
const SECTION_MAX = 12;

export function Sidebar({ route, views, title, platform }) {
  const grouped = React.useMemo(() => {
    const custom = (views ?? []).filter((v) => v.origin !== 'derived');
    const derived = (views ?? []).filter((v) => v.origin === 'derived');
    const byPage = {};
    for (const v of derived) (byPage[v.page] ??= []).push(v);
    return { custom, byPage };
  }, [views]);

  /**
   * A view is a URL, and now the URL is its Report — one encoder for the link,
   * the API call and the saved spec. A view whose stored query predates Reports
   * names no source; `normalizeQuery` says so by returning null, and the legacy
   * flat form still links the way it always did.
   */
  const hrefOf = (v) => {
    const report = normalizeQuery(v.query);
    if (report) return hashForReport(v.page, report);
    const q = v.query ?? {};
    return toHash(v.page, { range: q.range ?? '7d', ...(q.filters ?? {}) });
  };

  const link = (v) => (
    <a key={`${v.origin}:${v.name}`} className="sidebar-link" href={hrefOf(v)} title={v.name}>
      {/* a view's own icon wins; without one the origin badge says where it came from */}
      <span className="icon">{v.icon || (v.origin === 'saved' ? '★' : v.origin === 'configured' ? '◆' : '·')}</span>
      {v.name}
    </a>
  );

  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-logo">◬</div>
        <div className="sidebar-brand-name">{title ?? 'Telemetry'}</div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-nav">
          {PAGES.map(([page, label, icon]) => (
            <a key={page} className={`sidebar-link ${route.page === page ? 'active' : ''}`} href={toHash(page, { range: route.params.range ?? '7d' })}>
              <span className="icon">{icon}</span>
              {label}
            </a>
          ))}
        </div>
      </div>

      {grouped.custom.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">Views</div>
          <div className="sidebar-nav">{grouped.custom.map(link)}</div>
        </div>
      )}

      {Object.entries(grouped.byPage).map(([page, list]) => (
        <div className="sidebar-section" key={page}>
          <div className="sidebar-section-title">{page}</div>
          <div className="sidebar-nav">
            {list.slice(0, SECTION_MAX).map(link)}
            {/* the overflow is not hidden, it is handed to the page that can
                build any of them — a truncated menu with no way out is the
                silent cap this package refuses everywhere else */}
            {list.length > SECTION_MAX && (
              <a className="sidebar-link" href={toHash('explore', { range: route.params.range ?? '7d' })}>
                <span className="icon">…</span>
                +{list.length - SECTION_MAX} more
              </a>
            )}
          </div>
        </div>
      ))}

      <div className="sidebar-footer">
        <span className="dot" /> {platform ? 'live · all tenants' : 'live'}
      </div>
    </nav>
  );
}

export function Topbar({ route, catalog, onSaveView, theme, onTheme, platform }) {
  const p = route.params;
  const set = (patch) => navigate(route.page, { ...p, ...patch }, route.arg);
  // grouped by namespace, because `library.*` is one page's worth of names and a
  // flat list of two hundred is not a picker
  const namespaces = Object.entries(catalog?.namespaces ?? {});

  return (
    <header className="topbar">
      <div className="crumb"><span className="crumb-current" style={{ textTransform: 'capitalize' }}>{route.page}</span></div>
      {/* every number on this page is summed across tenants — say so, always,
          and before the reader has interpreted any of them */}
      {platform && (
        <span className="pill violet" title="Platform scope — reads span every tenant">
          <span className="dot" />all tenants
        </span>
      )}
      <div className="topbar-spacer" />

      <div className="seg">
        {RANGES.map((r) => (
          <button key={r} className={`seg-item ${(p.range ?? '7d') === r ? 'active' : ''}`} onClick={() => set({ range: r })}>
            {r}
          </button>
        ))}
      </div>

      <select className="select" value={p.name ?? ''} onChange={(e) => set({ name: e.target.value || undefined })}>
        <option value="">all names</option>
        {namespaces.map(([ns, names]) => (
          <optgroup key={ns} label={ns}>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </optgroup>
        ))}
      </select>

      <select className="select" value={p.env ?? ''} onChange={(e) => set({ env: e.target.value || undefined })}>
        <option value="">all envs</option>
        {(catalog?.envelope?.find((d) => d.key === 'field:env')?.values ?? []).map((e) => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>

      <button className="btn btn-sm" onClick={onSaveView} title="Save the current URL state as a view">save view</button>
      <button className="icon-btn" onClick={onTheme} title="theme">{theme === 'dark' ? '☾' : '☀'}</button>
    </header>
  );
}

/**
 * Catalog-generated filter bar. One chip per dimension the SOURCE can carry —
 * its events' typed attrs and kind fields, then the envelope every record
 * carries — and clicking one asks `/values` what that dimension actually takes
 * (reports §5) instead of guessing with a `window.prompt`.
 *
 * The prompt survives exactly where it is the honest answer: a dimension no
 * catalog enum, no rollup family and no index can enumerate answers
 * `source: 'none'`, and free text with a *scan* badge is what that means.
 *
 * Everything it writes is `filter=<dim>:<op>:<value>` through the shared
 * encoder, so a chip, a shared link and a saved view are the same three terms.
 */
export function FilterBar({ api, route, catalog, source }) {
  const p = route.params;
  const [open, setOpen] = React.useState(null);
  const [vals, setVals] = React.useState({});

  const names = React.useMemo(() => sourceEvents(catalog, source), [catalog, source]);
  const dims = React.useMemo(() => {
    const out = new Map();
    for (const n of names) {
      for (const d of catalog?.events?.[n]?.dims ?? []) {
        const seen = out.get(d.key);
        // a key several events declare is fast only when ALL of them index it —
        // one unindexed feeder makes the whole read a scan
        out.set(d.key, seen ? { ...seen, indexed: seen.indexed && d.indexed } : d);
      }
    }
    const envelope = (catalog?.envelope ?? []).filter((d) => !out.has(d.key));
    return { own: [...out.values()], envelope };
  }, [catalog, names]);

  const filters = filtersFromParams(p);
  const active = new Map(filters.map((f) => [f.dim, f]));
  const [showEnvelope, setShowEnvelope] = React.useState(false);

  const write = (next) => navigate(route.page, paramsWithFilters(p, next), route.arg);
  const setTerm = (dim, value) => {
    const rest = filters.filter((f) => f.dim !== dim);
    write(value == null ? rest : [...rest, { dim, op: 'eq', value }]);
    setOpen(null);
  };

  const pick = async (d) => {
    if (active.has(d.key)) return setTerm(d.key, null);
    setOpen(d.key);
    if (vals[d.key]) return;
    setVals((v) => ({ ...v, [d.key]: { loading: true } }));
    try {
      const res = await api.values({ dim: d.key, names: names.join(','), ...rangeToDates(p.range ?? '7d') });
      setVals((v) => ({ ...v, [d.key]: res }));
      // nothing to pick FROM is not an error — it is the free-text case, and
      // asking the reader to type is better than an empty select
      if (res.source === 'none' || !res.values.length) {
        setOpen(null);
        const typed = window.prompt(`${d.label} equals…`);
        if (typed) setTerm(d.key, typed);
      }
    } catch {
      setVals((v) => ({ ...v, [d.key]: { values: [], source: 'none', truncated: false } }));
      setOpen(null);
    }
  };

  const chip = (d) => {
    const term = active.get(d.key);
    return (
      <button
        key={d.key}
        className={`filter-chip ${term ? 'active' : ''} ${open === d.key ? 'active' : ''}`}
        onClick={() => pick(d)}
        title={term ? `${d.key} = ${term.value} — click to clear` : d.key}
      >
        {d.label}{term ? `: ${term.value}` : ''}
        {!d.indexed && <span className="scan-badge">scan</span>}
      </button>
    );
  };

  const picker = open && vals[open];
  const openDim = open && [...dims.own, ...dims.envelope].find((d) => d.key === open);

  return (
    <div className="filter-bar">
      {dims.own.map(chip)}
      {dims.envelope.filter((d) => showEnvelope || active.has(d.key)).map(chip)}
      {dims.envelope.length > 0 && (
        <button className="filter-chip" onClick={() => setShowEnvelope(!showEnvelope)}>
          {showEnvelope ? '− envelope' : `+ ${dims.envelope.length} envelope dims`}
        </button>
      )}

      {picker?.loading && <span className="tag">reading…</span>}
      {picker && !picker.loading && picker.values?.length > 0 && (
        <>
          <select className="select" autoFocus defaultValue="" onChange={(e) => e.target.value && setTerm(open, e.target.value)}>
            <option value="">{openDim?.label ?? open} equals…</option>
            {picker.values.map((v, i) => (
              <option key={v} value={v}>
                {v}{picker.counts ? ` · ${picker.counts[i]}` : ''}
              </option>
            ))}
          </select>
          {/* which store answered — the same fact the charts carry */}
          <span className="tag" title={picker.via ? `via ${picker.via}` : undefined}>{picker.source}</span>
          {picker.truncated && <span className="tag" style={{ color: 'var(--amber)' }}>top {picker.values.length}</span>}
          <button className="filter-chip" onClick={() => setOpen(null)}>✕</button>
        </>
      )}

      <button
        className={`filter-chip ${p.excludeActors ? 'active' : ''}`}
        onClick={() => navigate(route.page, { ...p, excludeActors: p.excludeActors ? undefined : 'admin' }, route.arg)}
        title="Exclude non-customer actors from every number on this page"
      >
        customers only
      </button>
    </div>
  );
}
