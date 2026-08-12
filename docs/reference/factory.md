# `createTelemetry(config)`

The package factory. Returns the write path, erasure, tenant-scoped reads, and
the checkpoint primitive. The routers ([`createIngest`](/reference/routers),
[`createDashboard`](/reference/routers)) are separate factories that take this
instance — they never build their own storage.

```ts
import mongoose from 'mongoose';
import { createTelemetry } from '@jeffjassky/telemetry';
import { REGISTRY } from './telemetry-registry.js';

const t = createTelemetry({ registry: REGISTRY, connection: mongoose });
await t.syncIndexes();                       // boot, before the first write
await t.emit('user.signed_up', { tenantId, subjects, attrs });
```

Signature:

```ts
function createTelemetry<const R extends Registry>(
  config: CreateTelemetryConfig<R>,
): Telemetry<R>;
```

The `const` type parameter is what keeps `emit()` typed: literal registry shapes
survive into `AttrsOf`/`MetricsOf`.

## Config

| Key | Type | Default | |
|---|---|---|---|
| `registry` | `Registry` | — | **Required.** The host-owned event registry. See [`defineRegistry`](/guide/registry). |
| `connection` | `Connection \| Mongoose` | — | **Required.** A mongoose `Connection`, or the mongoose module itself (its default connection is used). |
| `collection` | `string` | `'telemetry'` | Base collection. Siblings derive: `<collection>_rollups`, `_rejects`, `_aliases`, `_checkpoints`, `_keys`, `_views`. |
| `modelName` | `string` | `'Telemetry'` | Mongoose model name. **Set it when two instances share one connection** — a reused name silently reuses the *first* instance's registry and counters. |
| `pepper` | `string` | `process.env.TELEMETRY_PEPPER` | Secret pepper for `forget()`'s pseudonymous rekeying. `forget()` throws if neither is set. |
| `platforms` | `readonly string[]` | `[]` | **Extends** the builtin `client.platform` enum (`web`, `electron`, `ios`, `android`, `server`, `cli`) — never replaces it. |
| `bodyMax` | `number` | `BODY_MAX_CHARS` (16384) | Per-instance `body` character cap. Over it the value is clipped, marked, and `counters.truncated` increments. |
| `globalSubjectRefs` | `boolean` | `false` | Declares that a subject ref names the same party in **every** tenant. Only effect today: `forget()` also erases the person's platform-scoped saved views. Leave off when ids are minted per tenant. |
| `logger` | `Logger` | no-op | `{ info, warn, error }`. |

### Throws at construction

- `validateRegistry(registry)` fails — a registry mistake fails the deploy, not
  the dashboards.

### Warns at construction

- an event declares `data` but no explicit `retentionDays`. Its payloads inherit
  `RETENTION_DAYS[kind]` and `expiresAt` is stamped per row at **write** time, so
  it cannot be undone after the fact. An explicit `retentionDays` (including
  `null` for immortal) is a choice, and silences the warning.

## The instance

```ts
interface Telemetry<R extends Registry = Registry> { … }
```

### `emit(name, doc)`

```ts
emit<N extends keyof R & string>(name: N, doc: EmitInput<R, N>): Promise<EmitResult>
```

The only write. Typed against the registry — an unknown name is a compile error,
and `attrs`/`metrics` are inferred per event. Returns
`{ id, outcome }` where `outcome` is one of `'written' | 'queued' | 'deduped' |
'sampled' | 'capped' | 'rejected'` — `Promise<void>` could not distinguish
"durably stored" from "the save is in flight". The `id` is minted up front, so
even a rejected call hands back something to correlate on.

See [Emitting records](/guide/emit).

### `forget(tenantId, ref)`

```ts
forget(tenantId: string, ref: EntityRef): Promise<ForgetResult>
```

Erasure. Deletes rows where the subject is the sole party, redacts rows shared
with others, rekeys rollups to a pseudonymous ref, drops aliases, and handles
saved views. Returns counts:
`{ deleted, redacted, rollups, aliases, views }`.

Tenant-scoped, and it **rejects `PLATFORM_SCOPE`** — a platform-wide erasure is N
calls that each name their tenant, not one call that reaches everything. Reaches
the person's platform-scoped saved views only when `globalSubjectRefs` is set.

Throws without a pepper.

### `scoped(tenantId)`

```ts
scoped(tenantId: string): Scoped
```

The host-facing isolation primitive. Four escape hatches onto the raw models,
each with the tenant pinned:

```ts
interface Scoped {
  find(q?): Query<any[], any>;
  aggregate(stages): Aggregate<any[]>;
  rollups(q?): Query<any[], any>;
  rollupAggregate(stages): Aggregate<any[]>;
}
```

The pin spreads **last** (`{ ...q, tenantId }`), so a caller-supplied `tenantId`
in the query cannot override the scope — the exact hole `scoped()` exists to
close.

