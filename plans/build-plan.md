# telemetry — build plan

Stage 3 output. Inputs: [notes/recon-maxed.md](./notes/recon-maxed.md) (single
implementation; synthesis skipped per process/1-recon.md) and the three design
docs that superseded `product-ideas.md`: [schema.md](./schema.md) (storage, v2.3),
[instrumentation.md](./instrumentation.md) (ingest/SDKs/packaging),
[dashboards.md](./dashboards.md) (read surface/UI).

Everything after this document is execution.

---

## 0. The paper test (recon's opening demand)

*"Express maxed's current taxonomy as config; if it needs special cases, the
config layer isn't real."* Maxed's actual vocabulary — 5 client events, 7
milestones, 2 exits, admin exclusion, user/account subjects — as a literal
registry block:

```ts
export const REGISTRY = defineRegistry({
  // ── observations — repeat freely ─────────────────────────────
  'page.view':                  { kind: 'event', origin: 'client', subjects: ['user', 'account', 'session'],
                                  data: boundedMeta() },
  'product.wizard_step_viewed': { kind: 'event', origin: 'client', subjects: ['user', 'account'], data: boundedMeta() },
  'product.data_viewed':        { kind: 'event', origin: 'client', subjects: ['user', 'account'] },
  'billing.plan_selected':      { kind: 'event', origin: 'client', subjects: ['user', 'account'],
                                  attrs: z.object({ plan: z.string().max(64) }), indexedAttrs: ['plan'] },
  'billing.paywall_hit':        { kind: 'event', origin: 'client', subjects: ['user', 'account'] },

  // ── milestones = lifetime subject rollups; firstAt IS the milestone ──
  // once-per-account falls out of the rollup upsert: emitters may fire on
  // every render, count increments, firstAt never moves. No dedupe keys.
  'account.signed_up':   { kind: 'event', origin: 'server', subjects: ['account'],
                           attrs: z.object({ source: z.string().max(64) }),
                           rollups: [{ by: ['subject'], subjects: ['account'], capture: ['attr:source'] },
                                     { as: 'activity', by: ['subject'], subjects: ['account'], bucket: 'day', retentionDays: 730 }] },
  'wizard.started':      { kind: 'event', origin: 'client', subjects: ['account'],
                           rollups: [{ by: ['subject'], subjects: ['account'] }] },
  'topic.finalized':     { kind: 'event', origin: 'server', subjects: ['account'],
                           rollups: [{ by: ['subject'], subjects: ['account'] }] },
  'data.first_viewed':   { kind: 'event', origin: 'client', subjects: ['account'],
                           rollups: [{ by: ['subject'], subjects: ['account'] }] },
  'plans.viewed':        { kind: 'event', origin: 'client', subjects: ['account'],
                           rollups: [{ by: ['subject'], subjects: ['account'] }] },
  'plan.selected':       { kind: 'event', origin: 'client', subjects: ['account'],
                           rollups: [{ by: ['subject'], subjects: ['account'] }] },
  'account.converted':   { kind: 'event', origin: 'server', subjects: ['account'],   // server-only: an
                           rollups: [{ by: ['subject'], subjects: ['account'] }] },  // account cannot talk
                                                                                     // itself into converting
  // ── funnel exits — upgraded to what they are: state transitions ──
  'account.lifecycle':   { kind: 'state', origin: 'server', subjects: ['account'] }, // to: 'trial_expired' | 'canceled' | ...
})
```

**Verdict: passes, with two mappings and zero special-cased code.**

1. Maxed's stored-milestone machinery (dedupe keys, partial-unique index,
   `type: "milestone"`) collapses into the lifetime subject rollup — the
   emitter contract ("call it on every render without thinking") survives.
2. `CLIENT_MILESTONES` (browser may assert `wizard_started`, never `converted`)
   maps to per-entry `origin` + the key's `allowedNames` — the publishable key
   cannot write a server-origin name.
3. Funnel exits become `kind=state` transitions — strictly richer (dwell time
   via `previousSinceMs`), queried from the state rollup, not a special event
   band.
4. Admin exclusion (`{ actorRole: { $ne: 'admin' } }`) maps to the `actor` ref
   convention (`admin:u_9`, `system:cron`) — a standard query-layer toggle
   ("exclude non-customer actors"), not per-callsite discipline.
