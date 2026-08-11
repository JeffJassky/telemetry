# Telemetry Instrumentation

How records get from a React tab, a Vue tab, an Electron app, a node server, or
a CLI into the storage model defined in [schema.md](./schema.md). This document
is normative for the **ingest surface, keys, identity context, SDKs, and
packaging**; schema.md stays normative for storage.

---

## 1. Trust model

Two writer classes, mirroring the aggregate/evidence split in schema §4.6. Every
other decision in this document derives from this table.

| | trusted | untrusted |
|---|---|---|
| who | node server, workers, jobs | browser (React/Vue), Electron renderer, CLI on user machines |
| credential | in-process `emit()`, or `sk_` secret key | `pk_` publishable key — ships in the bundle, assumed public |
| `tenantId` | asserted | **never sent** — resolved server-side (key or session) |
| `subjects` / `actor` | asserted | claims, validated per key mode |
| kinds | all five | `event`, `error`, `span` — **never `usage`**, never `state` unless allowlisted |
| `forced`, `sampleRate`, `via` | computed by `emit()` | stripped if present |
| delivery | in-process (at-most-once) | HTTP batch (at-least-once) — see §3 |

**A claim is not a fact.** The ingest handler's job is converting the left
column's assertions and the right column's claims into one honest envelope. A
browser record that arrives claiming `tenantId` is not an attack to reject —
it is a field to ignore.

---

## 2. Keys — `telemetry_keys`

The key **is** the configuration. Client init is `{ key, url, release }` and
nothing else, because service, env, tenant resolution, kind allowlist, CORS, and
rate limits all hang off the key server-side. Rotating behavior never means
shipping a new bundle.

```
pk_live_tk_a1b2c3...   publishable — key id only, no secret half
sk_live_tk_d4e5f6...   secret      — id + secret half, hash stored
```

```ts
import { prop, index, modelOptions, getModelForClass } from '@typegoose/typegoose'

export enum KeyKind { Publishable = 'publishable', Secret = 'secret' }

/**
 * How tenantId is resolved for records written with this key:
 *  - fixed:   the key carries it. Single-tenant apps, internal tools, CLI builds.
 *  - session: the host resolves it from the request (adapter, §4). Multi-tenant
 *             SaaS with the ingest route mounted inside the app backend.
 *  - claimed: the payload asserts it. Secret keys only — enforced at boot.
 */
export enum TenantMode { Fixed = 'fixed', Session = 'session', Claimed = 'claimed' }

@modelOptions({ schemaOptions: { collection: 'telemetry_keys', versionKey: false } })
@index({ revokedAt: 1 })
export class TelemetryKey {
  /** the `tk_...` id embedded in the key string — lookup is a point read */
  @prop({ required: true, type: () => String }) public _id!: string
  @prop({ required: true, enum: KeyKind, type: String }) public kind!: KeyKind
  /** sk_ only. scrypt/argon2 hash of the secret half. pk_ has no secret to store. */
  @prop() public secretHash?: string

  @prop({ required: true, enum: TenantMode, type: String }) public tenantMode!: TenantMode
  /** required iff tenantMode = fixed */
  @prop() public tenantId?: string

  /** stamped onto every record — the client cannot lie about where it runs */
  @prop({ required: true }) public service!: string
  @prop({ required: true }) public env!: string

  /** CORS allowlist. pk_ only; empty = no browser origins accepted. */
  @prop({ type: () => [String], default: [] }) public origins!: string[]
  /** pk_ defaults to ['event','error','span']; sk_ defaults to all five */
  @prop({ type: () => [String], required: true }) public allowedKinds!: string[]
  /** optional narrowing to a subset of registry names */
  @prop({ type: () => [String] }) public allowedNames?: string[]

  /** records/min across the key. Distinct from EventSpec.burst (per-group). */
  @prop({ required: true, default: 600 }) public maxPerMinute!: number

  @prop({ required: true }) public createdAt!: Date
  @prop() public revokedAt?: Date
  @prop() public lastUsedAt?: Date          // touched at most once/min, not per request
}

export const KeyModel = getModelForClass(TelemetryKey)
```

