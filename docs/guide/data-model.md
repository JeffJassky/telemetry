# Data model

One envelope, five sparse typed extensions, one Mongo collection discriminated
on `kind`. This page is the stored shape field by field, and why each field is
where it is.

The design rule throughout: **promote what the storage engine or the law
requires, not what feels important.** `tenantId` is promoted because it is the
shard key and the access boundary. Your `plan` dimension is not, because it is
neither — it lives in `attrs`, where the registry constrains it and a declared
index makes it fast.

## Identity

```ts
tenantId: string                                     // required
subjects: Array<{ type: string; id: string; role?: string }>
subjectKeys: string[]                                // derived
actor?: EntityRef                                    // 'user:u_1'
onBehalfOf?: EntityRef                               // 'user:u_7'
otherPrincipals: string[]                            // derived
```

### `tenantId`

The tenancy root: shard key, access boundary, index prefix. **The only promoted
id.** Every index in the collection starts with it, `scoped(tenantId)` pins it
last so a caller-supplied query can never override it, and `forget()` is scoped
to one tenant so a platform-wide erasure is N calls that each name their tenant.

`'*'` is **reserved** and can never be written. It is the dashboard's
cross-tenant read scope, so a tenant literally named `'*'` would be a privilege
escalation via a string. `emit()` quarantines it, `forget()` and `createKey()`
(fixed mode) throw, and ingest refuses the batch whichever way the tenant
resolved.

### `subjects` — who it is *about*

An array, because a single-subject model breaks on the first real case. A
support agent impersonating a customer, a message with a sender and a recipient,
a page view that is about a user *and* an account *and* a session — these are
normal, not exotic. `role` disambiguates two parties of the same type
(`sender` / `recipient` / `impersonated`).

`subjects` is prose; `subjectKeys` is the index. It is derived at validation as
a deduplicated `['user:u_1', 'org:o_9']`, because you must never compound-index
two fields of one subdocument array — the combination `{subjects.type,
subjects.id}` would match a record with `{type: 'user', id: 'x'}` and
`{type: 'org', id: 'y'}` when you asked for `user:y`. Flattening to one string
per party makes the multikey index exact.

One index does the whole job:

```
{ tenantId: 1, subjectKeys: 1, occurredAt: -1 }
```

Every record about any subject, tenant-scoped and time-sorted. That is the
"journey" query, and it is a single index scan.

### `actor` and `onBehalfOf` — who *caused* it

`EntityRef` strings of the form `type:id` — `'user:u_1'`, `'system:cron'`,
`'admin:u_9'`. The type prefix is what makes "exclude admin and system activity"
a query-layer toggle (`excludeActorTypes`) and a rollup-time gate
(`RollupSpec.actors`) instead of per-callsite discipline.

`onBehalfOf` carries delegation and impersonation. An admin acting as a customer
is `actor: 'admin:u_9'`, `onBehalfOf: 'user:u_1'` — both facts, neither erased
into the other.

`otherPrincipals` is derived: `actor` and `onBehalfOf` *not already in*
`subjects`. It exists for erasure completeness — an admin who never appears as a
subject still appears in records about other people, and `forget()` has to be
able to find them. It gets its own partial index, filtered to non-empty arrays,
because it is usually empty and cheap to maintain that way.

## Origin

```ts
service: string     // required, defaulted-and-counted
release: string     // required, defaulted-and-counted
env: 'prod' | 'staging' | 'dev'
origin: 'server' | 'client'
client?: ClientContext
```

`service` and `release` are `required: true` in the schema and yet you are not
required to pass them. That is not a contradiction — it is the point.

**They are filled by the pre-validate hook and never by a schema `default:`.**
Mongoose applies schema defaults at *construction*, before the hook runs. A
`default: 'unknown'` would mean the hook could never tell "the caller omitted
it" from "the caller sent 'unknown'", so `counters.defaulted` would be pinned at
zero forever and the gap would be invisible. Worse, a `default:` on `env` would
silently stamp development traffic as production.

