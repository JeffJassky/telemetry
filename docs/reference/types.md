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
}
```

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
  logger?: Logger;
}

interface Telemetry<R extends Registry = Registry> {
  emit<N extends keyof R & string>(name: N, doc: EmitInput<R, N>): Promise<EmitResult>;
  forget(tenantId: string, ref: EntityRef): Promise<ForgetResult>;
  scoped(tenantId: string): Scoped;
  checkpoint(key: string): Checkpoint;
  syncIndexes(): Promise<void>;
  flush(): Promise<void>;
  counters: TelemetryCounters;
  registry: R;
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
```

See [`createTelemetry`](/reference/factory) for the behaviour of each.

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
  kind?: string; name?: string; severity?: string;
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
  records: number;   // 200
  series: number;    // 744 — a month of hourly buckets
  rollups: number;   // 500
  trace: number;     // 500
  journey: number;   // 500
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

Eight read primitives. Everything the UI renders comes through these — kind pages
never touch Mongo, which is the seam that would let spans route to a columnar
store later without touching a component. Every response reports `dataSource`, so
a spliced number can always say which store answered.

```ts
interface Queries {
  records(scope, range, filter?, opts?: { limit?; cursor? }):
    Promise<{ items: any[]; nextCursor: string | null; dataSource: 'raw' }>;

  series(scope, range, filter, opts?: { measure?; interval? }):
    Promise<{ buckets: Array<{ at: Date; value: number }>; dataSource: 'raw' }>;

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
plus its arguments. It covers the four aggregating primitives — `series`,
`distribution`, `rollups`, `distinctCount`; `records`, `trace`, `journey`, and
`funnel` always read through. Ten minutes suits a dashboard someone is reading;
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

### Views

```ts
interface ViewSpec {
  name: string;
  icon?: string;
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview' | 'system';
  query: {
    range?: string;
    filters?: Record<string, unknown>;
    groupBy?: string;
    sort?: string;
    display?: 'table' | 'series' | 'breakdown' | 'stream';
  };
}

interface ResolvedView extends ViewSpec {
  origin: 'derived' | 'configured' | 'saved';
  id?: string;
  ownerRef?: string;
  shared?: boolean;
}

/** derived views — generated from the registry, zero config */
function deriveViews(registry: Registry): ResolvedView[];
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
