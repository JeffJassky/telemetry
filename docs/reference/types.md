# Types & payloads

The complete public type surface. Types are **hand-written** `.d.ts` in `types/`,
never generated — `types/index.d.ts` is the contract, and `types/test-d.ts`
compiles every symbol on this page so the declarations cannot drift silently.

```ts
import type { Registry, EmitInput, Viewer } from '@jeffjassky/telemetry';
import type { TelemetryClient } from '@jeffjassky/telemetry/core';
```

---

## Vocabulary

Each of the four vocabularies is a **`const` object and a type of the same
name** — a value in an expression, a union in a type position.

```ts
declare const TelemetryKind: { Event: 'event'; Error: 'error'; Span: 'span'; State: 'state'; Usage: 'usage' };
type TelemetryKind = 'event' | 'error' | 'span' | 'state' | 'usage';

declare const LogLevel: { Debug: 'debug'; Info: 'info'; Warn: 'warn'; Error: 'error'; Fatal: 'fatal' };
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

declare const Env: { Prod: 'prod'; Staging: 'staging'; Dev: 'dev' };
type Env = 'prod' | 'staging' | 'dev';

declare const Origin: { Server: 'server'; Client: 'client' };
type Origin = 'server' | 'client';

/** `type:id` — 'user:u_1', 'org:o_9', 'system:cron' */
type EntityRef = `${string}:${string}`;

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
```

So `kind: TelemetryKind.Usage` and `kind: 'usage'` are the same registry spec —
the const is an addition, never a narrowing. Reach for the object when a name
reads better than a string literal, and for the literal everywhere else.

```ts
import { TelemetryKind, Origin } from '@jeffjassky/telemetry';

defineRegistry({
  'invoice.charged': { kind: TelemetryKind.Usage, origin: Origin.Server, /* … */ },
});
```

### Constants

