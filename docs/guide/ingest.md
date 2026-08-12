# Ingest & keys

`createIngest()` is the untrusted write path: one Express router, one endpoint,
batch-only. Everything a browser, a desktop app, or a partner's server sends
arrives here, and every fact that matters is derived from the key rather than
read off the payload.

The rule the whole page turns on: **a claim is not a fact.** A record that
arrives asserting `tenantId: 'someone-else'` is not an attack to reject, it is a
field to ignore. Ignoring it costs one line; rejecting it means every stale
client in the wild starts producing 4xx noise.

```js
import { createIngest } from '@jeffjassky/telemetry';

app.use('/telemetry/ingest', createIngest({ telemetry: t }));
```

## Two kinds of key, and why

A key is not an identifier — **the key IS the configuration**. Client init is
`{ key, url, release }` and nothing else, because `service`, `env`, tenant
resolution, the kind allowlist, CORS origins, and the rate limit all hang off the
key server-side. A client cannot lie about where it runs, because it was never
asked.

```
pk_<label>_tk_<24hex>              publishable — the id IS the whole credential
sk_<label>_tk_<24hex>_<48hex>      secret — id + secret half
```

`<label>` is cosmetic (`live`, `test`); the `tk_` id is the lookup key and a
point read.

| | `pk_` publishable | `sk_` secret |
|---|---|---|
| Ships to | browsers, desktop apps, CLIs — anywhere a user can read it | trusted server processes only |
| Carries a secret | **no** — there is nothing to leak | yes, the 48-hex tail |
| Stored | the id, in the clear | the id, plus a scrypt hash of the secret |
| Default kinds | `event`, `error`, `span` | all five |
| May write `usage` | **never** — `createKey()` throws | yes |
| May write `origin: 'server'` names | **never** | yes |
| May ride the query string | yes (`?key=…`, for `sendBeacon`) | no — refused with 401 |
| Error surface | **never 4xx** — see below | honest 400/401/413/429 |
| Tenant modes | `fixed`, `session` | `fixed`, `session`, `claimed` |

A publishable key carries no secret because there is nowhere safe to put one in a
browser. Its entire security model is: it can only write the kinds and names you
allowlisted, from the origins you allowlisted, at the rate you allowed, into the
tenant *you* resolve. Compromise means someone can write plausible telemetry —
not read any, not bill anything, not forge a milestone.

### Minting one

```js
const { key, id } = await t.createKey({
  kind: 'publishable',
  tenantMode: 'fixed',
  tenantId: 'acc_9',
  service: 'webapp',
  env: 'prod',
  origins: ['https://app.example.com'],
});
```

**The full key string is returned once and is never reconstructable.** Only the
`tk_` id and, for `sk_`, a hash of the secret half are stored. Lose the string
and the only remedy is minting a new key and revoking the old one — which is the
same property that makes a database dump not a credential dump.

The hash is versioned scrypt: `scrypt1$<salt>$<hash>`, N=16384, r=8, p=1. The
version prefix rides *in* the stored string so a future parameter change bumps
the prefix and old hashes keep verifying. Comparison is `timingSafeEqual` —
a key check must not leak how much of the secret matched, because a leak of
"how much" is a leak of the whole thing given enough attempts.

Four assertions are enforced at mint time, so a misconfigured key cannot exist:

- `tenantMode: 'claimed'` requires `kind: 'secret'`
- `tenantMode: 'fixed'` requires a `tenantId`
- a publishable key may never include `usage` in `allowedKinds`
- no key may be minted on the reserved tenant `'*'`

## Tenant modes

Every record needs a `tenantId`, and it can come from exactly three places. There
is no fourth path.

| Mode | Who supplies the tenant | Safe with |
|---|---|---|
| `fixed` | the key doc itself | `pk_` and `sk_`. Single-tenant apps, internal tools, per-customer CLI builds. |
| `session` | your `contextAdapter.resolveContext(req)` | `pk_` and `sk_`. The normal multi-tenant browser case — the session cookie decides. |
| `claimed` | `body.context.tenantId` in the payload | **`sk_` only**, enforced at mint. A server you trust telling you whose data this is. |

