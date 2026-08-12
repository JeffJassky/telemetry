import React from 'react';
import { createApi } from './api.js';
import { ScopeContext } from './atoms.jsx';
import { Sidebar, Topbar } from './shell.jsx';
import { Errors, Events, Journeys, Overview, System, Traces, Usage } from './pages.jsx';
import { parseHash } from './util.js';

/**
 * The dashboard shell (dashboards §3): sidebar (pages + view quick-select),
 * topbar (range/name/env + save-view + theme), and one page under it. Every
 * screen state is a shareable URL — the hash IS the view.
 */

const PAGES = {
  overview: Overview,
  errors: Errors,
  traces: Traces,
  events: Events,
  journeys: Journeys,
  usage: Usage,
  system: System,
};

function useHashRoute() {
  const [route, setRoute] = React.useState(parseHash);
  React.useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export default function App({ config }) {
  const api = React.useMemo(() => createApi(config), [config]);
  const route = useHashRoute();
  const [registry, setRegistry] = React.useState(null);
  // the viewer's scope, straight from /registry — the SPA never guesses it
  const [scope, setScope] = React.useState({ platform: false, scope: null });
  const [views, setViews] = React.useState([]);
  const [error, setError] = React.useState(null);
  const [theme, setTheme] = React.useState(() => localStorage.getItem('telemetry_theme') ?? 'light');

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('telemetry_theme', theme);
  }, [theme]);

  React.useEffect(() => {
    api.registry().then((r) => {
      setRegistry(r.registry);
      setScope({ platform: !!r.platform, scope: r.scope ?? null });
    }, setError);
    api.views().then((v) => setViews(v.views), () => {});
  }, [api]);

  const saveView = async () => {
    const name = window.prompt('View name — it will appear in the sidebar:');
    if (!name) return;
    const shared = window.confirm('Share with the whole tenant? (Cancel = private to you)');
    await api.saveView(
      { name, page: route.page, query: { range: route.params.range ?? '7d', filters: route.params } },
      shared,
    );
    api.views().then((v) => setViews(v.views), () => {});
  };

  if (error) {
    return (
      <div className="empty" style={{ paddingTop: '20vh' }}>
        <h3>{error.status === 401 ? 'Sign in required' : 'Dashboard unavailable'}</h3>
        {String(error.message)}
      </div>
    );
  }

  const Page = PAGES[route.page] ?? Overview;
  return (
    <ScopeContext.Provider value={scope}>
      <div className="app">
        <Sidebar route={route} views={views} title={config.title} platform={scope.platform} />
        <div className="main">
          <Topbar
            route={route}
            registry={registry}
            onSaveView={saveView}
            theme={theme}
            onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            platform={scope.platform}
          />
          <div className="content">
            <div className="content-inner">
              {registry ? <Page api={api} route={route} registry={registry} /> : <div className="empty">Loading…</div>}
            </div>
          </div>
        </div>
      </div>
    </ScopeContext.Provider>
  );
}