**Deliberately strict about `'*'`.** `scoped()` does not know about
`PLATFORM_SCOPE` and never will. `scoped('*')` scopes to the literal string `'*'`
and, since `'*'` is reserved on the write side, matches nothing — never
"everything". Its guarantee is worth more unconditional: whatever string goes in,
only rows carrying that string come out. Cross-tenant reads live one layer up, in
the query primitives behind `viewerAdapter`, where an authorization decision has
actually been made.

### `checkpoint(key)`

```ts
checkpoint(key: string): Checkpoint       // { get(): Promise<Date|null>; advance(at: Date): Promise<void> }
```

Pull-importer watermark. `get()` is `null` on the first ever run. Advisory —
downstream writers must be idempotent anyway, because a checkpoint that is
correct and a writer that is not is still a duplicate.

### `syncIndexes()`

```ts
syncIndexes(): Promise<void>
```

Boot step. Awaits `Model.init()` on every model, drops orphaned payload indexes,
builds the registry-driven `indexedAttrs`/`indexedMetrics` indexes, and creates
the rejects TTL index. **Await it before the first write** — cold-DB writes
racing async index builds silently duplicate, and the unique idempotency index
and deterministic rollup `_id`s both depend on it.

Throws when planned payload indexes exceed `INDEX_BUDGET` (24). Orphans are
dropped *first*, so removing a registry entry to get back under the cap actually
works.

### `flush()`

```ts
flush(): Promise<void>
```

Awaits in-flight fire-and-forget writes. Tests and `SIGTERM` handlers both need
"everything emitted is queryable". Note that it drains *every* in-flight write
globally — a host that only needs one call awaited should use `durable: true` on
that call instead.

### `counters`

`TelemetryCounters` — a live, mutable, per-process object:

```ts
{ rejected, defaulted, sampled, capped, rollupSkipped, deduped, truncated }
```

Surface it on `/metrics` so drops are never silent. The dashboard's System page
renders the same object.

### `registry`

The registry this instance validates against, exposed for the router factories.
Hosts should import their own registry module rather than read it off here.

### `logger`

The configured `Logger`.

### `createKey(input)`

```ts
createKey(input: CreateKeyInput): Promise<{ key: string; id: string }>
```

Mints an ingest key against this instance's key collection. **The full key string
is returned once and is never reconstructable** — only the `tk_` id and, for
`sk_`, a scrypt hash of the secret half are stored.

Throws when: `tenantMode: 'claimed'` on a publishable key; `tenantMode: 'fixed'`
without a `tenantId`; `tenantId` is `PLATFORM_SCOPE`; a publishable key's
`allowedKinds` includes `usage`.

See [Ingest & keys](/guide/ingest) and [`CreateKeyInput`](/reference/types#key-and-ingest-types).

### `models`

| | |
|---|---|
| `models.telemetry` | the base model — query across every kind |
| `models.byKind` | `Record<TelemetryKind, Model>` — the five discriminators |
| `models.rollups` | the rollup collection |
| `models.checkpoints` | the checkpoint collection |
| `models.keys` | the ingest key collection |

Exposed for hosts and for the router factories. Reads through these are **not**
tenant-scoped — that is what `scoped()` is for.

### `collections`

| | |
|---|---|
| `collections.rejects()` | quarantined writes, raw driver `Collection`. TTL 30 days. |
| `collections.aliases()` | anon→user links from `$identify`, raw driver `Collection`. |

These live outside mongoose models because neither has a schema worth enforcing:
a reject is by definition a document that failed one.

## Also exported from the package root

Everything below is a named export of `@jeffjassky/telemetry`. See
[Types & payloads](/reference/types) for the full surface.

| | |
|---|---|
| `defineRegistry(specs)` | identity with a `const` type parameter — keeps literal shapes |
| `validateRegistry(registry)` | boot-time contract checks; `createTelemetry` runs it |
| `boundedMeta()` | the bounded `data` escape hatch |
| `createIngest(opts)` / `createDashboard(opts)` / `defaultSpaDir()` | the routers — [Routers](/reference/routers) |
| `createQueries(ctx)` / `DEFAULT_LIMITS` | the read primitives, standalone |
| `deriveViews(registry)` | the registry-generated views |
| `createKey(KeyModel, input)` | the standalone form of `t.createKey` |
| `parseKeyString` / `hashSecret` / `verifySecret` | key primitives |
| `median` / `summarizeStages` / `findFamily` / `requireMilestoneFamily` | funnel math, usable without a database |
| `newId` / `traceKeep` / `plain` / `truncate` / `isPlatformScope` | helpers |
| `PLATFORM_SCOPE` / `RETENTION_DAYS` / `SAMPLE_RATE` / `SCHEMA_VERSION` / `INDEX_BUDGET` / `BODY_MAX_CHARS` | constants |
