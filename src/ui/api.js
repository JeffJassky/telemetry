/**
 * The SPA's only door to data — thin fetch over the dashboard /api router.
 * Built from the injected config, never a hardcoded base (standards/adapters).
 */

export function createApi(config) {
  const base = (config.apiBase ?? '/telemetry/api').replace(/\/$/, '');

  async function call(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') qs.set(k, String(v));
    }
    const res = await fetch(`${base}${path}${qs.size ? `?${qs}` : ''}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    call,
    registry: () => call('/registry'),
    records: (p) => call('/records', p),
    series: (p) => call('/series', p),
    distribution: (p) => call('/distribution', p),
    rollups: (p) => call('/rollups', p),
    funnel: (p) => call('/funnel', p),
    distinct: (p) => call('/distinct', p),
    trace: (id) => call(`/trace/${encodeURIComponent(id)}`),
    journey: (ref, p) => call(`/journey/${encodeURIComponent(ref)}`, p),
    views: () => call('/views'),
    saveView: (spec, shared) =>
      fetch(`${base}/views`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ spec, shared }),
      }).then((r) => r.json()),
    deleteView: (id) =>
      fetch(`${base}/views/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' })
        .then((r) => r.json()),
    system: () => call('/system'),
    revokeKey: (id) =>
      fetch(`${base}/system/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST', credentials: 'same-origin' })
        .then((r) => r.json()),
  };
}