5. **The one real friction, resolved:** maxed deliberately refuses per-event
   meta schemas ("ceremony"); schema v2 refuses undeclared `data` (erasure
   guarantee). The bridge is `boundedMeta()` — an exported zod helper encoding
   maxed's exact shape guard (scalars only, ≤12 keys, ≤200-char strings, one
   nesting level, 4 KB serialized, **drop-never-truncate**). Declared = stored,
   erasure holds; ceremony = one token.

---

## 1. Name

`@jeffjassky/telemetry` — recorded in sources.yaml, npm-verified free (404) on
2026-08-10. Unscoped `telemetry` held since 2011. Repo slug `telemetry`.
Standing user decision; not re-litigated.

## 2. Public API (one screen)

```ts
// ── server entry (".") ───────────────────────────────────────
defineRegistry(specs)                      // identity + types; boot validation
createTelemetry({ registry, db })          // → t
  t.emit(name, doc)                        // write — the only write
  t.forget(tenantId, ref)                  // erasure: delete/redact/rekey/aliases
  t.scoped(tenantId)                       // → { records, series, distribution, rollups, trace, journey }
  t.checkpoint(key)                        // → { get, advance } — pull-importer watermark
  t.syncIndexes() / t.counters             // boot + /metrics
createIngest({ telemetry, contextAdapter })            // → express.Router
createDashboard({ telemetry, viewerAdapter, subjectAdapter?, views? }) // → express.Router
boundedMeta()                              // the maxed-shaped data escape hatch

// ── client entries ("/core", "/web", "/react", "/vue", "/electron", "/cli") ──
createClient<typeof REGISTRY>({ key, url, release })   // → c
  c.track(name, { attrs, metrics })        // typed against the registry
  c.captureError(err, ctx?) / c.startSpan(name) / c.state(...)
  c.identify({ user, org })                // writes the alias, swaps subjects
  c.flush() / c.shutdown()
```

Writes are verbs (`emit`, `track`, `identify`, `forget`, `advance`); reads are
the noun returned (`records`, `series`, `rollups`, `trace`, `journey`). Fits.

## 3. Config surface — every key with its proven caller

| Key | Proven by |
|---|---|
| `EventSpec.kind/origin/subjects` | maxed `CLIENT_EVENTS` type map + `CLIENT_MILESTONES` server-only split |
| `EventSpec.attrs/metrics` (zod) | maxed `sanitizeMeta` + the `source`/`plan` dimensions its breakdowns group on |
| `EventSpec.data` + `boundedMeta()` | maxed meta philosophy (recon §5) — drop-never-truncate carried verbatim |
| `EventSpec.indexedAttrs/indexedMetrics` | maxed byName/byPage/bySource breakdowns (adminTelemetry.ts) |
| `EventSpec.rollups` | maxed stored milestones + `UserEventDaily` + `AccountStateDaily` — three hardcoded rollups become one primitive |
| `EventSpec.retentionDays` | recon smell #4 — maxed has *no* retention; ships v1 (decision closed) |
| `EventSpec.burst` | maxed `express-rate-limit` keyed on user id (routes/events.ts:58), generalized per-group |
| `EventSpec.sampleRate` | **unproven — dormant by design** (schema §2.6); ships because it costs one field and rollups are already ordered to survive it |
| key `tenantMode/allowedKinds/allowedNames/origins/maxPerMinute` | maxed's `requireAuth` beacon + allowlist, split into declared trust (instrumentation §2) |
| `createDashboard.views` | maxed's hardcoded funnel/breakdown pages, as data; user-saved views are the same shape (dashboards §3) |
| `queryLimits` + `onSlowQuery` | recon smell #5 (in-memory slice) + maxed's query cache — caps go **inside** pipelines; traps §18 |

Cut from the old design by v2 (recon's "unproven" list, resolved by collapse,
not by building them): `writers`→keys, `firsts`→rollups, `funnels:{}`→rollup
families + queries, `link()`→aliases+stitching job, `keepCounts`→redact/rekey,
`stamp`/`relations`/dotted-`where`→registry dims.

## 4. Adapters — both directions, named