`claimed` is the only mode where the wire decides, which is exactly why it is
locked to secret keys. A publishable key in `claimed` mode would let any page in
any browser write into any tenant; `createKey()` refuses to create one.

In `session` mode the host adapter also gets to supply `subjects` and `actor`,
and those **outrank the payload**. The merge order, lowest to highest, is:

```
batch context claims  <  per-record subjects  <  host context
```

Merging is per subject *type*: a host that speaks to `user` replaces the claimed
`user` entirely, while a claimed `account` the host said nothing about survives.
The session cookie beats the JS claim; the JS claim is still useful for the
things the session does not know.

```js
createIngest({
  telemetry: t,
  contextAdapter: {
    resolveContext: (req) => req.session
      ? { tenantId: req.session.accountId,
          subjects: [{ type: 'user', id: req.session.userId }],
          actor: `user:${req.session.userId}` }
      : null,
  },
});
```

Returning `null` means "no session". For a `pk_` key that is normal traffic —
a logged-out visitor — so the batch drops and is counted. For `sk_` it is a 401.

## The rule that looks like a bug

**A `pk_` key never returns 4xx. Not once, not ever.**

Unknown event name, oversize batch, rate limit exceeded, revoked key, unknown
key, no key at all, malformed JSON, a disallowed origin, a reserved tenant — all
of it answers **202** with `{ accepted, rejected }`, drops what it cannot use,
and increments a counter.

This is deliberate and it is the single most surprising behaviour in the package.
Two reasons:

1. **A public key's error responses are a free oracle.** A `pk_` key is readable
   by anyone who opens devtools. If the endpoint answered 400 for "unregistered
   event" and 202 for a registered one, the key's holder could enumerate your
   entire event registry from a browser console. 401 vs 202 on a revoked key
   tells an attacker which stolen keys are still live. The only way to not answer
   the question is to not answer it.

2. **Telemetry errors surfacing in browser consoles read as a broken page.** A
   red 429 in the network tab of a working checkout flow generates support
   tickets about the checkout. Worse, most HTTP clients retry 5xx and many retry
   429 — so an error response to a client already sending too much is a retry
   storm that you asked for.

The drop is never silent. Every dropped record lands in `t.counters` and, when
it was parseable enough to name, in the quarantine collection — both of which the
dashboard's System page renders. "Never drop silently" means *counted and
visible*, not *reported to the sender*.

`sk_` callers are programmers reading a server log, and they get the truth:

| Condition | `pk_` | `sk_` |
|---|---|---|
| no credential / unparseable key | 202 drop | 401 `invalid_key` (only if it *looked* like an `sk_`) |
| unknown or revoked key | 202 drop | 401 `invalid_key` / `revoked_key` |
| wrong secret half | n/a | 401 `invalid_key` |
| `Origin` not in the allowlist | 202 drop, no CORS header | n/a |
| batch over `maxRecords` | 202, head kept, tail counted | 413 `batch_too_large` |
| over the per-key rate limit | 202, what fits kept | 429 `rate_limited` |
| `session` mode, no session | 202, batch counted rejected | 401 `no_session` |
| `session` mode, no `contextAdapter` | 202 | 500 `no_context_adapter` |
| `claimed` mode, no tenant in payload | n/a | 400 `tenant_required` |
| resolved tenant is `'*'` | 202, counted | 400 `reserved_tenant` |
| malformed JSON / body over `bodyLimit` | 202 `{accepted:0, rejected:1}` | 400 / 413 |
| unregistered name, bad shape, missing `_id` | per-record `rejected++`, quarantined | same — the batch still 202s |

Note the last row: per-record failures are per-record for *both* key kinds. One
bad record never kills a batch. A batch of four with two good records answers
`{ accepted: 2, rejected: 2 }` and stores two rows.