| | Value | |
|---|---|---|
| `RETENTION_DAYS` | `{ span: 90, error: 90, event: 730, state: 730, usage: null }` | `Record<TelemetryKind, number \| null>`. `null` = immortal — money never expires. Overridden per event by `EventSpec.retentionDays`. |
| `SAMPLE_RATE` | every kind at `1` | `Record<TelemetryKind, number>`. Keep-all: at small-SaaS scale exactness beats extrapolation. The per-trace machinery stays, dormant. |
| `SCHEMA_VERSION` | `2` | Stamped on every row. |
| `INDEX_BUDGET` | `24` | Payload indexes the registry may plan. Mongo caps a collection at 64; base + discriminators use about ten. `syncIndexes()` throws over it. |
| `BODY_MAX_CHARS` | `16384` | `body` cap in characters. Over it the value is clipped with a visible `… [truncated N chars]` marker and `counters.truncated` increments. Per-instance override: `bodyMax`. |
| `PLATFORM_SCOPE` | `'*'` | The dashboard's cross-tenant read scope, and a **reserved** tenant token on every write path. |
| `SUBJECT_MAX` | `8` | Total subjects one record may carry once `subjectLinker` has run. Every subject is a multikey index term and one more fan-out per `by:['subject']` family, so the array is bounded. Overflow is dropped and counted. |
| `SUBJECT_LINK_TIMEOUT_MS` | `50` | Default `subjectLinkTimeoutMs`. Past it the record is written **unlinked** rather than waiting. |
| `RELINK_BATCH_SIZE` | `500` | Records `relink()` fetches per batch, and how often its `onProgress` fires. |
| `DEFAULT_LIMITS` | see [Query and view types](#query-and-view-types) | `QueryLimits`. |

### Helpers

```ts
function isPlatformScope(tenantId: unknown): boolean;

/** UUIDv7 — sortable, insertion-local. Never substitute crypto.randomUUID (v4). */
function newId(): string;

/** Consistent per-trace sampling verdict. Throws in dev on an unsampleable traceId. */
function traceKeep(traceId: string | undefined, rate: number): boolean;

/** Deep-converts Mongoose Maps to plain objects — JSON.stringify(Map) is '{}'. */
function plain(v: unknown): unknown;

function truncate(d: Date, bucket?: 'hour' | 'day' | 'week' | 'month'): Date | undefined;

/** resolve one dimension source off a record — `'subject'` is fan-out, so it yields undefined */
function resolveDim(src: DimSource, doc: any): unknown;
```

`newId` returns UUIDv7 because `_id` doubles as insertion order and trace ids are
sampled on their random hex tail. v4 is random and would break both.

`plain()` before any `JSON.stringify` of a hydrated document — `attrs` and
`metrics` are Mongoose `Map`s, and `Map` has no `toJSON`, so a raw stringify
silently erases them.

`resolveDim` is the same resolution the rollup writer and `emit()`'s burst cap
use. It is exported so a host keying its own derived state keys it *identically*
— a second implementation of `attr:` / `field:` lookup is a second set of
bucket names.

---

## Registry types

```ts
type Registry = Record<string, EventSpec>;

/** A dimension source: `subject` fans out over subject refs; the others read one value. */
type DimSource = 'subject' | `attr:${string}` | `field:${string}`;
```

### `EventSpec`

| Field | Type | |
|---|---|---|
| `kind` | `TelemetryKind` | **Required.** Picks the discriminator and the retention default. |
| `origin` | `Origin \| 'any'` | **Required.** `'server'` names cannot be written over a `pk_` key. `'client'` requires `client` context on every record. |
| `subjects` | `readonly string[]` | **Required.** Subject *types* that must be present on every record. |
| `attrs` | `z.ZodObject` | Values are **strings** after Mongoose casting — use `z.string()` / `z.enum()` / `z.coerce.*`. |
| `metrics` | `z.ZodObject` | Numeric values. |
| `data` | `z.ZodType` | **`data` is unstored unless declared here.** That is what closes the erasure hole. |
| `indexedAttrs` | `readonly string[]` | Gets a real partial compound index at boot. |
| `indexedMetrics` | `readonly string[]` | Same machinery, numeric range queries. |
| `rollups` | `readonly RollupSpec[]` | Derived aggregates maintained on write. |
| `retentionDays` | `number \| null` | Overrides `RETENTION_DAYS[kind]`. `null` = immortal. |
| `sampleRate` | `number` | Overrides `SAMPLE_RATE[kind]`. Dormant — everything ships at 1. |
| `burst` | `{ key?: DimSource; maxPerMinute: number }` | Caps **raw** rows per resolved key per minute. Rollups still see every record, so counts stay exact while a retry loop cannot flood the collection. |
| `durable` | `boolean` | `await` the write with `{ w: 'majority', j: true }`, and its rollups, then rethrow on failure. `usage` is durable regardless. |
| `description` | `string` | **Required.** Surfaced in the dashboard's registry projection. |

### `RollupSpec`

| Field | Type | |
|---|---|---|
| `as` | `string` | Rollup family. Several event names may feed one. Default: the event name. |
| `by` | `readonly DimSource[]` | **Required.** Dimensions, in order. At most one `subject`. |
| `subjects` | `readonly string[]` | Required when `by` includes `subject` — which subject types to fan out over. |
| `actors` | `readonly string[]` | Actor **type** allowlist. `['user','system']` keeps admin support browsing out of customer aggregates. A record with no actor always passes. |
| `bucket` | `'hour' \| 'day' \| 'week' \| 'month'` | UTC time bucket. **Omit for a lifetime rollup** — the classic milestone, and the only shape funnels accept. |
| `sum` | `readonly string[]` | Metric keys accumulated with `$add`. |
| `capture` | `readonly DimSource[]` | Dimension sources snapshotted at **first** occurrence — cohort dimensions. Stored under `firstCapture`. |
| `dimDefault` | `string` | Bucket name for a non-subject dim that resolves null/empty. Absent = skip the record and count it in `rollupSkipped`. May not contain `\|` or `=`. **Never applies to the subject dim.** |
| `retentionDays` | `number \| null` | Rollup TTL. Omit or `null` = immortal. |

### Registry functions

```ts
/** Identity with a `const` type parameter — literal specs keep their shapes. */
function defineRegistry<const R extends Registry>(specs: R): R;

/** Boot-time contract checks — throws on misconfiguration. createTelemetry runs it. */
function validateRegistry(registry: Registry): void;

/**
 * The bounded `data` escape hatch: scalars, ≤12 keys, ≤200-char strings,
 * one nesting level, ≤4KB. Out of bounds drops the WHOLE object — never truncates.
 */
function boundedMeta(): z.ZodType<Record<string, unknown> | undefined>;
```

In full: a plain object of at most 12 keys, whose values are scalars
(`null`, finite numbers, booleans, strings ≤200 chars), arrays of at most 20
scalars, or one nested object of at most 12 scalar values — serializing to at
most 4096 characters. Anything outside those bounds, or circular, yields
`undefined` and increments `counters.rejected`.

`boundedMeta` drops rather than truncates because `data` is structured evidence,
and a partial object is a lie about what the caller sent. `body` does the
opposite — truncate and mark — because it is prose, where a marked prefix beats
nothing. The difference is the data, not the mood.

---

## Catalog types

The registry says what a host declared. The **catalog** says what a reader can
ask, and it is inferred from the registry alone — no configuration, no second
vocabulary. `createDashboard()` and `createTelemetryMcp()` each derive one at
construction and serve it from `/api/registry` and `describe_telemetry`.

```ts
function deriveCatalog(registry: Registry, opts?: DeriveCatalogOptions): Catalog;
function projectRegistry(catalog: Catalog): RegistryProjection;
```

Pure — no Mongo, no I/O — and boot-time for the same reason `validateRegistry`
is: if the catalog cannot be built, the registry is wrong, and a request is the
wrong place to discover that.

### `Catalog`

| Field | |
|---|---|
| `events` | `Record<string, EventFacet>` — one per registered name, in registry order |
| `families` | `Record<string, FamilyFacet>` — one per rollup `as` |
| `namespaces` | prefix before the first `.` → event names. An undotted name namespaces to itself. |
| `envelope` | `DimFacet[]` — the dims every record carries, whatever its source |
| `subjectTypes` | every subject type any spec or rollup names |

### `EventFacet`

`kind`, `origin`, `subjects`, `description` and `namespace` restate the spec.
The rest is derived:

| Field | |
|---|---|
| `dims` | one `DimFacet` per declared attr, then this kind's own discriminator fields — a usage event's dims include `field:usage.meter`, an event event's do not |
| `measures` | `count`, then `sum:` / `avg:` / `p50:` / `p95:` / `p99:` per metric key. A span adds the four raw operators on `durationMs`, which lives on the envelope and so no registry can declare it. |
| `families` | the rollup families this event feeds — each rollup's `as`, or the event's own name |
| `indexedAttrs`, `indexedMetrics` | as declared |
| `retentionDays` | the **effective** retention: the spec's override, else `RETENTION_DAYS[kind]`. `null` is immortal. |

### `FamilyFacet`

| Field | |
|---|---|
| `by` | the grain, in declared order. Pinned per family by `validateRegistry`, so the first feeder settles it. |
| `labels` | `label(src)` per dim — the `x=` prefix `recordRollup` writes into `dims`. A `subject` dim labels to `'subject'`. |
| `bucket` / `lifetime` | `lifetime` is `bucket === null`, and a lifetime family's `firstAt` **is** the milestone |
| `subjectTypes` | the spec's `subjects`, when `by` has a subject dim to restrict |
| `sums`, `capture` | union across feeders, in declaration order — neither is pinned, because a second name may accumulate another metric into the same docs |
| `feeders` | every event name declaring this family, registry order |

### `DimFacet`

| Field | |
|---|---|
| `key` | the `DimSource` form, so it passes straight through to a rollup `by`, a groupBy, or a filter term: `attr:model`, `field:client.platform`, `subjectType`, `actorType` |
| `label` | what `rollups.ts` writes before `=`. The two pseudo-dims label to themselves. |
| `type` | `string` / `enum` / `number` / `boolean` / `date`, walked off the declared zod schema through `optional`, `nullable`, `default`, `catch`, `readonly` and `pipe` (input side) |
| `values` | the closed domain when there is one: `z.enum`, `z.literal`, and the envelope's own enums |
| `optional` | true when the walk passed through `optional`, `nullable` or `default` |
| `indexed` | true only where a real index answers it — an `indexedAttrs` attr, or an envelope field a base index covers |

Anything the walker does not recognise is `string`. That is the honest answer
rather than a fallback: attrs are strings after Mongoose casting anyway.

### `MeasureFacet`

`key` is what a query takes (`count`, `sum:cost_usd`, `p95:durationMs`),
`metric` is the bare metric name, and **`exactVia`** lists the rollup families
whose `sum` carries it — the ones that answer without reading a raw row. Only
`sum:` keys ever have one; everything else is `[]`, meaning raw.

### `projectRegistry`

Narrows a catalog back to the `registry` key `/api/registry` and
`describe_telemetry` have always returned, so adding the catalog costs a
shipped client nothing. `RegistryProjectionEntry` is `kind`, `origin`,
`subjects`, `description`, `attrKeys`, `metricKeys`, `indexedAttrs`,
`indexedMetrics`, and `rollups[{ as, by, bucket, sum, subjects }]`.

---

## Envelope and kind types

One collection, five discriminators, one envelope. Every kind shares the same
identity, correlation, and payload fields; each adds one subdocument.

### The base envelope

| Group | Fields |
|---|---|
| identity | `_id` (UUIDv7 string), `schemaVersion`, `occurredAt`, `name`, `severity`, `kind` (the discriminator key) |
| tenancy | `tenantId` — the shard key, access boundary, and index prefix. The only promoted id. |
| parties | `subjects[]` (`{ type, id, role? }`), `subjectKeys[]` (derived `type:id`), `actor`, `onBehalfOf`, `otherPrincipals[]` (derived) |
| origin | `service`, `release`, `env`, `origin`, `client` |
| idempotency | `dedupeKey` |
| correlation | `traceId`, `spanId`, `parentId`, `durationMs` |
| payload | `attrs` (Map of string), `metrics` (Map of number), `data` (Mixed), `body` |
| ops | `sampleRate`, `forced`, `expiresAt`, `redactedAt`, `receivedAt` |

**Derived fields you never set.** `subjectKeys` is the deduplicated `type:id`
form of `subjects` — one multikey compound index answers "every record for this
subject, tenant-scoped, time-sorted". `otherPrincipals` holds `actor` and
`onBehalfOf` when they are *not* already subjects, which is what makes erasure
complete rather than best-effort.

**`service`, `release`, and `env` are required but never schema-defaulted.** A
schema default applies at construction, before the pre-validate hook — which
would silently stamp dev traffic as prod and pin `counters.defaulted` at zero
forever. Missing values are filled with `unknown` (or `NODE_ENV`-derived, for
`env`) *and counted*.

**Attr and metric keys have dots rewritten to underscores** on every write path,
because Mongoose Map keys cannot contain them.

### The five discriminators

| Kind | Adds | Extra requirements |
|---|---|---|
| `event` | nothing — the envelope suffices | |
| `error` | `error: { type, message, handled, fingerprint, frames[] }` | all of `type`, `message`, `fingerprint` |
| `span` | nothing structural | `traceId`, `spanId`, and a numeric `durationMs` |
| `state` | `state: { key, from?, to, previousSinceMs? }` | `state.to` |
| `usage` | `usage: { meter, quantity, unit, amount?, currency?, idempotencyKey, billedTo, billable, priceVersion?, reverses? }` | `meter`, `quantity`, `unit`, `idempotencyKey`, `billedTo` |

Per-kind requiredness is enforced in the pre-validate hook rather than by
discriminator schemas, so the guarantee never depends on how a particular
mongoose version merges requiredness.

`usage.amount` is `Decimal128` — **authoritative money**. `metrics.cost_usd` is a
BSON double: fine as a measure, wrong as the thing that becomes an invoice.
Corrections are new reversing rows (`reverses`); a billed row is never updated.
`usage.idempotencyKey` carries a unique partial index, which is what makes a
replayed webhook one row and one rollup.

### Model factory

`createTelemetry()` builds these for you and exposes them on `t.models`. The
factory reuses an already-compiled model when the name is taken, because
Mongoose's per-connection registry throws `OverwriteModelError` on a collision.

**The caveat that makes `modelName` matter:** a reused model closed over the
*first* instance's registry and counters. Two `createTelemetry()` calls sharing
one connection must pass distinct `modelName`s, or the second silently validates
against the first's registry.

`t.models.telemetry` queries across every kind; `t.models.byKind[kind]` is the
discriminator. Neither is tenant-scoped — that is what
[`scoped()`](/reference/factory#scopedtenantid) is for.

---

## Emit types

```ts
type AttrsOf<R extends Registry, N extends keyof R>   = /* z.infer of R[N].attrs, else {} */;
type MetricsOf<R extends Registry, N extends keyof R> = /* z.infer of R[N].metrics, else {} */;

type EmitInput<R extends Registry, N extends keyof R> = EmitBase & {
  attrs?: AttrsOf<R, N>;
  metrics?: MetricsOf<R, N>;
};

interface SubjectInput {
  type: string;
  id: string;
  /** disambiguates same-type parties: sender | recipient | impersonated */
  role?: string;
}
```

### `ClientContext`

```ts
interface ClientContext {
  platform: 'web' | 'electron' | 'ios' | 'android' | 'server' | 'cli' | (string & {});
  appVersion: string;
  userAgent?: string; os?: string; osVersion?: string;
  browser?: string; browserVersion?: string; deviceType?: string;
  locale?: string; timezone?: string;
  screenW?: number; screenH?: number; viewportW?: number; viewportH?: number;
  connection?: string; online?: boolean;
  /** client clock minus server clock, ms */
  clockSkewMs?: number;
}
```

`platform` and `appVersion` are required by the envelope. The union stays open —
builtins autocomplete, and `CreateTelemetryConfig.platforms` **extends** the
accepted enum rather than replacing it, so a host adding `'watchos'` keeps
`'web'`. Everything else in the envelope is open on purpose; a closed platform
enum was the one place a host had to lie.

`clockSkewMs` is computed server-side on the ingest path and always overwrites
the wire value.

### `EmitBase`

| Field | Type | |
|---|---|---|
| `tenantId` | `string` | **Required.** `'*'` is refused. |
| `subjects` | `SubjectInput[]` | Must cover every type in the spec's `subjects`. |
| `actor` / `onBehalfOf` | `EntityRef` | Who caused it; delegation/impersonation. |
| `occurredAt` | `Date` | Defaults to now. |
| `severity` | `LogLevel` | Defaults to `info`. |
| `service` / `release` / `env` / `origin` | | Defaulted and counted when missing. |
| `client` | `ClientContext` | Required for `origin: 'client'` specs. |
| `traceId` / `spanId` / `parentId` / `durationMs` | | Spans require all but `parentId`. |
| `data` | `Record<string, unknown>` | Dropped unless the spec declares a schema. |
| `body` | `string` | Clipped at `bodyMax`, marked, counted. |
| `forceKeep` | `boolean` | Keep despite sampling. Set automatically for money and errors. |
| `dedupeKey` | `string` | Caller idempotency for event/state/span/error. **Trusted server callers only** — non-empty, ≤200 chars. Implies `forceKeep`, and inverts the plane order: save first, roll up only if the insert won. |
| `durable` | `boolean` | `await` the row with `{ w: 'majority', j: true }` **and its rollups**, then rethrow on failure. Overrides `EventSpec.durable`. |
| `error` | `{ type, message, handled?, fingerprint, frames? }` | |
| `state` | `{ key, from?, to, previousSinceMs? }` | |
| `usage` | `{ meter, quantity, unit, amount?, currency?, idempotencyKey, billedTo, billable?, priceVersion?, reverses? }` | |

`dedupeKey` is deliberately **not** an `_id` passthrough. `_id` is a UUIDv7 and
doubles as insertion order, so letting a caller supply an arbitrary string would
break that invariant for every reader that sorts on it.

### `EmitResult` and `TelemetryCounters`

```ts
interface EmitResult {
  /** the record _id — usable for correlation even when the row was not stored */
  id: string;
  outcome: 'written' | 'queued' | 'deduped' | 'sampled' | 'capped' | 'rejected';
}
```

| Outcome | |
|---|---|
| `written` | the row is durably in Mongo, awaited — and on a `durable` emit (every `usage`) its rollups are awaited too, so both planes are readable without `flush()`. A `dedupeKey` write on a non-durable spec awaits only the row. |
| `queued` | validated and aggregated; the save is in flight, `t.flush()` awaits it |
| `deduped` | `dedupeKey` already present: nothing written, **nothing aggregated** |
| `sampled` | evidence plane declined; aggregates were still updated |
| `capped` | burst cap declined; aggregates were still updated |
| `rejected` | unregistered or failed validation; quarantined in the rejects collection |

```ts
interface TelemetryCounters {
  rejected: number; defaulted: number; sampled: number; capped: number;
  rollupSkipped: number;
  /** insert-gated writes whose dedupeKey / usage.idempotencyKey already existed */
  deduped: number;
  /** `body` values clipped to the cap — the row survives, marked */
  truncated: number;
  /** `${family}|${dimLabel}` → count — which family dropped which dim */
  rollupSkippedBy: Record<string, number>;
  /** `${name}|${attrKey}` → count — which undeclared attr key keeps arriving */
  undeclaredAttrs: Record<string, number>;
  /** write-time subject linking — all six stay at zero without a `subjectLinker` */
  subjectsLinked: number;        // subjects actually ADDED, counted per subject
  subjectLinkMisses: number;     // the host answered [] — no link exists
  subjectLinkErrors: number;     // threw, rejected, or answered with non-refs
  subjectLinkTimeouts: number;   // outran subjectLinkTimeoutMs; written unlinked
  subjectLinkUndeclared: number; // a linked type the event does not declare
  subjectLinkCapped: number;     // over SUBJECT_MAX (8) subjects on one record
}
```

The seven original scalars are the shape hosts scrape; the two maps are additive, and
they exist because a scalar says something went wrong without saying where.
`rollupSkippedBy` turns "12 records went missing" into a `dimDefault` you can go
and declare; `undeclaredAttrs` groups a wave of identical validation failures
into the one zod line that would end it.

Both are bounded at `COUNTER_MAP_MAX` (1000) distinct keys, after which new keys
fold into `COUNTER_OVERFLOW_KEY` (`'(other)|(other)'`). The keys are
client-controlled — an event name, an attr key — so an unbounded map would let a
hostile client grow the process heap. The totals stay honest; only the
attribution stops.

The six linking counters are split that finely for the same reason: every way
linking can fail ends in the *same row* — one written with the subjects it
arrived with — so without the split, a broken resolver and a host that simply
has no link to offer are the same silence.

## Suggestions

```ts
interface Suggestion {
  kind: 'undeclared_attr' | 'missing_dim_default' | 'unregistered_event';
  /** the registry entry to touch — an event name, or a rollup family name */
  target: string;
  /** attr key or dim label, when the suggestion is about one */
  key?: string;
  count: number;
  /** one sentence a human reads */
  message: string;
  /** the registry change, as code */
  fix: string;
}

declare function deriveSuggestions(input: {
  counters: TelemetryCounters;
  catalog: Catalog;
  quarantine?: readonly { name?: unknown; reason?: unknown }[];
}): Suggestion[];
```

The two maps above and the quarantine, read backwards: everywhere else the
registry tells the data what is allowed, and here the data tells the registry
what it is missing. `fix` is **code, not prose** — the zod line to add (or the
whole `attrs: z.object({ … })` block when the catalog shows the spec declares
none), the `dimDefault` line with a comment naming every spec that feeds the
family, or a minimal registry stub for an unregistered name.

Pure — no Mongo, no I/O — like `deriveCatalog` and `resolveReport`. Sorted by
count descending and capped at `MAX_SUGGESTIONS` (50). Served on
[`GET /api/system`](/reference/http-admin#system) and by the `telemetry_health`
MCP tool. Nothing is written: the host still edits the registry by hand.

---

## Factory types

```ts
interface CreateTelemetryConfig<R extends Registry = Registry> {
  registry: R;
  connection: Connection | Mongoose;
  collection?: string;            // 'telemetry'
  modelName?: string;             // 'Telemetry'
  pepper?: string;                // else TELEMETRY_PEPPER
  platforms?: readonly string[];  // EXTENDS the builtin platform list
  bodyMax?: number;               // else BODY_MAX_CHARS
  globalSubjectRefs?: boolean;    // a ref names the same party in EVERY tenant
  subjectLinker?: SubjectLinker;  // WRITE-time: who else is this record about?
  subjectLinkTimeoutMs?: number;  // else SUBJECT_LINK_TIMEOUT_MS (50)
  logger?: Logger;
}

/** WRITE-time — not `SubjectAdapter`, which labels refs at READ time */
interface SubjectLinker {
  link(
    subjects: SubjectInput[],
    ctx: { name: string; tenantId: string },
  ): SubjectInput[] | Promise<SubjectInput[]>;
}

/** the guarded linker the instance resolved: merged subjects, or null if unchanged */
type LinkSubjects = (
  name: string,
  spec: { subjects: readonly string[] },
  tenantId: string,
  declared: unknown,
) => Promise<SubjectInput[] | null>;

interface Telemetry<R extends Registry = Registry> {
  emit<N extends keyof R & string>(name: N, doc: EmitInput<R, N>): Promise<EmitResult>;
  forget(tenantId: string, ref: EntityRef): Promise<ForgetResult>;
  /** backfill for `subjectLinker` — DRY RUN by default */
  relink(opts?: RelinkOptions): Promise<RelinkResult>;
  scoped(tenantId: string): Scoped;
  checkpoint(key: string): Checkpoint;
  syncIndexes(): Promise<void>;
  flush(): Promise<void>;
  counters: TelemetryCounters;
  registry: R;
  /** null without a `subjectLinker`; exposed for the router factories */
  linkSubjects: LinkSubjects | null;
  logger: Logger;
  createKey(input: CreateKeyInput): Promise<{ key: string; id: string }>;
  models: {
    telemetry: Model<any>;
    byKind: Record<TelemetryKind, Model<any>>;
    rollups: Model<any>;
    checkpoints: Model<any>;
    keys: Model<any>;
  };
  collections: { rejects(): Collection; aliases(): Collection };
}

interface Scoped {
  find(q?: Record<string, unknown>): Query<any[], any>;
  aggregate(stages: Record<string, unknown>[]): Aggregate<any[]>;
  rollups(q?: Record<string, unknown>): Query<any[], any>;
  rollupAggregate(stages: Record<string, unknown>[]): Aggregate<any[]>;
}

interface Checkpoint {
  /** null on the first ever run */
  get(): Promise<Date | null>;
  advance(at: Date): Promise<void>;
}

interface ForgetResult {
  deleted: number; redacted: number; rollups: number; aliases: number; views: number;
}

interface RelinkOptions {
  names?: string[];               // default: every stored record. Unknown name throws.
  since?: Date;                   // occurredAt floor
  limit?: number;                 // records EXAMINED, not linked
  dryRun?: boolean;               // DEFAULTS TO TRUE
  batchSize?: number;             // default 500; also the onProgress cadence
  onProgress?: (r: RelinkResult) => void;
}

interface RelinkResult {
  examined: number; linked: number; subjects: number; rollups: number;
  misses: number;   // the linker answered [] — an answer, not a failure
  errors: number;   // threw / rejected / timed out / garbage, once per ROW
  skipped: number;  // name no longer in the registry; or 1 for "no subjectLinker"
}
```

See [`createTelemetry`](/reference/factory) for the behaviour of each.

`subjectLinker` is the only inbound adapter on the **write** side, and it is
deliberately not `subjectAdapter` under another name: that one labels refs on a
screen, this one changes what is stored. It is bounded by
`subjectLinkTimeoutMs`, guarded against throws, and can never fail a write. Full
semantics on [Adapters](/guide/adapters#subjectlinker).

Because it links at **write** time, it reaches nothing already on disk —
`relink()` is the backfill, and it is a dry run unless you say otherwise. See
[Adapters → linking is not retroactive](/guide/adapters#relink).

`t.linkSubjects` is that hook after the package has wrapped it — exposed the way
`registry` and `models` are, because the ingest router does not call `emit()`
and must reach the same implementation rather than growing a second copy of the
rules.

`globalSubjectRefs` is the host asserting something the package cannot verify:
that `user:u_1` is the same person in every tenant. Its only effect today is that
`forget()` also erases the person's platform-scoped saved views, which a
tenant-scoped call otherwise misses. Leave it off when ids are minted per tenant.

---

## Key and ingest types

`KeyKind` and `TenantMode` are `const` objects and types too, on the same terms
as the [vocabulary](#vocabulary).

```ts
declare const KeyKind: { Publishable: 'publishable'; Secret: 'secret' };
type KeyKind = 'publishable' | 'secret';

/** fixed: the key carries tenantId · session: the host resolves it · claimed: the payload asserts it (sk_ only) */
declare const TenantMode: { Fixed: 'fixed'; Session: 'session'; Claimed: 'claimed' };
type TenantMode = 'fixed' | 'session' | 'claimed';

interface ParsedKey { kind: KeyKind; label: string; id: string; secret?: string }

function parseKeyString(raw: string | undefined): ParsedKey | null;
/** versioned scrypt — a param change bumps the prefix, old hashes keep verifying */
function hashSecret(secret: string): string;
/** constant-time comparison */
function verifySecret(secret: string, stored: string | undefined): boolean;
```

```ts
interface CreateKeyInput {
  kind: KeyKind;
  tenantMode: TenantMode;
  tenantId?: string;        // required iff tenantMode === 'fixed'
  service: string;          // stamped on every record — the client cannot lie
  env: string;              // same
  label?: string;           // cosmetic, default 'live'
  origins?: string[];       // CORS allowlist. pk_ only; empty = no browser origins
  allowedKinds?: string[];  // pk_ → event/error/span; sk_ → all five
  allowedNames?: string[];  // optional narrowing to a subset of registry names
  maxPerMinute?: number;    // records/min across the key, default 600
}

/** Mint a key. The full string is returned ONCE — only the secret's hash is stored. */
function createKey(KeyModel: Model<any>, input: CreateKeyInput): Promise<{ key: string; id: string }>;
```

```ts
interface IngestContext {
  tenantId: string;
  subjects?: SubjectInput[];
  actor?: string;
}

interface ContextAdapter {
  /** INBOUND: who is making this request? Only consulted for tenantMode=session. */
  resolveContext(req: unknown): IngestContext | null | Promise<IngestContext | null>;
}

interface CreateIngestOptions {
  telemetry: Telemetry<any>;
  contextAdapter?: ContextAdapter;
  maxRecords?: number;   // 100
  bodyLimit?: string;    // '512kb'
  keyCacheMs?: number;   // 60_000
}

function createIngest(opts: CreateIngestOptions): express.Router;
```

---

## Query and view types

```ts
interface TimeRange { from: Date; to: Date }

interface RecordFilter {
  kind?: string; severity?: string;
  /** one event name, or a SET of them as an `$in` — a namespace or a family is several */
  name?: string | string[];
  env?: string; service?: string; release?: string;
  /** pin to one subject: 'user:u_1' */
  subject?: string;
  traceId?: string;
  attrs?: Record<string, string>;
  metrics?: Record<string, { gte?: number; lte?: number }>;
  /** the customer toggle: exclude these actor TYPES ('admin', 'system') */
  excludeActorTypes?: string[];
}

interface QueryLimits {
  // ── output caps: the most a response CONTAINS. The $limit sits after the
  // $group/sort or rides an indexed cursor, so the work behind it is bounded
  // by the range and the indexes, not by the number.
  records: number;   // 200
  series: number;    // 744 — a month of hourly buckets
  rollups: number;   // 500
  trace: number;     // 500
  journey: number;   // 500
  /** distinct GROUPS breakdown() returns — the top N by measure, never a scan bound */
  breakdown: number; // 50
  /** distinct VALUES one /values lookup returns — the top N by count, never a scan bound */
  values: number;    // 200

  // ── scan caps: the most a primitive READS, so an answer past one is an
  // undercount — which is why all three report `truncated`.
  /** raw docs distribution will scan before it reports an undercount */
  distribution: number; // 100_000
  /** rollup docs distinctCount will scan before it reports an undercount */
  distinct: number;  // 100_000
  /** subjects in one funnel cohort */
  funnel: number;    // 5_000
}
declare const DEFAULT_LIMITS: QueryLimits;
```

### `Queries`

Nine read primitives. Everything the UI renders comes through these — kind pages
never touch Mongo, which is the seam that would let spans route to a columnar
store later without touching a component. Every response reports `dataSource`, so
a spliced number can always say which store answered.

```ts
interface Queries {
  records(scope, range, filter?, opts?: { limit?; cursor? }):
    Promise<{ items: any[]; nextCursor: string | null; dataSource: 'raw' }>;

  series(scope, range, filter, opts?: { measure?; interval? }):
    Promise<{ buckets: Array<{ at: Date; value: number }>; dataSource: 'raw' }>;

  /**
   * Top groups of a measure by 1–2 dims: `attr:<key>`, an allowlisted
   * `field:<path>`, `subjectType`, or `actorType`. Rows carry `at` only when an
   * `interval` is given, and a record missing the dim groups under `null`.
   *
   * `limit` caps the GROUPS returned, never the rows scanned — truncation keeps
   * the TOP groups by measure. 0 or 3+ dims, an unlisted path, or a bad interval
   * throw with `status: 400`.
   *
   * Two flags, two axes: `truncated` = groups dropped; `bucketsTruncated` = the
   * per-interval pass hit `limits.series` buckets per group, so a group shown is
   * missing periods. `sum:`/`avg:durationMs` read the envelope field.
   */
  breakdown(scope, range, filter, opts: { groupBy: string[]; measure?; interval?; limit? }):
    Promise<{ rows: Array<{ dims: (string | null)[]; at?: Date; value: number }>;
              groups: number; truncated: boolean; bucketsTruncated: boolean; dataSource: 'raw' }>;

  /** `truncated` is always present — the scan ceiling is `limits.distribution` */
  distribution(scope, range, filter, opts?: { measure? }):
    Promise<Record<string, unknown> & { n: number; truncated: boolean; dataSource: 'raw' }>;

  rollups(scope, params: {
    as: string;
    /** one value, or several as an `$in` — one read for N subjects instead of N reads */
    dims?: string | string[];
    subjectType?: string;
    /** the field `range` filters. Default: bucketAt when bucketed, lastAt otherwise. */
    on?: 'firstAt' | 'lastAt' | 'bucketAt';
    range?: TimeRange;
    sort?: 'count' | 'lastAt' | 'firstAt' | 'bucketAt';
    limit?: number;
  }): Promise<{ rows: any[]; bucketed: boolean; truncated: boolean; dataSource: 'rollups' }>;

  trace(scope, traceId): Promise<{ items: any[]; dataSource: 'raw' }>;

  journey(scope, subjectRef, range, opts?: { limit? }):
    Promise<{ records: any[]; milestones: any[]; dataSource: 'raw+rollups' }>;

  distinctCount(scope, params: { as; subjectType?; range; interval? }):
    Promise<{ buckets: Array<{ at: Date; value: number }>; distinct: number;
              interval: 'hour'|'day'|'week'|'month'; truncated: boolean; dataSource: 'rollups' }>;

  funnel(scope, params: FunnelParams): Promise<FunnelResult>;
}

function createQueries(ctx: {
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  registry: Registry;
  limits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  slowMs?: number;        // 500 — the threshold onSlowQuery fires above
  cacheTtlMs?: number;    // 600_000 — in-process result cache TTL
  cacheSize?: number;     // 60 — entries kept before the oldest is evicted
}): Queries;
```

The cache is per `createQueries()` call, in-process, and keyed on the primitive
plus its arguments. It covers the five aggregating primitives — `series`,
`breakdown`, `distribution`, `rollups`, `distinctCount`; `records`, `trace`,
`journey`, and `funnel` always read through. Ten minutes suits a dashboard someone is reading;
a page that polls wants it shorter, and a failed query is never cached as the
answer either way. `cacheSize` bounds what that costs.

`scope` is a `tenantId` **or** `PLATFORM_SCOPE`. One argument, two meanings, no
second entry point. Under `'*'` the tenant term is dropped and nothing else
changes: the time range is still mandatory, the caps still apply, and every row
still carries its own `tenantId`. `series` and `distribution` aggregate *across*
tenants under `'*'` — the platform-wide chart, by design.

`distinctCount` **throws** when the named family has no subject dim or no bucket.
That is a registry mistake, and a plausible wrong number is the failure mode this
package exists to prevent. The dashboard router turns the throw into a 400 with
the message verbatim.

### Reports

A Report is one shape — what a page renders, what a saved view stores, what a URL
hash carries, what `run_report` executes. `resolveReport()` turns one into a
`Plan`: the cheapest primitive that answers it **exactly**, a raw plan when
nothing can, and an `Unavailable` with a reason when nothing at all can. Pure —
no Mongo, deterministic given `now` — so it is unit-pinned like `deriveCatalog`
and `summarizeStages`.

```ts
type ReportSource =
  | { event: string }        // one registered name
  | { namespace: string }    // every event under `library.*`
  | { kind: TelemetryKind }
  | { family: string };      // read a rollup family directly

/** a shorthand from the UI's RANGES ('7d'), or an explicit half-open ISO pair */
type ReportRange = string | { from: string; to: string };

interface ReportFilter {
  /** a DimFacet.key: 'attr:model' | 'field:env' | 'subjectType' | 'field:name' … */
  dim: string;
  op: 'eq' | 'in' | 'gte' | 'lte';
  value: string | string[] | number;
}

interface Report {
  source: ReportSource;
  range: ReportRange;
  interval?: 'hour' | 'day' | 'week' | 'month';
  /** a MeasureFacet.key. Default 'count'; also 'distinct:<subjectType>' and 'funnel' */
  measure?: string;
  groupBy?: string[];              // DimFacet.key[], at most two
  filters?: ReportFilter[];
  excludeActorTypes?: string[];
  sort?: 'value' | 'label' | 'time';
  limit?: number;
  compare?: 'previous';            // same length, immediately before
  /** funnel-only — `measure: 'funnel'` */
  stages?: string[]; anchor?: string; exits?: string[]; subjectType?: string;
}

interface Plan {
  primitive: 'records' | 'series' | 'breakdown' | 'distribution'
    | 'rollups' | 'distinctCount' | 'funnel';
  /** positional args AFTER scope — the executor is literally `q[primitive](scope, ...args)` */
  args: unknown[];
  exactness: 'exact' | 'raw' | 'scan';
  /** the family that answers it, when one does */
  via?: string;
  /** human sentence — the UI badge and the MCP explanation */
  why: string;
  /** how to fold the rows a `rollups` plan returns; `labels[i]` is the `dims` prefix */
  shape?: {
    groupBy: string[]; labels: string[]; measure: string;
    interval?: 'hour' | 'day' | 'week' | 'month';
    filters?: { dim: string; label: string; op: ReportFilter['op']; value: ReportFilter['value'] }[];
  };
  /** present under `compare: 'previous'` — same primitive, range shifted back by its own length */
  previous?: { args: unknown[] };
}

interface Unavailable { unavailable: true; why: string }

function resolveReport(report: Report, catalog: Catalog, opts?: {
  now?: Date; limits?: Partial<QueryLimits>;
}): Plan | Unavailable;

/** lift a stored view's legacy query onto a Report. null when nothing names a source. */
function normalizeQuery(query: Report | LegacyQuery | null | undefined): Report | null;

/** '7d' → a half-open pair ending at `now`; an ISO pair validated. Throws `status: 400`. */
function rangeOf(range: ReportRange, now?: Date): TimeRange;
function intervalForRange(range: ReportRange, now?: Date): 'hour' | 'day' | 'week' | 'month';

/** a Report is a URL, and these are inverses. A malformed param throws `status: 400`. */
function parseReportQuery(query: Record<string, unknown>): Report;
function reportToQuery(report: Report): Record<string, string | string[]>;

interface ExecuteOptions {
  now?: Date;
  limits?: Partial<QueryLimits>;
  /** applied to a `records` plan's items before they leave */
  redact?: (items: any[]) => any[];
}

interface ReportResult {
  report: Report;
  plan: Plan;
  /** the primitive's own result — EXCEPT a `rollups` plan, which arrives folded */
  result: unknown;
  /** present under `compare: 'previous'` */
  previous?: unknown;
  dataSource: 'raw' | 'rollups' | 'raw+rollups';
}

/** what breakdown() returns, answered from the rollup store instead */
interface FoldedRollups {
  rows: Array<{ dims: (string | null)[]; at?: Date; value: number }>;
  groups: number;
  truncated: boolean;
  dataSource: 'rollups';
}

/** the fields the fold reads off a rollup doc */
interface RollupDoc {
  dims: string[];
  bucketAt?: Date | string | null;
  count?: number;
  sums?: Record<string, number> | Map<string, number> | null;
}

function executeReport(
  q: Queries, scope: string, report: Report, catalog: Catalog, opts?: ExecuteOptions,
): Promise<ReportResult>;

function foldRollups(rows: readonly RollupDoc[], shape: PlanShape, truncated?: boolean): FoldedRollups;
```

`Plan.args` is the whole contract between the resolver and the primitives:

```ts
const plan = resolveReport(report, catalog);
if ('primitive' in plan) await q[plan.primitive](scope, ...plan.args);
```

`Unavailable.why` always names the offending key or family and, where one
exists, the registry change that would make the question answerable — a greyed
option with a reason beats a query that 400s (reports §11.2).

`executeReport` is that line plus the read, and the only thing it translates is
a `rollups` plan: `foldRollups` turns the family's own docs into the row shape
`breakdown()` returns, so a renderer never learns which store answered. Both
halves — the fold and the URL encoding — are pure, and are unit-pinned without
Mongo. An `Unavailable` reaching `executeReport` throws with `status: 400` and
the `why` as its message; `resolveReport` itself still returns it, because a
refusal is an answer until someone asks for data.

### Values

The observed domain of one dimension (reports §5) — a lookup the report builder
makes before it names a value, not a tenth primitive. Served by
[`GET /api/values`](/reference/http-admin#get-api-values) and the
`dimension_values` MCP tool.

```ts
interface ValuesParams {
  /** a DimFacet.key — or the literal 'subject', to ask a family for its refs */
  dim: string;
  /** the Report's source events: decides the raw step, narrows the other two */
  names?: string[];
  /** required by the raw step only */
  range?: TimeRange;
  /** values cap, clamped to limits.values (default 200) */
  limit?: number;
}

interface ValuesResult {
  /** catalog order for a declared enum, else by count desc then value asc */
  values: string[];
  /** parallel to `values` when the source can count — absent for 'catalog' */
  counts?: number[];
  /** which of the four answered, cheapest first */
  source: 'catalog' | 'rollups' | 'raw' | 'none';
  /** the family read, when source === 'rollups' */
  via?: string;
  truncated: boolean;
  dataSource: 'catalog' | 'rollups' | 'raw' | 'none';
}

type Values = (scope: string, params: ValuesParams) => Promise<ValuesResult>;

function createValues(ctx: {
  catalog: Catalog;
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  limits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  slowMs?: number;
  cacheTtlMs?: number;
  cacheSize?: number;
}): Values;
```

`source: 'none'` is an ANSWER — the caller offers free-text equality with a
*scan* badge. It is also what a dimension that needs a range but was given none
resolves to, rather than a throw.

### Views

```ts
interface ViewSpec {
  name: string;
  icon?: string;
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview' | 'system' | 'explore';
  /** a Report, or the pre-Report shape every stored view still carries */
  query: Report | LegacyQuery;
}

/** @deprecated write a Report. Lifted by normalizeQuery(); `spec` is Mixed, so nothing migrates. */
interface LegacyQuery {
  range?: string;
  filters?: Record<string, unknown>;
  groupBy?: string;
  sort?: string;
}

interface ResolvedView extends ViewSpec {
  origin: 'derived' | 'configured' | 'saved';
  id?: string;
  ownerRef?: string;
  shared?: boolean;
}

/** derived views — generated from the registry, zero config */
function deriveViews(registry: Registry, catalog?: Catalog): ResolvedView[];
```

### Dashboard adapters

```ts
interface Viewer {
  /** a tenantId, or PLATFORM_SCOPE ('*') to read across every tenant */
  tenantId: string;
  /** 'admin' unlocks System writes (key revoke) — within this scope */
  role: string;
  /** owns saved views, e.g. 'user:u_1' */
  viewerRef?: string;
}

interface ViewerAdapter {
  /** INBOUND: who may look, and how widely? Construction fails without this. */
  resolveViewer(req: unknown): Viewer | null | Promise<Viewer | null>;
}

interface SubjectAdapter {
  /** pretty labels for subject refs; absent refs render raw */
  describe(refs: string[]): Promise<Record<string, { label: string; href?: string }>>;
}

interface CreateDashboardOptions {
  telemetry: Telemetry<any>;
  viewerAdapter: ViewerAdapter;
  subjectAdapter?: SubjectAdapter;
  views?: ViewSpec[];
  queryLimits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  /** all three forwarded to createQueries */
  slowMs?: number;
  cacheTtlMs?: number;
  cacheSize?: number;
  /** where the browser sees this router mounted — MUST match */
  mountPath?: string;
  apiBase?: string;
  title?: string;
  spaDir?: string;
}

function createDashboard(opts: CreateDashboardOptions): express.Router;
/** the bundled SPA directory — resolves dist/ui in builds and source runs */
function defaultSpaDir(): string;
```

Returning `'*'` from `resolveViewer` **is** the authorization decision, and it is
the host's. The package never infers platform admin from a role, a header, or a
config flag; it only makes the escape hatch expressible so that a host needing a
cross-tenant read says so here instead of reaching around `scoped()` with a raw
model.

---

## Cohort math

```ts
interface FunnelStageSpec {
  /** the lifetime rollup family whose doc marks this stage — `firstAt` IS the timestamp */
  as: string;
  key?: string;        // stable identifier in the response. Default: `as`
  label?: string;
  description?: string;
}

interface FunnelCohortWindow extends TimeRange {
  /** Include `to` itself. Default FALSE — the package is half-open everywhere. */
  endInclusive?: boolean;
}

interface FunnelParams {
  stages: readonly FunnelStageSpec[];
  /** the milestone that assigns cohort membership and anchors time-to-step. Default: stages[0].as */
  anchor?: string;
  cohort: FunnelCohortWindow;
  /** exit families — counted, never staged */
  exits?: readonly FunnelStageSpec[];
  subjectType?: string;
  /** also slice the cohort by anchor date. UTC, Monday-start weeks. */
  interval?: 'day' | 'week' | 'month';
  limit?: number;
}
```

```ts
interface FunnelStageResult {
  order: number; key: string; as: string; label: string; description?: string;
  /** subjects with this stage present. NOT monotonic — the funnel is literal, never backfilled. */
  subjects: number;
  /** 0–100, unrounded. null when stage 1's count is 0. */
  pctOfFirst: number | null;
  /** null on stage 1 and whenever the previous count is 0 — never 0, never Infinity. */
  pctOfPrevious: number | null;
  /** fractional days, unrounded. null on an empty sample. */
  medianDaysFromAnchor: number | null;
  medianDaysFromPrevious: number | null;
  /** reached the PREVIOUS stage and not this one. 0 on stage 1. */
  notReached: number;
  /** reached this stage and not the NEXT. null on the terminal stage. */
  stalledAt: number | null;
}

interface FunnelExitResult { key: string; as: string; label: string; subjects: number }

interface FunnelSlice {
  /** the truncated anchor date — a UTC bucket start, not a '2026-W31' label */
  at: Date;
  subjects: number;
  stages: FunnelStageResult[];
}

interface FunnelResult {
  cohortSubjects: number;
  /** |{ s : stage 1 present }| — the pctOfFirst denominator */
  first: number;
  stages: FunnelStageResult[];
  exits: FunnelExitResult[];
  /** present only when `interval` was asked for; ascending by `at` */
  slices: FunnelSlice[] | null;
  /** the cohort read hit its cap — every number is an UNDERCOUNT */
  truncated: boolean;
  cohort: { from: Date; to: Date; endInclusive: boolean; anchor: string };
  dataSource: 'rollups';
}

/** one subject's assembled milestone index — what summarizeStages reasons over */
interface CohortSubject {
  ref: string;
  anchorAt: Date | null;
  /** stage key → first occurrence */
  stages: Record<string, Date>;
  exits: Record<string, Date>;
}
```

Nullable rather than zero, everywhere: an empty sample has no median, a stage
with no predecessor has no conversion rate, and a terminal stage has nowhere to
stall. `0` would be a claim; `null` is the truth.

### Pure functions

```ts
/** Mean of the two middles on even counts. Empty set is null, never 0. No rounding. */
function median(values: readonly number[]): number | null;

/** the stage table, pure — same input, same output, no Mongo */
function summarizeStages(
  subjects: readonly CohortSubject[],
  stages: readonly { order: number; key: string; as: string; label: string; description?: string }[],
): FunnelStageResult[];

/** the first declaration of a rollup family — validateRegistry pins the shape, so it speaks for all */
function findFamily(registry: Registry, as: string): { name: string; spec: RollupSpec } | null;

/** throws unless `as` is a LIFETIME family keyed by exactly one subject dim */
function requireMilestoneFamily(registry: Registry, as: string, primitive: string): RollupSpec;
```

The math lives outside the query layer so it can be unit-pinned without a
database.

---

## Client types

From `@jeffjassky/telemetry/core`, re-exported by every platform subpath. See
[Client SDKs](/reference/client).

```ts
interface CreateClientOptions {
  key: string;                       // pk_ for anything shipped to users
  url: string;                       // the mounted ingest endpoint
  release?: string;
  flushIntervalMs?: number;          // 5000
  maxBatchSize?: number;             // 50
  maxQueueSize?: number;             // 1000 — ring buffer, drop-OLDEST beyond it
  maxRetries?: number;               // 5
  transport?: Transport;
  storage?: ClientStorage;
  clientContext?: ClientContextInput;
  /** false = drop instead of send. Web adapter wires DNT/GPC here. */
  consent?: () => boolean;
  errorName?: string;                // 'error.unhandled'
  /** last gate before the queue — return the record, a redacted copy, or null
   *  to drop it. A throwing hook drops the record and reports via onError. */
  beforeSend?: (rec: WireRecord) => WireRecord | null | undefined | void;
  onError?: (e: unknown) => void;
}

type Transport = (url: string, body: string, headers: Record<string, string>)
  => Promise<TransportResult>;
interface TransportResult { ok: boolean; status?: number }

interface ClientStorage {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

interface ClientContextInput { /* every ClientContext field except clockSkewMs, all optional */ }

interface TrackOptions<A, M> {
  attrs?: A; metrics?: M;
  data?: Record<string, unknown>;
  occurredAt?: Date;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  severity?: string;
}

interface Span {
  readonly traceId: string;
  readonly spanId: string;
  end(extra?: { attrs?: Record<string, string>; metrics?: Record<string, number> }): void;
}

interface TelemetryClient<R extends Registry = Registry> {
  track<N extends keyof R & string>(name: N, opts?: TrackOptions<AttrsOf<R, N>, MetricsOf<R, N>>): void;
  captureError(err: unknown, ctx?: { handled?: boolean; name?: string; attrs?: Record<string, string> }): void;
  startSpan(name: string, opts?: { attrs?: Record<string, string> }): Span;
  state(name: string, st: { key: string; from?: string; to: string; previousSinceMs?: number }): void;
  /** swap subjects and post the $identify alias record (anon → user) */
  identify(ids: Record<string, string | null | undefined>): void;
  setActor(ref: string | undefined): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /** INTERNAL — the platform adapters' handle on the one real queue. Opaque. Do not use. */
  readonly _internal: unknown;
}

function createClient<R extends Registry = Registry>(options: CreateClientOptions): TelemetryClient<R>;
```

`_internal` is declared because it is **there** — `/web`, `/electron`, and
`/cli` all reach through it to drain and refill the single queue, and a
declaration that omitted it was simply false about the object the package ships.
It is typed `unknown` rather than shaped, so its members stay out of the
contract: reading one is a deliberate cast, never an accident, and its shape may
change in any release.

### `WireRecord`

The on-the-wire shape a client enqueues. Not the stored envelope — the server
derives, defaults, and overrides most of it.

```ts
interface WireRecord {
  _id: string;              // REQUIRED, 16–64 chars
  name: string;             // REQUIRED
  occurredAt: string;       // ISO
  attrs?: Record<string, string>;
  metrics?: Record<string, number>;
  data?: Record<string, unknown>;
  body?: string;
  severity?: string;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  actor?: string;
  traceId?: string; spanId?: string; parentId?: string; durationMs?: number;
  error?: unknown; state?: unknown; usage?: unknown;
  /** $identify only */
  anonRef?: string; userRef?: string;
}
```

### Platform entries

```ts
// /web
interface WebTelemetryOptions extends Omit<CreateClientOptions, 'storage' | 'consent'> {
  /** host consent (cookie banner etc). ANDed with DNT/GPC — those always win. */
  consent?: () => boolean;
  captureGlobalErrors?: boolean;    // true
  /** drop error records by message; ADDED to BENIGN_BROWSER_ERRORS */
  ignoreErrors?: Array<string | RegExp>;
  captureBenignErrors?: boolean;    // false — true keeps the benign list
}
const BENIGN_BROWSER_ERRORS: readonly RegExp[];
function createWebTelemetry<R>(opts: WebTelemetryOptions): TelemetryClient<R>;

// /react
function TelemetryProvider(props: { client: TelemetryClient; children?: React.ReactNode }): React.ReactElement;
/** throws when no <TelemetryProvider> is above the calling component */
function useTelemetry(): TelemetryClient;
class TelemetryErrorBoundary extends React.Component<{
  client?: TelemetryClient;
  fallback?: React.ReactNode | ((error: Error) => React.ReactNode);
  children?: React.ReactNode;
}> {}

// /vue
declare const TELEMETRY_KEY: 'telemetry';
function createTelemetryPlugin(client: TelemetryClient): { install(app): void };
/** composition-API accessor — pass Vue's inject: useTelemetry(inject) */
function useTelemetry(inject: (key: string) => unknown): TelemetryClient;

// /electron
declare const IPC_CHANNEL: 'telemetry:batch';
interface MainTelemetryOptions extends CreateClientOptions {
  captureProcessErrors?: boolean;   // true
  ipcMain?: { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void };
}
function createMainTelemetry(opts: MainTelemetryOptions): TelemetryClient;
function createRendererTelemetry(
  ipcRenderer: { invoke(channel: string, ...args: any[]): Promise<any> },
  opts?: Omit<CreateClientOptions, 'key' | 'url' | 'transport'>,
): TelemetryClient;

// /cli
interface CliTelemetryOptions extends Omit<CreateClientOptions, 'storage'> {
  /** where the anon id and offline queue live, e.g. ~/.config/mytool */
  configDir: string;
  argv?: string[];              // default process.argv, scanned for --no-telemetry
  maxQueueAgeMs?: number;       // 7 days
}
function createCliTelemetry(opts: CliTelemetryOptions): TelemetryClient;
```

`/core`, `/web`, `/react`, `/vue`, `/electron`, and `/cli` each re-export
`createClient` and `TelemetryClient`; `/core` additionally re-exports
`defineRegistry`, `boundedMeta`, and the registry types, so a host's registry
module is importable from a browser bundle as `import type` with no zod in sight.