| Adapter | Inbound (package asks) | Outbound (host tells) | Absent peer |
|---|---|---|---|
| `contextAdapter` (ingest) | `resolveContext(req) → { tenantId, subjects?, actor? } \| null` — proven: maxed `context.ts` req.user + membership check | `forget(tenantId, ref)` — the erasure call | required for `tenantMode: 'session'`; other modes need none |
| `viewerAdapter` (dashboard) | `resolveViewer(req) → { tenantId, role } \| null` — proven: `requireAuth, requireAdmin` | none — read-only surface, stated | required; dashboard refuses to mount without it |
| `subjectAdapter` (dashboard) | `describe(refs[]) → { ref: { label, href? } }` — proven: adminTelemetry joins `clientAccountModel`/`User` for names | `forget()` covers it | optional; refs render raw |
| `logger` | `logger.info/warn/error` — proven: pino everywhere | — | no-op default |
| cross-package `track` | — | siblings call `telemetry.track` as optional peer callback | no-op default, records nothing (house-style) |

**Checkpoint: decided — primitive.** Recon question #3 closed. 64 proven lines
(maxed `checkpoint.ts`), advisory watermark with safety-overlap rewind, backs
every pull-importer (mailery emails, Stripe backfill). Hooks were the wrong
slot; `t.checkpoint(key)` is the right one. The importers themselves stay
host-owned (the nightlySweep split, recon §Woven).

## 5. Package split

**One npm package, entries split on trust** — the process doc's principle
(split on trust, not features) satisfied inside one artifact, per house
template: `.` (server: models, emit, ingest, dashboard router — the only entry
that sees mongoose/express or a secret), `/core` + platform entries (browser/
CLI-safe, publishable key only, zero heavy deps). `peerDependenciesMeta:
optional` on mongoose/express/react/vue keeps npm≥7 from dragging the server
stack into client installs (instrumentation §9). Split into a second package
only if dependency isolation fails in practice — then client/server, never
per-framework.

## 6. Cross-package deps

None hard. mailery: the email-event bridge is a host-owned importer on
`t.checkpoint` + `t.emit` — the package never imports mailery (recon: the
bridge is a CRM feature wearing a telemetry hat; the CRM half stays in the
host). Siblings consuming `track` take the no-op-default callback.

## 7. Data layer (expensive-to-reverse, settled now)

Collections: `telemetry` (discriminated), `telemetry_rollups`,
`telemetry_rejects` (TTL 30d), `telemetry_keys`, `telemetry_aliases`,
`telemetry_views`, `telemetry_checkpoints`.

- Indexes: 5 base + 5 discriminator (schema §4.3) + registry-driven payload
  budget 24 (§4.4) + 4 rollup + ~6 small across keys/aliases/views/checkpoints
  — comfortably under Mongo's 64/collection because they are spread across
  seven collections; the budget guard applies to `telemetry` only.