So: missing `service` or `release` becomes `'unknown'` **and increments
`counters.defaulted`**. Missing `env` is inferred from `NODE_ENV`. You get a
record either way — telemetry that throws on missing metadata is telemetry
people delete the call sites of — but the gap is countable, and a rising
`defaulted` counter tells you exactly which deploy stopped passing its release.

`client` is the browser/device context: platform, appVersion, OS, viewport,
locale, connection, `clockSkewMs`. It is **required for `origin: 'client'`
specs**, enforced by the registry hook. `platform` is the one closed enum on the
envelope, and hosts extend it — see
[`platforms`](/guide/configuration#platforms).

## Correlation

```ts
traceId?: string
spanId?: string
parentId?: string
durationMs?: number
```

A `traceId` groups one logical request across every kind: the spans it did, the
error it threw, the usage it billed. `parentId` nests spans into a tree, which
is the waterfall every APM tool draws.

```
traceId: tr_01912f3a4b5c                          ← one user request
├─ span s_1  POST /reports/export        2841ms   ← root, parentId: null
│  ├─ span s_2  db.query users             12ms
│  ├─ span s_3  llm.completion           1900ms
│  │  └─ span s_4  http POST anthropic   1880ms   ← parentId: s_3
│  └─ span s_5  pdf.render                890ms
├─ event  report.exported                         ← point in time, no duration
└─ error  TypeError                               ← point in time
```

All four fields live on the envelope rather than on the span extension, because
every kind can carry them. The error above is findable by trace; so is the usage
row. `traceId` has its own partial index (filtered to records that have one), so
a trace read is one scan regardless of kind.

For `kind: 'span'`, `traceId`, `spanId` and `durationMs` are **required** — a
span without a duration is not a span.

Rolling up `metrics.cost_usd` across one `traceId` answers "what did this
feature cost", which neither the error nor the usage row can. That aggregate is
only valid because sampling, when enabled at all, is head-based **per trace**:
per-record sampling would give you a fraction of the spans in nearly every
trace, making every per-trace sum quietly wrong.

## Payload

```ts
attrs: Map<string, string>     // dimensions
metrics: Map<string, number>   // measures
data?: unknown                 // unstored unless declared
body?: string                  // capped and marked
```

**`attrs` are strings. `metrics` are numbers.** Mongoose casts on assignment, so
this is enforced by the storage layer, not by convention. The split is what
makes a breakdown ("group by `attrs.source`") and an aggregation ("sum
`metrics.cost_usd`") two different, obviously-correct operations rather than one
ambiguous one over a bag of mixed types.

Both are validated against the registry's zod schemas in strict mode. Both have
their dotted keys rewritten to underscores — twice, in fact: in `emit()` before
assignment, because mongoose `Map` casting rejects `.` keys *before*
`pre('validate')` runs, and again in the hook so that direct model use is
covered.

Neither gets a wildcard index. Indexes are declared per key with
`indexedAttrs` / `indexedMetrics`, because a wildcard index cannot compound with
`tenantId` and would scan across tenants. See
[the index budget](/guide/registry#the-index-budget).

**`data` is unstored unless the registry declares a schema for it.** If a record
carries `data` and the spec declares none, the field is dropped and
`counters.rejected` increments — no error, no partial write. This is the rule
that makes delete-by-subject a guarantee rather than best-effort: there is no
untyped corner where an identifier can hide from `forget()`. Use
[`boundedMeta()`](/guide/registry#boundedmeta) when you want a bag of properties
without writing a schema per event; it drops the whole object rather than
truncating it.

**`body` is capped and marked.** It is the only unbounded field on the envelope
and it feeds Mongo's 16 MB document ceiling, so it is clipped at `bodyMax`
(default 16384 chars) with a visible suffix — `… [truncated 4211 chars]` — and
`counters.truncated` increments. The cap lives in the schema hook so `emit()`,
ingest and direct model use are all covered.

That `data` drops and `body` truncates is a deliberate divergence, and the
difference is the data rather than the mood: `data` is structured evidence where
a partial object misrepresents what the caller sent, while `body` is prose where
a marked prefix beats nothing.

## Ops

```ts
sampleRate: number      // default 1
forced: boolean         // default false
expiresAt?: Date
redactedAt?: Date
```

`sampleRate` is stored **per row**: `1` means everything was kept, `0.05` means
multiply counts by 20 when aggregating over these rows. Storing it is what lets
a future aggregate weight correctly for a rate that was in force last March.

`forced` marks a row that was kept **despite** sampling — because it carried
money, an error, or a `dedupeKey`. Such rows are not representative, so an
honest aggregate excludes them from rate-weighted math rather than multiplying
them by 20.

`expiresAt` is the TTL, stamped per row at write time as `occurredAt +
retentionDays`. Its index is partial (`expiresAt` must exist), so immortal rows
— all of `usage`, and anything with `retentionDays: null` — are not indexed as
null. Because the stamp happens at write time, **retention changes are not
retroactive in either direction**.

`redactedAt` is set by `forget()` on a shared row: the record survives with its
counts and its other parties intact, the erased party's identifiers do not. See
[Erasure](/guide/erasure).

## Envelope metadata

```ts
_id: string             // UUIDv7
schemaVersion: number   // 2
kind: string            // the discriminator key
name: string            // your registry key
occurredAt: Date        // required
receivedAt: Date        // timestamps: { createdAt: 'receivedAt' }
severity: LogLevel      // default 'info'
dedupeKey?: string
```

`_id` is a **UUIDv7 string**, not an ObjectId and emphatically not
`crypto.randomUUID()` (which is v4: random, not sortable). v7 is time-ordered
and insertion-local, so `_id` doubles as insertion order for readers that sort
on it, and traceIds sample consistently on their low 32 bits. Wire records carry
client-generated `_id`s, which is what makes at-least-once delivery idempotent —
a duplicate insert is refused, and refusing the insert refuses the rollup.

Both timestamps are stored and they mean different things: `occurredAt` is when
it happened (queries use this one, always), `receivedAt` is when the row landed.
Client clocks lie; `clockSkewMs` is captured and applied at ingest before
validation and rollups.

`dedupeKey` is caller idempotency for the four non-usage kinds, with a
tenant-scoped unique partial index. The partial filter is load-bearing: without
it, every record *without* a `dedupeKey` would index `null` and the second one
would collide. It is deliberately not an `_id` passthrough, because that would
break the insertion-order invariant every sorted reader depends on.

## The five kinds

Each discriminator adds one required subdocument and its own partial indexes.

### `event`

Adds nothing — the envelope suffices. Most of your registry will be this.

### `error`

```ts
error: {
  type: string;         // 'TypeError'
  message: string;
  handled: boolean;     // default false
  fingerprint: string;  // the grouping key
  frames?: Array<{ filename?, fn?, lineno?, colno?, inApp?, context? }>;
}
```

`fingerprint` is the grouping key and it is **yours to compute** — the package
does not guess at stack normalization. Group errors into issues with a rollup on
`field:error.fingerprint`; cap the raw storm with
[`burst`](/guide/registry#burst) on the same key, and the issue counts stay
exact while the collection stores sixty examples instead of sixty thousand.

Index: `{ tenantId, error.fingerprint, occurredAt: -1 }`, partial-filtered to
`kind: 'error'`.

### `span`

Adds no fields — it constrains the envelope's own. `traceId`, `spanId` and
`durationMs` are required. Index: `{ traceId, parentId }`, partial-filtered to
spans, which is the tree walk.

### `state`

```ts
state: { key: string; from?: string; to: string; previousSinceMs?: number }
```

`key` names the state machine (`'lifecycle'`, `'onboarding_step'`), `to` is
required, `from` is optional because the first transition has no predecessor.

`previousSinceMs` — how long the subject sat in `from` — is why funnel exits are
modelled as state transitions rather than as events. "Trial expired" as an event
tells you it happened; as a state transition it tells you they sat in `trial` for
fourteen days first, which is the number that answers "where do they stall".

Index: `{ tenantId, state.key, state.to, occurredAt: -1 }`.

### `usage`

```ts
usage: {
  meter: string;              // 'ai_tokens'
  quantity: number;
  unit: string;               // 'token'
  amount?: Decimal128;        // authoritative money
  currency?: string;
  idempotencyKey: string;     // required — deterministic
  billedTo: EntityRef;        // required — 'org:o_9'
  billable: boolean;          // default true
  priceVersion?: string;
  reverses?: string;
}
```

Money gets four guarantees the other kinds do not have: never sampled, never
burst-capped, always durable (`{ w: 'majority', j: true }` and a rethrow on
failure), and never expired (`RETENTION_DAYS.usage` is `null`).

**`idempotencyKey` has a unique index**, partial-filtered to `kind: 'usage'` —
without that filter, discriminator indexes apply to the whole collection, every
non-usage document would index `null`, and the second one would collide. Make
the key deterministic (`` `${traceId}:${spanId}` ``), and a retried delivery is a
no-op that aggregates nothing. That last part matters: the insert *is* the
dedupe, so the insert has to gate the rollup, which is why `usage` inverts the
plane order in [`emit()`](/guide/emit).

**`billedTo` is a third party**, distinct from `subjects` (who it is about) and
`actor` (who caused it). The user who ran the query, the account the query was
about, and the org that pays are routinely three different entities.

Corrections are **new reversing rows** (`reverses: '<id>'`), never an update to a
billed row. An invoice line that changed after the fact is not an audit trail.

Index: `{ tenantId, usage.meter, occurredAt }`, plus the unique key above.

### Why `usage.amount` is Decimal128 and `metrics.cost_usd` is not

`metrics.cost_usd` is a BSON double. Doubles are fine as a *measure* — chart it,
sum it for a dashboard, sort features by spend — and wrong as the thing that
becomes an invoice, because binary floating point cannot represent `0.1` and
summing a hundred thousand of them accumulates error you cannot explain to a
customer.

So money is authoritative **only** on `kind: 'usage'`, in `usage.amount`, as
Decimal128. `metrics.cost_usd` is a deliberate lossy copy that exists so cost
participates in the same aggregation machinery as latency and token counts —
same `sum`, same charts, same `indexedMetrics` range queries.

The rule that follows: **bill from `usage.amount`, chart from
`metrics.cost_usd`, and never reconcile one against the other.** They are not
supposed to agree to the cent; one of them is the ledger and the other is a
graph.

## The collection family

| collection | contents |
|---|---|
| `telemetry` | the envelope, discriminated on `kind` |
| `telemetry_rollups` | derived aggregates ([Rollups](/guide/rollups)) |
| `telemetry_rejects` | quarantined writes, TTL 30 days |
| `telemetry_keys` | ingest keys, hashed secrets ([Ingest & keys](/guide/ingest)) |
| `telemetry_aliases` | anon → identified subject links |
| `telemetry_views` | user-saved dashboard views |
| `telemetry_checkpoints` | pull-importer watermarks |

All of them are **regular collections**. Not time-series collections, ever:
stitching an anonymous session onto an identified user is an `updateMany`, and
erasure is a `deleteMany`, and Mongo time-series collections support neither.
That is a schema-level prohibition, not a preference.

## Next

- [The registry](/guide/registry) — what validates all of this.
- [Emitting records](/guide/emit) — the two-plane write path.
- [Rollups](/guide/rollups) — the derived aggregates and how they are keyed.
- [Erasure](/guide/erasure) — what `forget()` does to every field above.
- [Types & payloads](/reference/types) — the exported TypeScript surface.