See [Public HTTP API](/reference/http-public) for the exact response bodies.

## A browser cannot forge a milestone

Every `EventSpec` declares an `origin`: `'server'`, `'client'`, or `'any'`.
A `pk_` key may not write a name whose spec says `origin: 'server'`. The record
is rejected per-record and quarantined with the reason
`server-origin name over a publishable key`.

This is the guarantee that makes client instrumentation safe to trust. Declare
`wizard_started` as `origin: 'any'` and let the browser assert it — it is a UI
fact and the browser is the only one who knows. Declare `account.converted` as
`origin: 'server'` and no amount of devtools gets a fake conversion into your
funnel, because conversions are decided by your billing code.

The same split runs through `allowedKinds`. A publishable key defaults to
`event`, `error`, `span` and may never carry `usage` — money is not a thing a
browser gets to assert. `state` is available to a `pk_` key only if you
explicitly allowlist it, because most state transitions are server facts.

## The wire contract

One `POST` to the mount path. Batch-only — there is no single-record endpoint,
because a batch of one is a batch and a second endpoint is a second thing to
secure.

```json
{
  "sdk":     { "name": "@jeffjassky/telemetry", "version": "0" },
  "sentAt":  "2026-08-12T10:00:00.000Z",
  "release": "app@1.4.2",
  "client":  { "platform": "web", "appVersion": "1.4.2", "locale": "en-US" },
  "context": { "subjects": [{ "type": "anon", "id": "anon_…" }], "actor": "user:u_1" },
  "records": [
    { "_id": "0192…", "name": "app.ping", "occurredAt": "2026-08-12T09:59:58.120Z",
      "attrs": { "route": "/reports" } }
  ]
}
```

Batch-level context carries the subjects and actor **once**, not per record —
that is most of why batching pays for itself on a chatty page.

### Caps

| Cap | Default | Option |
|---|---|---|
| records per batch | 100 | `maxRecords` |
| body size | `512kb` | `bodyLimit` |
| records/minute per key | 600 | `maxPerMinute` at mint time |
| key document cache | 60s | `keyCacheMs` |

The rate limit counts **records**, not requests, and is a per-process token
bucket keyed on the key id. It is a storm cap, not an SLA — a host running four
Node processes effectively grants 4×.

Unknown key ids are negative-cached for `keyCacheMs` too, so a flood of junk
credentials costs one database read per minute rather than one per request.

### At-least-once, and the `_id` that makes it safe

Every record **must** carry a client-generated `_id`, 16–64 characters. A record
without one is rejected: without a client id there is no idempotency, and the
whole delivery model rests on it.

The SDK mints UUIDv7s. Use them — v7 is time-ordered and insertion-local, and
`_id` doubles as insertion order for every reader that sorts on it.
`crypto.randomUUID()` is v4 and would break that.

Delivery is at-least-once. `sendBeacon` dies mid-flight; a fetch times out after
the server already committed; a CLI replays its disk queue. So the ingest handler
**inverts the plane order** relative to [`emit()`](/guide/emit):

```
emit():  aggregate first, then store the evidence
ingest:  INSERT first — duplicate ⇒ drop, NO rollup — then aggregate
```

The insert *is* the dedupe. A retried batch answers `accepted` for records it
already has (it is telling the truth: they are stored), stores nothing new, and
crucially **rolls up nothing new**. Idempotency that still lets rollups run twice
does not fix the bug; it moves it somewhere harder to see.

### Clock skew

Client clocks lie — by minutes, sometimes by years. The batch's `sentAt` is
compared against the server's receive time and the difference is applied to every
`occurredAt` in the batch **before rollups run**, so a user with a two-minutes-fast
laptop does not land in tomorrow's daily bucket.

The computed `clockSkewMs` is stored on `client.clockSkewMs`, so a suspicious
distribution is diagnosable after the fact rather than merely corrected.

