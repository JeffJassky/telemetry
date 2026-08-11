# Public HTTP API

Mounted by you, at whatever path. Shown here at `/api/telemetry`.

All responses are JSON, including failures.

## `GET /api/telemetry/me`

The result of your [user adapter](/guide/user-adapter), for the SPA to render
"signed in as X".

```json
{ "user": { "email": "a@b.c", "displayName": "A", "isAdmin": false } }
```

**No internal ids.** The UI renders a name, never a key.

`401 { "error": "unauthenticated" }` when the adapter returns null.

## `GET /api/telemetry/`

| Query | | |
|---|---|---|
| `limit` | `200` | Capped at `listLimit` |

```json
{ "items": [], "limit": 200 }
```

`limit` in the response is what the server **actually applied**. Asking for
100,000 returns the cap, not an error.

`401` when unauthenticated.

## `GET /api/telemetry/:id`

```json
{ "item": {} }
```

`404 { "error": "not_found" }` when it doesn't exist. `401` when
unauthenticated.

Declared after the literal routes, so `/me` is not swallowed by `/:id`.

## Errors

| Status | Body |
|---|---|
| 401 | `{ "error": "unauthenticated" }` |
| 404 | `{ "error": "not_found" }` |
| 500 | `{ "error": "internal_error" }` |

Never HTML.