Boot-time assertions, same spirit as `validateRollupSpecs()`:
`claimed` ⇒ `kind === 'secret'` · `fixed` ⇒ `tenantId` present ·
`publishable` ⇒ `allowedKinds` excludes `usage`.

**Why a pk_ in a public bundle is acceptable:** it grants exactly one ability —
write registry-validated, kind-restricted, rate-limited telemetry attributed to
this app. Abuse ceiling is noise in your quarantine, not data access. The things
worth stealing (read access, usage writes, tenant assertion) all require `sk_`.

---

## 3. Wire protocol

One endpoint, batch-only. A single record is a batch of one.

```jsonc
POST /telemetry/ingest
Authorization: Bearer pk_live_tk_a1b2c3...
{
  "sdk":    { "name": "@foundry/telemetry-web", "version": "1.4.0" },
  "sentAt": "2026-08-10T21:04:05.120Z",        // batch flush time, client clock
  "client": { /* ClientContext — once per batch, not per record */ },
  "context": {                                  // claims; validated per key mode
    "subjects": [{ "type": "session", "id": "ses_01912f" },
                 { "type": "anon",    "id": "anon_9f3c" }],
    "actor": "anon:anon_9f3c"
  },
  "records": [{
    "_id": "01912f4e-...",                      // client-generated UUIDv7 — REQUIRED
    "name": "report.shared",
    "occurredAt": "2026-08-10T21:03:58.891Z",
    "attrs": { "format": "pdf", "route": "/reports" },
    "metrics": { "rows": 4021 },
    "severity": "info",
    "traceId": "...", "spanId": "...", "parentId": null, "durationMs": null
  }]
}
```

Rules, in order of how expensive they were to learn elsewhere:

1. **Client generates `_id`.** Retries are the norm (`sendBeacon` has no
   response, mobile radios die mid-flush), so the transport is at-least-once and
   idempotency must come from the record, not the connection.
2. **At-least-once delivery ⇒ insert-gated rollups.** Schema §4.6's usage
   inversion generalizes: ingest-sourced records insert first (duplicate `_id`
   ⇒ drop silently, **no rollup**), then aggregate. In-process `emit()` keeps
   rollup-first. The rule in one line: *the plane order follows the delivery
   semantics.*
3. **Server computes `clockSkewMs = sentAt − receivedAt`** and stores it in
   `client.clockSkewMs`; `occurredAt` is corrected by the same skew before
   rollups run — this is the fix for schema §9's "skewed client shifts a cohort."
4. **Batch context merges under each record**, never over it: a record-level
   subject wins over a batch-level one of the same type.
5. **Responses are boring on purpose:** `202` with `{accepted, rejected}`
   counts. Rejected records go to quarantine, not back to the client — a browser
   can't fix a schema violation, and error bodies become an oracle.

Size caps: 100 records or 512 KB per batch, whichever first. The error surface
splits on key kind (build-plan §9 / traps §19): **`pk_` never 4xxes** — a
telemetry error surfacing in a browser console reads as a broken page, so
unknown names, oversize, rate limits, and over-cap all drop, quarantine what's
parseable, count, and return `202`/`204`, per-record (one bad record never
kills a batch). `sk_` callers are programmers: over-cap is `413`, invalid is
`400`, honest and loud.

---

## 4. Ingest handler

Exported from the server entry as an express handler, matching the template's
peer setup. The pipeline:

```
key lookup (point read, cached 60s)
  → revoked? origin allowed? kind/name allowed? per-key rate limit
  → resolve tenant per tenantMode        (fixed | adapter | claimed)
  → resolve identity claims              (per key trust; strip what's not allowed)
  → stamp facts: service, env, origin, receivedAt, clockSkewMs
  → per-record: dedupe insert → validate (same hook as emit) → rollups
  → 202 { accepted, rejected }
```

**Host adapters** — the seam, named per standards/adapters.md, both directions:

```ts
createIngestHandler({
  /** INBOUND: who is making this request? Only consulted for tenantMode=session. */
  contextAdapter: {
    resolveContext: (req) => ({ tenantId, subjects?, actor? } | null),
  },
})
```

