# Public HTTP API

The ingest endpoints, mounted by [`createIngest`](/reference/routers#createingestoptions).
Paths below are relative to the mount path.

The rule that governs every status code on this page: **a `pk_` key never
receives a 4xx.** Errors visible to a public key are an enumeration oracle and a
retry storm. Everything a publishable key gets wrong answers `202` with a
`rejected` count, drops the write, and increments a counter. `sk_` callers are
programmers and get the truth. See [Ingest & keys](/guide/ingest#the-rule-that-looks-like-a-bug).

---

## `OPTIONS /`

CORS preflight. Not key-scoped — the browser has not sent `Authorization` yet, so
enforcement happens on the `POST`.

**Response — always `204`**, with no body. When the request carries an `Origin`:

```
Access-Control-Allow-Origin: <the request's origin, reflected>
Vary: Origin
Access-Control-Allow-Methods: POST
Access-Control-Allow-Headers: authorization, content-type
Access-Control-Max-Age: 600
```

---

## `POST /`

The one write endpoint. Batch-only.

### Auth

| | |
|---|---|
| `Authorization: Bearer <key>` | Both key kinds. The normal path. |
| `?key=<pk_…>` | **`pk_` only.** `sendBeacon` cannot set headers. |
| `?key=<sk_…>` | **Refused, `401`.** Secrets do not belong in URLs. |

### Request body

`application/json`, at most `bodyLimit` (default `512kb`).

```jsonc
{
  "sdk":     { "name": "@jeffjassky/telemetry", "version": "0" },  // informational
  "sentAt":  "2026-08-12T10:00:00.000Z",   // used for clock-skew correction
  "release": "app@1.4.2",                  // stored as `release` on every record
  "client":  { "platform": "web", "appVersion": "1.4.2", "locale": "en-US" },
  "context": {
    "tenantId": "acc_9",                   // read ONLY in tenantMode: 'claimed'
    "subjects": [{ "type": "anon", "id": "anon_…" }],
    "actor":    "user:u_1"
  },
  "records": [ /* … */ ]
}
```

`records` must be an array; anything else is treated as empty. Over `maxRecords`
(default 100): `pk_` keeps the head and counts the tail, `sk_` gets `413`.

`client` defaults to `{ platform: 'web', appVersion: release ?? 'unknown' }` and
your object merges over it — `platform` and `appVersion` are envelope-required,
so the server guarantees them rather than rejecting a batch that omitted them.
`clockSkewMs` is computed server-side and always overwrites whatever was sent.

### Record shape

```jsonc
{
  "_id":        "01920e5f-…",     // REQUIRED. 16–64 chars. UUIDv7 recommended.
  "name":       "app.ping",       // REQUIRED. Must exist in the registry.
  "occurredAt": "2026-08-12T09:59:58.120Z",
  "attrs":      { "route": "/reports" },
  "metrics":    { "bytes": 4096 },
  "data":       { },              // stored only if the spec declares a schema
  "body":       "…",
  "severity":   "error",
  "subjects":   [{ "type": "account", "id": "a1" }],
  "actor":      "user:u_1",
  "onBehalfOf": "admin:ad_1",
  "traceId":    "…", "spanId": "…", "parentId": "…", "durationMs": 1200,
  "error":      { "type": "TypeError", "message": "…", "handled": false, "fingerprint": "…", "frames": [] },
  "state":      { "key": "lifecycle", "to": "active" },
  "usage":      { "meter": "…", "quantity": 1, "unit": "…", "idempotencyKey": "…", "billedTo": "org:o1" }
}
```

**Fields the wire may not assert.** `tenantId`, `service`, `env`, and `origin`
come from the key and the resolved context; a record that sends them is not
rejected, they are simply ignored. Plane fields (`forced`, `sampleRate`,
`expiresAt`) never reach the document at all — only the allowlisted fields above
are read, so a wire record cannot force-keep itself, claim a sample rate, or
choose its own retention. `origin` is always stamped `'client'`.

Dots in `attrs`/`metrics` keys are rewritten to underscores
(`gen_ai.request.model` → `gen_ai_request_model`) because mongoose Map keys
cannot contain them.

### The `$identify` control record

```jsonc
{ "_id": "…", "name": "$identify", "occurredAt": "…",
  "anonRef": "anon:anon_9f3c", "userRef": "user:u_123" }
```

Never stored as telemetry. Upserts one alias document with
`_id: "<tenantId>|<anonRef>"` and `{ tenantId, anonRef, userRef, linkedAt }`, and
counts as `accepted`. Both refs must match `/^.+:.+$/` or the record is
quarantined as `malformed $identify`.

### Success response — `202 Accepted`

```json
{ "accepted": 2, "rejected": 1 }
```

Always `202`, never `200` or `201`: some records are written synchronously,
some rolled up asynchronously, and the caller is not waiting on either.
`accepted` includes records that were already present (a retry of something
stored — the contract working), because they *are* stored.

### Per-record rejections

These never change the status code, for either key kind. The record is counted in
`rejected`, quarantined with the reason below, and the batch continues.

| Reason | |
|---|---|
| `unregistered event` | `name` is not in the registry |
| `kind <k> not allowed for this key` | the key's `allowedKinds` excludes the spec's kind |
| `server-origin name over a publishable key` | `spec.origin === 'server'` and the key is `pk_` |
| `name not allowed for this key` | the key has an `allowedNames` list and this is not on it |
| `missing client _id` | absent, not a string, or outside 16–64 characters |
| `malformed $identify` | `anonRef` or `userRef` is not `type:id` |
| *(a mongoose validation message)* | failed the envelope or registry validation |
| `rollup: <error>` | the row was stored; a rollup update failed afterwards |

One bad record never kills a batch. Four records with two failures answer
`202 { "accepted": 2, "rejected": 2 }` and store two rows.

### Batch-level statuses

| Condition | `pk_` | `sk_` |
|---|---|---|
| success | `202 { accepted, rejected }` | same |
| no `Authorization`, unparseable key | `202 { "accepted": 0, "rejected": 0 }` | `401 { "error": "invalid_key" }` — only when the credential *looked* like an `sk_` |
| unknown key id | `202 { "accepted": 0, "rejected": 0 }` | `401 { "error": "invalid_key" }` |
| revoked key | `202 { "accepted": 0, "rejected": 0 }` | `401 { "error": "revoked_key" }` |
| key kind ≠ prefix | `202 { "accepted": 0, "rejected": 0 }` | `401 { "error": "invalid_key" }` |
| wrong secret half | n/a | `401 { "error": "invalid_key" }` |
| `sk_` in the query string | n/a | `401 { "error": "invalid_key" }` |
| `Origin` not in the key's allowlist | `202`, no `Access-Control-Allow-Origin` | n/a |
| records > `maxRecords` | `202`, head kept, tail in `rejected` | `413 { "error": "batch_too_large", "max": <n> }` |
| over the per-key rate limit | `202`, what fits kept, rest in `rejected` and `counters.capped` | `429 { "error": "rate_limited" }` |
| `session` mode, `resolveContext` returned `null` | `202 { "accepted": 0, "rejected": <n> }` | `401 { "error": "no_session" }` |
| `session` mode, no `contextAdapter` configured | `202 { accepted, rejected }` | `500 { "error": "no_context_adapter" }` |
| `claimed` mode, no `context.tenantId` | n/a (`claimed` is `sk_`-only) | `400 { "error": "tenant_required" }` |
| resolved tenant is `'*'` | `202`, every record in `rejected` and `counters.rejected` | `400 { "error": "reserved_tenant" }` |
| malformed JSON | `202 { "accepted": 0, "rejected": 1 }` | `400 { "error": "entity.parse.failed" }` |
| body over `bodyLimit` | `202 { "accepted": 0, "rejected": 1 }` | `413 { "error": "entity.too.large" }` |

The `sk_` body-parser errors carry express's own `err.type` as `error`, falling
back to `bad_request`.

### CORS on the `POST`

A `pk_` key with an `Origin` header in the key's `origins` list gets
`Access-Control-Allow-Origin: <origin>` and `Vary: Origin`. Anything else is
dropped **and** gets no ACAO header — the browser would not have let the page
read the response either way. An empty `origins` array accepts no browser
origins; non-browser callers send no `Origin` and are unaffected.

### Side effects

- `lastUsedAt` on the key is touched at most once per minute, not per request.
- Records of `kind: 'usage'` are saved with `{ w: 'majority', j: true }`.
- Rollups run **after** a successful insert. A duplicate `_id` returns
  `accepted` having aggregated nothing — the at-least-once contract working.
- `occurredAt` is corrected by the batch's clock skew **before** rollups see it.

## Verified against

`test/ingest.test.ts` and `test/tenancy.test.ts` pin `202`, `204`, `400`, `401`,
`413`, and `429` on this endpoint, including the `reserved_tenant` body and the
`{ accepted, rejected }` shape for every `pk_` drop path.
