import React from 'react';
import { createClient, createAdminClient } from '../client/index.js';

/**
 * Skeleton SPA. Replace the body; keep the shape.
 *
 * The two things worth preserving: the client is built from the injected
 * config (never a hardcoded base), and `onUnauthenticated` carries the full
 * current URL — hash route included — so a login flow that honors the return
 * param puts the user back on the exact view. See standards/adapters.md.
 */
export default function App({ config }) {
  const client = React.useMemo(() => {
    const onUnauthenticated = config.loginUrl
      ? () => {
        const back = encodeURIComponent(window.location.href);
        window.location.href = `${config.loginUrl}?${config.returnParam}=${back}`;
      }
      : null;
    return config.admin
      ? createAdminClient({ baseUrl: config.adminApiBase, onUnauthenticated })
      : createClient({ baseUrl: config.apiBase, onUnauthenticated });
  }, [config]);

  const [state, setState] = React.useState({ status: 'loading' });

  React.useEffect(() => {
    let live = true;
    client.list()
      .then((data) => live && setState({ status: 'ready', items: data.items }))
      .catch((err) => live && setState({ status: 'error', error: err }));
    return () => { live = false; };
  }, [client]);

  return (
    <main className="telemetry">
      <h1>{config.title}</h1>
      {state.status === 'loading' && <p>Loading…</p>}
      {state.status === 'error' && <p role="alert">Could not load: {state.error.message}</p>}
      {state.status === 'ready' && (
        <ul>
          {state.items.map((item) => <li key={item._id}>{item._id}</li>)}
        </ul>
      )}
    </main>
  );
}