The outbound direction already exists: it is `forget()` (schema §4.7) — the host
tells telemetry a person is gone. `identify()` below is inbound identity from
the client side; `resolveContext` is inbound identity from the host side. When
both speak, `resolveContext` wins — the session cookie outranks the JS claim.

What the handler refuses to do: parse cookies itself, know about your auth
library, or accept a `tenantId` header as a fallback. Tenant resolution is
either the key's (`fixed`), the host's (`session`), or the payload's (`claimed`,
sk_ only) — there is no fourth path.

---

## 5. Identity: `identify()` and `telemetry_aliases`

Pre-login, every client record carries `anon` + `session` subjects (schema
§2.3). At login the SDK calls `identify({ user, org })`, which does two things:

1. Future records carry the real subjects.
2. The SDK posts one `alias` control record; the server upserts:

```ts
@modelOptions({ schemaOptions: { collection: 'telemetry_aliases', versionKey: false } })
@index({ tenantId: 1, userRef: 1 })
export class TelemetryAlias {
  /** `${tenantId}|${anonRef}` — one anon maps to at most one user */
  @prop({ required: true, type: () => String }) public _id!: string
  @prop({ required: true }) public tenantId!: string
  @prop({ required: true }) public anonRef!: string     // 'anon:anon_9f3c'
  @prop({ required: true }) public userRef!: string     // 'user:u_123'
  @prop({ required: true }) public linkedAt!: Date
}
```

This table is the **input** to schema §9's stitching job — the batch job walks
aliases, rewrites `subjectKeys`/`otherPrincipals`/rollup keys for the anon refs,
then marks the alias consumed. Without this table the job has nothing to read;
with it, stitching is a cursor, not a heuristic.

Erasure: `forget()` must also delete aliases where either side matches the
erased ref (amended in schema §4.7). An alias row is pure linkage — there is
nothing to redact, only to delete.

---

## 6. SDK core (isomorphic)

One core, zero heavy dependencies, roughly 80% of the SDK by value. Everything
platform-specific is an adapter over this.

```ts
const telemetry = createTelemetry<typeof REGISTRY>({
  key: 'pk_live_tk_...',
  url: 'https://app.example.com/telemetry/ingest',
  release: __APP_VERSION__,            // injected at build; key supplies service/env
})

telemetry.track('report.shared', { attrs: { format: 'pdf', route: '/reports' },
                                   metrics: { rows: 4021 } })   // typed via registry
telemetry.identify({ user: 'u_123', org: 'o_9' })
telemetry.captureError(err, { handled: false })
const span = telemetry.startSpan('pdf.render'); /* ... */ span.end()
```

| module | what it does |
|---|---|
| **typed api** | `track`/`captureError`/`startSpan`/`state` typed against the host registry — `import type`, so zod never reaches the bundle |
| **context** | `identify()`, session start/rotate (new `ses_` per visit), persistent `anon_` id, current subjects merged into every record |
| **batcher** | ring buffer (drop-oldest at cap), flush on size / interval / `visibilitychange`; `sendBeacon` → `fetch keepalive` fallback on unload; backoff retry; pluggable queue (memory default, disk for CLI/Electron) |
| **tracing** | UUIDv7 trace ids (schema §2.6 requires the random tail), span stack, W3C `traceparent` injection on `fetch` so server spans join the client trace |
| **ids** | client-side `newId()` for record `_id`s — the §3 idempotency contract |

---

## 7. Platform adapters

Thin by design — each is wiring, not behavior. If an adapter grows past ~150
lines, something belongs in core.

