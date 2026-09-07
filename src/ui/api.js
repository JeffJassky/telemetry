/**
 * The SPA's only door to data — thin fetch over the dashboard /api router.
 * Built from the injected config, never a hardcoded base (standards/adapters).
 */

export function createApi(config) {
  const base = (config.apiBase ?? '/telemetry/api').replace(/\/$/, '');

  async function call(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      // an array APPENDS — `reportToQuery` returns `filter` as one term or
      // several, and express parses the repeated form back into the same array.
      // Joining them would put a comma inside a term whose value may hold one.
      if (Array.isArray(v)) for (const one of v) { if (one != null && one !== '') qs.append(k, String(one)); }
      else qs.set(k, String(v));
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
    /** the boot call — the projected registry AND the catalog every control reads */
    registry: () => call('/registry'),
    records: (p) => call('/records', p),
    series: (p) => call('/series', p),
    distribution: (p) => call('/distribution', p),
    breakdown: (p) => call('/breakdown', p),
    rollups: (p) => call('/rollups', p),
    /**
     * The one route behind every chart. `params` is `reportToQuery(report)` —
     * the resolver picks the primitive, so the SPA asks the question instead of
     * choosing an endpoint per page.
     */
    report: (p) => call('/report', p),
    /** the dry run: `Plan | Unavailable`, no read. A refusal is a 200 here. */
    plan: (p) => call('/report/plan', p),
    /** the observed domain of one dimension — what makes a filter a picker */
    values: (p) => call('/values', p),
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