A record whose `occurredAt` is missing or unparseable falls back to the server's
receive time.

### `$identify` and anonymous → known stitching

`$identify` is a control record, not telemetry. It is never stored as a row.

```json
{ "_id": "0192…", "name": "$identify", "occurredAt": "…",
  "anonRef": "anon:anon_9f3c", "userRef": "user:u_123" }
```

It upserts one alias document keyed `${tenantId}|${anonRef}` into the aliases
collection, and answers `accepted`. Both refs must be `type:id` shaped or the
record is quarantined as `malformed $identify`.

The client posts one automatically when `identify()` first learns a user id. The
anon subject stays on the batch context afterwards — the alias is the durable
link, and a stitching job downstream consumes it to attribute pre-login activity.
Deleting the alias is part of [erasure](/guide/erasure).

### CORS

Preflight (`OPTIONS`) cannot be key-scoped — the browser has not sent
`Authorization` yet — so it reflects the requesting origin, advertises
`POST` + `authorization, content-type`, caches for 600s, and answers **204**. The
actual enforcement is on the `POST`.

On the `POST`, a `pk_` key with an `Origin` header gets the per-key allowlist:
in the list, and the response carries `Access-Control-Allow-Origin` plus
`Vary: Origin`; not in the list, and the write is dropped *and* no ACAO header is
sent, so the browser would not have let the page read the response anyway.

An empty `origins` array means no browser origins are accepted. Non-browser
callers send no `Origin` and are unaffected.

### `sendBeacon`

`navigator.sendBeacon` cannot set headers, and it is the only transport that
reliably survives a page unload. So a `pk_` key may ride the query string:

```
POST /telemetry/ingest?key=pk_live_tk_…
```

An `sk_` in the query string is **refused with 401** even if it is otherwise
valid. Secrets do not belong in URLs — they end up in access logs, proxy logs,
and `Referer` headers.

The web adapter wires this up on `pagehide` and on `visibilitychange → hidden`.
If the beacon is accepted by the browser the queue is cleared locally; a beacon
that is silently dropped costs those records, which is the trade the platform
offers.

## `'*'` is reserved

`'*'` is the dashboard's cross-tenant read scope
([`PLATFORM_SCOPE`](/guide/dashboard#the-platform-scope)). A tenant literally
named `'*'` would therefore be a privilege escalation via a string.

Ingest checks it **once, after the tenant has resolved**, and refuses the batch
whichever mode produced it — key-fixed, host-session, or payload-claimed. That
placement is deliberate rather than lazy: all three paths mint a `tenantId` from
outside the package. `claimed` is the payload asserting one, `session` is a host
adapter that could compute one, and `fixed` reads a key document that may predate
`createKey()`'s own guard.

`pk_` drops and counts. `sk_` gets `400 reserved_tenant`.

## Operating it

- **Mount it wherever you like.** It is a router, never an app and never a
  server. It needs no session middleware of its own; if you use `session` mode,
  mount your session middleware before it so `resolveContext` can see it.
- **Do not put a body parser in front of it.** The router resolves auth *before*
  `express.json()` so that body-parse failures already know which error surface
  applies. An outer parser would consume the body first and take that with it.
- **Watch `t.counters`.** `rejected` climbing means clients are sending names
  your registry does not know — usually a deploy skew. `capped` climbing means a
  key is over its rate limit. Both are visible on the System page and both belong
  on your `/metrics` endpoint.
- **Revoke, do not delete.** `POST /api/system/keys/:id/revoke` on the dashboard
  sets `revokedAt`; the key cache means it takes up to `keyCacheMs` to bite.

## See also

- [Public HTTP API](/reference/http-public) — every status code and response shape
- [`createIngest`](/reference/routers#createingestoptions) — every option
- [Client SDKs](/reference/client) — what sends these batches
- [The dashboard](/guide/dashboard) — where the counters and quarantine surface
