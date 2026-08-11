/**
 * Transport-agnostic JSON client for the telemetry HTTP API.
 *
 * Shipped as its own export (`@jeffjassky/telemetry/client`) so a host can drive the API
 * from its own UI without adopting ours — the corollary in
 * standards/house-style.md: if the feature must live inside an existing host
 * page rather than own a route, ship the API plus this, and let the host build
 * the view.
 *
 * No fetch dependency baked in: pass `request` to run it through an axios
 * instance, a test harness, or anything else.
 */

const defaultRequest = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`telemetry: ${method} ${url} → ${res.status}`);
    err.status = res.status;
    err.payload = await res.json().catch(() => null);
    throw err;
  }
  return res.status === 204 ? null : res.json();
};

/**
 * `onUnauthenticated` fires on 401 and on 403. Both strand a user whose page is
 * already rendered — an expired session and a revoked admin role are the same
 * problem from the browser's side. See standards/adapters.md.
 */
export function createClient({
  baseUrl = '/api/telemetry',
  request = defaultRequest,
  onUnauthenticated = null,
} = {}) {
  const base = baseUrl.replace(/\/$/, '');

  const call = async (method, path, body) => {
    try {
      return await request(method, `${base}${path}`, body);
    } catch (err) {
      if ((err?.status === 401 || err?.status === 403) && onUnauthenticated) {
        onUnauthenticated(err);
      }
      throw err;
    }
  };

  return {
    /** Escape hatch: raw call against this client's base, redirects included. */
    call,
    me: () => call('GET', '/me'),
    list: (params = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v != null && v !== ''),
      ).toString();
      return call('GET', qs ? `/?${qs}` : '/');
    },
    get: (id) => call('GET', `/${encodeURIComponent(id)}`),
  };
}

export function createAdminClient({ baseUrl = '/api/telemetry/admin', ...opts } = {}) {
  const client = createClient({ baseUrl, ...opts });
  return {
    ...client,
    summary: () => client.call('GET', '/summary'),
  };
}