| entry | wires up |
|---|---|
| `./web` | ClientContext capture, `window.onerror` + `unhandledrejection`, consent/DNT/GPC gate, unload flush |
| `./react` | `<TelemetryErrorBoundary>`, `useTelemetry()`; router integration stays userland |
| `./vue` | plugin: `app.config.errorHandler`, `provide/inject` accessor |
| `./electron` | **main**: node transport, `process` crash handlers, disk queue. **renderer**: web adapter with an IPC transport — records route through main, so the key stays out of the renderer, one queue, offline works |
| `.` (server) | trusted side: in-process `emit()` (no HTTP hop), request-span middleware, error hook, `AsyncLocalStorage` request context, the ingest handler (§4), `forget()`, models |
| `./cli` | disk queue in the config dir (flush on exit *and* next run — exit flushes get killed), machine-id `anon`, hard `DO_NOT_TRACK` / `--no-telemetry` respect |

The node server imports the server entry and never speaks the wire protocol to
itself. The wire exists for processes that cannot be trusted or cannot reach
Mongo — everything trusted goes straight to `emit()`.

---

## 8. The registry is the host's, not the package's

schema.md shows `REGISTRY` inline for exposition, but multi-app reality is:
**the package ships the mechanism, each app ships its registry.**

```ts
// app/telemetry.registry.ts — isomorphic, imported by server AND clients
import { defineRegistry } from '@foundry/telemetry/core'
export const REGISTRY = defineRegistry({ /* EventSpecs */ })
```

- Server: runtime import — validation, rollups, indexes derive from it.
- Clients: `import type` only — full `track()` typing, zero runtime cost.
- One package version + one registry file = client and server can never
  disagree about an event's shape. That lockstep is the reason packaging (§9)
  is one package, not many.

---

## 9. Packaging

One published package, subpath exports, exactly the template's shape:

```jsonc
"exports": {
  ".":          // server: model, emit, rollups, forget, ingest, keys, aliases
  "./core":     // isomorphic: defineRegistry, types, batcher, context, tracing
  "./web": {}, "./react": {}, "./vue": {},
  "./electron": {}, "./electron/renderer": {},
  "./cli": {}
},
"peerDependencies": { "mongoose": "…", "express": "…", "react": "…", "vue": "…" },
"peerDependenciesMeta": {
  "mongoose": { "optional": true }, "express": { "optional": true },
  "react":    { "optional": true }, "vue":     { "optional": true }
}
```

- `peerDependenciesMeta.optional` is the one addition to the template pattern —
  without it, npm ≥7 auto-installs mongoose into every React app that adds the
  package.
- Framework adapters import their framework; bundlers only resolve it when that
  subpath is imported. The server stack never appears in a client graph.
- **Not** `packages/telemetry/packages/*`, **not** per-framework packages.
  Sentry's ~30 packages buy independent versioning at a scale where lockstep is
  impossible; here lockstep is the type-safety mechanism (§8). Split only if
  dependency isolation fails in practice, and then along the trust boundary
  (client/server) — never per framework.
- CI/tsup: multi-entry build, same workflows as the template. Nothing new to
  deploy — the ingest handler rides in the host app.

---

## 10. Open items

- [ ] **Key management surface** — `createKey()` mints (t.createKey / exported
      helper, Stage 4); revoke/rotate is still "set revokedAt." Needs a CLI
      subcommand before a second operator.
- [x] **Secret comparison** — done Stage 4: scrypt (N=16384, r=8, p=1, len 32),
      version prefix `scrypt1$` in the hash string, `timingSafeEqual` compare.
- [ ] **Consent UX** — Stage 4 ships the mechanism: DNT/GPC are hard signals
      the host cannot override, and `consent()` gates sending (opted-out
      clients drop instead of hoard). The EU default-*off* posture remains a
      host decision to document.
- [x] **IP handling** — enforced by construction: the envelope has no IP field
      and the ingest handler never reads `req.ip`, so there is nothing to
      truncate. Any future IP-derived feature must re-open this item.
- [x] **Offline queue caps** — Stage 4: every queue is a drop-oldest ring
      (`maxQueueSize`), and the CLI's next-run replay drops records older than
      `maxQueueAgeMs` (default 7d) so an offline month never lands in today's
      buckets.
- [ ] **Stitching job** — consumes `telemetry_aliases` (§5); bounded batches,
      rewrites raw + rollup keys, marks aliases consumed. Design in schema §9,
      input defined here, implementation still unwritten.
