# Admin HTTP API

Shown at `/api/telemetry/admin`.

::: danger These routes do not guard themselves
telemetry never checks `isAdmin`. It cannot — "admin" means something different
in every host. Wrap this router in your own middleware:

```js
app.use('/api/telemetry/admin', requireAuth, requireAdmin, pkg.adminRoutes);
```

Then copy `examples/admin-guard.test.js` into your suite. That test is the only
thing that notices when a refactor drops the guard.
:::

## `GET /api/telemetry/admin/summary`

```json
{ "total": 0 }
```

## `GET /api/telemetry/admin/`

| Query | | |
|---|---|---|
| `limit` | `500` | Capped at `adminListLimit` |

```json
{ "items": [], "limit": 500 }
```

Same contract as the public list: the returned `limit` is the cap actually
applied.

## Errors

| Status | Body |
|---|---|
| 500 | `{ "error": "internal_error" }` |

401 and 403 come from **your** middleware, not from here.
