# Client

```js
import { createClient, createAdminClient } from '@jeffjassky/telemetry/client';
```

A transport-agnostic JSON client for the HTTP API. The shipped SPA uses it; so
can your own UI.

## When to reach for this

If the feature has to live **inside** one of your existing pages rather than own
a route, use the API plus this client and build that view yourself. Don't try to
run both the mounted SPA and an embedded copy — pick one.

## `createClient(options)`

| Option | Default | |
|---|---|---|
| `baseUrl` | `/api/telemetry` | |
| `request` | `fetch`, `same-origin` credentials | Swap in axios, or a test double |
| `onUnauthenticated` | `null` | Fires on **401 and 403** |

```js
const client = createClient({
  baseUrl: '/api/telemetry',
  onUnauthenticated: () => {
    const back = encodeURIComponent(window.location.href);
    window.location.href = `/login?next=${back}`;
  },
});
```

403 is included on purpose: a revoked admin role strands an already-rendered
page as completely as an expired session does.

## Methods

| | |
|---|---|
| `me()` | `{ user: { email, displayName, isAdmin } }` — no internal ids |
| `list(params)` | `{ items, limit }` |
| `get(id)` | `{ item }` |
| `call(method, path, body)` | Raw call against this client's base |

## `createAdminClient(options)`

Same surface against `/api/telemetry/admin`, plus `summary()`.

## `limit` is a fact, not an echo

`list()` returns the cap the **server** applied, which may be lower than what
you asked for. Read it; don't assume your request was honored.

## Errors

A non-2xx throws an `Error` carrying `status` and the parsed `payload`.
