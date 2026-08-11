import React from 'react';

/**
 * Placeholder shell. The real dashboard — query primitives, ViewSpec
 * quick-selects, kind pages, mailery design tokens — lands with stage 4b
 * task 4 (plans/dashboards.md). This exists so `build:ui` stays green while
 * the server core ships first.
 *
 * Worth preserving when replacing: build every client from the injected
 * `config` (never a hardcoded base), and carry the full current URL — hash
 * route included — into any login redirect. See standards/adapters.md.
 */
export default function App({ config }) {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem 2rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Telemetry</h1>
      <p style={{ color: '#78716c', maxWidth: '32rem', margin: '1rem auto' }}>
        The dashboard ships after the ingest and client layers. API base for
        this mount: <code>{config?.apiBase ?? '/api/telemetry'}</code>
      </p>
    </main>
  );
}
