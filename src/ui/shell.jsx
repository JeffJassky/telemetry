import React from 'react';
import { RANGES, navigate, toHash } from './util.js';

/**
 * Shell chrome (dashboards §3) — exists because the ENVELOPE guarantees the
 * field: range/bucket, env/service, kind/name, subject scope, severity, and
 * the registry-generated filter bar. Every control writes URL state.
 */

const PAGES = [
  ['overview', 'Overview', '◎'],
  ['errors', 'Errors', '⚠'],
  ['traces', 'Traces', '⋔'],
  ['events', 'Events', '◷'],
  ['journeys', 'Journeys', '➾'],
  ['usage', 'Usage', '¤'],
  ['system', 'System', '⚙'],
];

export function Sidebar({ route, views, title, platform }) {
  const grouped = React.useMemo(() => {
    const custom = (views ?? []).filter((v) => v.origin !== 'derived');
    const derived = (views ?? []).filter((v) => v.origin === 'derived');
    const byPage = {};
    for (const v of derived) (byPage[v.page] ??= []).push(v);
    return { custom, byPage };
  }, [views]);

  const link = (v) => (
    <a
      key={`${v.origin}:${v.name}`}
      className="sidebar-link"
      href={toHash(v.page, { range: v.query.range ?? '7d', ...flatten(v.query.filters), display: v.query.display })}
      title={v.name}
    >
      <span className="icon">{v.origin === 'saved' ? '★' : v.origin === 'configured' ? '◆' : '·'}</span>
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
          <div className="sidebar-nav">{list.slice(0, 12).map(link)}</div>
        </div>
      ))}

      <div className="sidebar-footer">
        <span className="dot" /> {platform ? 'live · all tenants' : 'live'}
      </div>
    </nav>
  );
}

function flatten(filters = {}) {
  // ViewSpec filters use the same terms the URL does
  return filters;
}

export function Topbar({ route, registry, onSaveView, theme, onTheme, platform }) {
  const p = route.params;
  const set = (patch) => navigate(route.page, { ...p, ...patch }, route.arg);
  const names = Object.keys(registry ?? {});
  const services = [...new Set([p.service].filter(Boolean))];

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
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>

      <select className="select" value={p.env ?? ''} onChange={(e) => set({ env: e.target.value || undefined })}>
        <option value="">all envs</option>
        {['prod', 'staging', 'dev'].map((e) => <option key={e} value={e}>{e}</option>)}
      </select>

      {services.length > 0 && null}

      <button className="btn btn-sm" onClick={onSaveView} title="Save the current URL state as a view">save view</button>
      <button className="icon-btn" onClick={onTheme} title="theme">{theme === 'dark' ? '☾' : '☀'}</button>
    </header>
  );
}

/**
 * Registry-generated filter bar: indexedAttrs → fast equality chips,
 * other declared attrs → chips with a SCAN badge, indexedMetrics → range,
 * `data` → not filterable by design.
 */
export function FilterBar({ route, registry }) {
  const p = route.params;
  const spec = p.name ? registry?.[p.name] : null;
  if (!spec) return null;
  const active = Object.fromEntries((p.attrs ?? '').split(',').filter(Boolean).map((t) => t.split(':')));
  const setAttr = (k, v) => {
    const next = { ...active };
    if (v == null) delete next[k];
    else next[k] = v;
    const attrs = Object.entries(next).map(([a, b]) => `${a}:${b}`).join(',');
    navigate(route.page, { ...p, attrs: attrs || undefined }, route.arg);
  };
  return (
    <div className="filter-bar">
      {spec.attrKeys.map((k) => {
        const fast = spec.indexedAttrs.includes(k);
        const val = active[k];
        return (
          <button
            key={k}
            className={`filter-chip ${val ? 'active' : ''}`}
            onClick={() => {
              if (val) return setAttr(k, null);
              const v = window.prompt(`${k} equals…`);
              if (v) setAttr(k, v);
            }}
          >
            {k}{val ? `: ${val}` : ''}
            {!fast && <span className="scan-badge">scan</span>}
          </button>
        );
      })}
      {spec.indexedMetrics.map((k) => (
        <button
          key={k}
          className={`filter-chip ${(p.metrics ?? '').includes(k) ? 'active' : ''}`}
          onClick={() => {
            if ((p.metrics ?? '').includes(k)) {
              return navigate(route.page, { ...p, metrics: undefined }, route.arg);
            }
            const v = window.prompt(`${k} greater than…`);
            if (v) navigate(route.page, { ...p, metrics: `${k}>${v}` }, route.arg);
          }}
        >
          {k} ›
        </button>
      ))}
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