- **`Model.init()` awaited before first write** (recon #4 / traps #3): cold-DB
  writes racing async index builds silently duplicate — this bit maxed's
  dedupe and would bit our unique idempotency + rollup `_id`s identically.
- Money: `usage.amount` Decimal128 authoritative; `metrics.cost_usd` lossy
  double (schema §4.3).
- `_id` UUIDv7 strings everywhere; client-generated on the wire (traps §16).
- **No time-series collections, ever** (traps §17) — stitching `updateMany`
  and erasure `deleteMany` must work; schema §7 already forbids it.
- Boot-time: `validateRollupSpecs()` + key-mode assertions + registry/kind
  checks — misconfiguration fails deploy, not dashboards.
- Open verification carried from schema §9: `explain()` the multikey
  `{tenantId, subjectKeys, occurredAt}` sort before relying on it (first task
  of Stage 4, not an unknown).

## 8. UI shape

SPA at a mount path (house default): `createDashboard()` router serves
`/api/*` + Vite-built React SPA, hashed assets, SPA fallback. Headless query
client exported for host-built embedded views. No components into the host
tree; web-component escape hatch reserved and unused (dashboards §10).

## 9. Traps §15–19, answered

- **§15 time:** `occurredAt` + `receivedAt` both stored; queries use
  `occurredAt`, stated. Client clocks corrected by `clockSkewMs` at ingest
  before validation/rollups. Buckets are **UTC, explicitly** (schema §4.5) —
  display timezone is a dashboard concern, never storage. Late arrivals:
  rollup update-pipelines correct `firstAt`/`min`/`max` retroactively; spliced
  reads re-read buckets.
- **§16 idempotency:** wire records carry client UUIDv7 `_id`s; duplicate ⇒
  insert refused ⇒ **no rollup** (plane order follows delivery semantics,
  schema §4.6).
- **§17:** regular collections + partial TTL. Forbidden in schema §7.
- **§18 cap every query:** every read primitive requires a time range and
  carries `$limit` *inside* the pipeline (recon smell #5 is the cautionary
  tale); `queryLimits` config + `onSlowQuery` counter; dashboard query cache
  (10-min TTL, in-flight coalescing, 60-entry cap — proven in maxed).
- **§19 reject junk quietly:** per-key error surface. `pk_` ingest **never
  4xxes**: responds first where possible, always 202/204 — unknown name,
  oversize, rate-limited, over-cap ⇒ drop, quarantine what's parseable, count
  (`rejected`/`capped`). Per-record acceptance: one bad record never kills a
  batch. `sk_` callers are programmers and get honest errors. *(Amends
  instrumentation §3's blanket 413 — that now applies to `sk_` only.)*

Carried verbatim from recon: **distinct counts are not summable across days or
names** — DAU/WAU/MAU and users-affected read the `activity` family or raw,
never summed rollup counts (schema §4.5 already states it; the query layer
enforces it by not exposing a summable distinct). Every spliced response
reports **`dataSource`** (which store answered), recon #2. One row builder:
bulk paths map over the single document constructor — recon's live maxed bug
(`actorRole` dropped in bulk) is the argument, and `emit()` already has only
one path.

## 10. Non-goals

Free-form logs · gauges/ops time series (no `minute`, no RED) · profiling ·
arbitrary N-step ad-hoc funnels (ClickHouse, §8 exit plan) · issue workflow
state (status/assignee — host data) · vendor UI parity · components exported
into host trees · session replay · the stitching job's *scheduler* (package
ships the job, host schedules it — nightlySweep precedent) · CRM write-back
(host importer via `on`-equivalent callback + checkpoint).

## 11. Size estimate

Replaces ~6,274 lines in maxed (recon §Surface) plus 28 call sites.

| area | est. lines |
|---|---|
| server core (types, registry, model, rollups, emit, forget, keys, aliases, checkpoint) | ~1,800 |
| ingest + query routers | ~700 |
| client core + web/react/vue/electron/cli entries | ~900 |
| dashboard SPA (shell, atoms, kind pages, views) | ~2,200 |
| **total shipped** | **~5,600** |
| tests incl. ported verify harness (not counted against) | ~1,000 |

Under the thing it replaces while adding errors, spans, usage metering, keys,
erasure, and multi-tenancy maxed lacks. The client grows 111 → ~500 for
capabilities maxed's client simply didn't have (batching, offline, traces,
identify) — called out per the sanity rule rather than hidden in the total.

## 12. Sanity checks

- **Degenerate case:** one registry entry, no rollups/burst/attrs, `fixed`
  tenant key, two mounted routers. Pays for nothing: rollups/burst are absent
  unless declared, sampling is dormant at rate 1, subjects is one entry, the
  dashboard derives one view. Generalizations are free at zero-config. ✓
- **Every config key cites a caller** (§3 table); the two exceptions
  (`sampleRate` dormant, `hour` bucket) are named as category-reasoned, not
  smuggled. ✓
- **Non-goals non-empty.** ✓
- **Traps named and answered.** ✓

## 13. Execution order (Stage 4 preview)

1. `explain()` the multikey sort (the §7 carried verification) — it can
   invalidate the index strategy, so it goes first.
2. Server core against the paper-test registry; port `telemetry-verify.ts`
   assertions as the seed of the suite (dedupe under re-run, admin exclusion,
   funnel math).
3. Ingest + client core (wire contract §16/§19 tests).
4. Dashboard query layer + shell + atoms; kind pages last.
5. Host migration (maxed) is a separate job, after publish — recon's facts
   file is its input.

---

*Bug to file against maxed before this ships (standards/done.md): bulk
`recordEvents()` drops `actorRole`/`surface` — recon §Smells #1.*
