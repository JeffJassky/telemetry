# Unified Telemetry Schema

One envelope for product events, errors, traces, state transitions, and billable
usage. Discriminated Typegoose schemas over a single MongoDB collection.

**Schema version 2.** Normative for storage and validation. The ingest surface,
keys, identity context, SDKs, and packaging are normative in
[instrumentation.md](./instrumentation.md).

> **Fixes applied to the v2 draft** (behavioral, no stored-shape change):
> schema `default:` removed from `env`/`service`/`release` (§4.3, §7) · `...doc`
> spread reordered in `emit()` (§4.6) · `firstCapture` corrects on late
> arrival (§4.5) · `traceKeep` asserts a parseable trace id in dev (§4.1) ·
> `forget()` rekeys rollups instead of deleting them (§4.7) · index sync drops
> orphans before the budget check (§4.4).
>
> **Rollup generalization (v2.1, stored-shape change in the derived collection
> only):** the per-subject milestone became one derived-aggregate primitive —
> `telemetry_milestones` → `telemetry_rollups`, keyed on a registry-declared
> dimension tuple (§4.5). Milestones are now the `by: ['subject']` special case;
> the same primitive serves issue grouping, windowed spend, and activity/retention.
> `EventSpec` gains `rollups`, `retentionDays`, `sampleRate` overrides; `UsageDetail`
> gains authoritative `amount`/`currency` (Decimal128). The envelope is unchanged.
>
> **Scale calibration (v2.2, behavioral):** sized for small SaaS — thousands of
> users, not billions of events. Span sampling defaults to keep-all (machinery
> stays, dormant — §2.6, §4.6); span retention 30d → 90d; rollups are recorded
> BEFORE the sampling verdict and before the burst cap, so aggregates are exact
> at any rate (§4.6); `EventSpec.burst` rate-caps raw storage per group — storms
> are the one volume risk user count does not bound (§4.2, §4.6); `bucket: 'hour'`
> (§4.5); `indexedMetrics` mirrors `indexedAttrs` for numeric range queries (§4.4);
> `session` is a first-class subject convention (§2.3). The envelope is unchanged.
>
> **Instrumentation split (v2.3):** ingest, keys, aliases, SDKs, and packaging
> moved to instrumentation.md. Two consequences land here: at-least-once
> transports use insert-gated rollups (§4.6), and `forget()` deletes alias rows
> (§4.7). Two collections join the family: `telemetry_keys`, `telemetry_aliases`
> (defined in instrumentation.md §2, §5). The envelope is unchanged.

---

## 1. Why one schema

Product analytics (Mixpanel/PostHog), error tracking (Sentry), and usage metering
(Orb/Metronome/Stripe) sell three different UIs over substantially the same record:

> **something happened, at a time, caused by someone, about someone, with properties and numbers attached.**

Errors add a stack trace. Spans add a duration and a parent. State transitions add
a from/to. Usage adds an idempotency key and a billing target. The envelope is
shared; the extensions are sparse.

OpenTelemetry already converged here — logs, spans, and metrics share one
resource + attributes model, and `gen_ai.*` semconv covers LLM tokens and cost.
This schema is OTel-shaped on purpose so SDKs, collectors, and vendor exporters
stay usable.

**Scope claim, stated precisely:** this covers the *ingest and storage* model of
those three categories, plus enough derived state (§5) to answer funnels,
retention, and rollup questions. It does not reproduce their analysis UIs, and
ad-hoc multi-step funnels over raw events remain a ClickHouse job (§9). Per-use-case
coverage is scored honestly in §10.

### Design principles

1. **One envelope, sparse typed extensions.** Not a flat table of 200 nullable columns.
2. **Promote what the storage engine or the law requires** — not what feels important.
3. **The registry is the contract.** Event names, required subjects, attr/metric
   schemas, rollup opt-in, and indexes all derive from one file.
4. **Storage is a routing decision, not a schema decision.** `emit()` dispatches per
   kind, so kinds can move stores without re-instrumentation.
5. **Never drop data silently.** Validation failures go to quarantine with a counter.
6. **Sampling decisions belong to the trace, not the record.**

---

## 2. Core concepts

### 2.1 Kinds

| kind | shape | volume | sampled | retention |
|---|---|---|---|---|
| `event` | point in time | medium | no | 730d |
| `error` | point in time + stack | low | no — but raw storage burst-capped per fingerprint | 90d |
| `span` | **interval** + parent | highest here | default **no** (keep-all at this scale); per-trace machinery dormant, §2.6 | 90d |
| `state` | point in time + from/to | low | no | 730d |
| `usage` | point in time + money | low | **never** | forever |

Retention and sampling are per-kind *defaults*; any registry entry can override
both (`EventSpec.retentionDays` / `sampleRate`, §4.2). Rollups are recorded
before sampling and before the burst cap, so derived aggregates are exact
regardless of either (§4.6).

### 2.2 What a span is

Literally a span *of time* — start, end, duration — plus a parent, so spans nest
into a tree. Term comes from Google's Dapper paper by way of OpenTelemetry.

```
traceId: tr_01912f3a4b5c                          ← one user request
├─ span s_1  POST /reports/export        2841ms   ← root, parentId: null
│  ├─ span s_2  db.query users             12ms   ← parentId: s_1
│  ├─ span s_3  llm.completion           1900ms   ← parentId: s_1
│  │  └─ span s_4  http POST anthropic   1880ms   ← parentId: s_3
│  ├─ span s_5  pdf.render                890ms
│  └─ event  report.exported                      ← point in time, no duration
└─ error  TypeError                               ← point in time
```

Rendered on a time axis that's the waterfall every APM tool shows. The nesting
tells you `pdf.render` is 31% of the request; the `parentId` chain tells you the
slow part is inside the model call, not your code.

A span is the only kind that is meaningless alone — it exists in relation to its
parent and siblings.

**Why you want them:** rolling up `metrics.cost_usd` across one `traceId` answers
"what did this feature cost," which neither the error nor the usage row can.

> **That rollup is only valid because sampling is head-based (§2.6).** Per-record
> sampling would give you a fraction of the spans in nearly every trace, making
> every per-trace sum wrong in an unknowable direction.

If you're not doing distributed tracing yet, defer `kind=span` entirely — but put
`traceId` on everything from day one. Retrofitting correlation is the expensive part.

### 2.3 Identity: subject vs actor vs billed-to

Three concepts that are easy to fuse and shouldn't be:

- **subject** — who/what the record is *about*. A **list**, because one record can
  concern several parties in different roles: `user`, `org`, `team`, `project`,
  `workspace`, `device`, `session`. Two users on one row is normal (sender +
  recipient, admin + impersonated).

  > **Convention: client-origin records carry a `session` subject from day one.**
  > It costs one array entry, and it is what makes "did both steps happen in the
  > same visit" a `subjectKeys` equality instead of a time-window guess. Same for
  > `anon` before login — the stitching job (§9) can only rewrite refs that exist.
- **actor** — who *caused* it. Often a subject, also `system:nightly-sync`,
  `service:billing-worker`, or an admin who is not a subject at all.
- **billed-to** — who *pays*. Usually the org, not the user. Only on `kind=usage`.

All three carry erasable identifiers, so all three are in scope for `forget()` (§4.7).

### 2.4 Why identity is not just another attr

| | subjects (identity) | attrs |
|---|---|---|
| role | grouping / join key, scope | filter, description |
| cardinality | **high** — unbounded ids | **low** — bounded enums |
| type | any | **string only** (§7) |
| index shape | compound, leading position | targeted partial, registry-declared |
| mutable? | yes — identity stitching rewrites anon→known | no, immutable |
| lifecycle ops | delete-by-subject, tenant isolation, access control | none |
| downstream | maps to vendor identity slots | maps to properties / tags |

The two that actually force the split:

**Erasure.** "Delete everything about user u_1" needs a guaranteed, indexed,
exhaustive list of every place that id can appear. If it can hide in `attrs` or
`data`, the query is unanswerable. Identity is therefore a closed set, `data` is
registry-declared-or-unstored, and `actor`/`onBehalfOf` are mirrored into a
searchable array (§2.5).

**Tenant isolation.** Every read must be scoped. If tenant lives in a free-form
map, one forgotten filter is a cross-tenant leak. Promoting it makes it wrappable
in a helper that can't be bypassed.

### 2.5 Derived identity arrays

Two arrays are derived on write. Neither is authored by hand.

- `subjectKeys: ['user:u_1', 'org:o_9']` — flattened `type:id`, the analytics index.
  One array field, so `{tenantId, subjectKeys, occurredAt}` is a legal multikey
  compound index that serves every subject type without per-type indexes.
- `otherPrincipals: ['user:u_admin']` — `actor` and `onBehalfOf` **only when not
  already a subject**. Usually empty, so the second index costs almost nothing on
  insert, but it makes erasure complete.

> Never compound-index `{'subjects.type': 1, 'subjects.id': 1}` over the subdoc
> array — Mongo matches across elements, so `user:u_1` would match a row where that
> id belongs to a different type. The flattened string sidesteps it entirely.

> **Verified with `explain()` 2026-08-10** (mongod 8.2.6): equality on tenant +
> multikey subject serves the `occurredAt` sort with no blocking SORT stage —
> desc, asc reverse-scan, with a time range, and under `$all` — at 1:1
> keys-to-docs examined, and multikey dedup returns each row exactly once.
> The one-index claim stands; see §9.

### 2.6 Sampling belongs to the trace

> **Dormant by default.** Every rate ships at 1 (keep-all) — at small-SaaS scale,
> exactness beats extrapolation (§4.6). This section is the manual for the day a
> rate drops below 1; the invariants here are why that day is a config change and
> not a redesign. Rollups are unaffected either way — they run before the verdict.

Independent per-record sampling at rate *r* keeps a complete *n*-span trace with
probability *rⁿ*. At 5% and five spans that is about 3 in 10 million — you get
scattered fragments of nearly every trace and complete trees of essentially none.

This schema uses **consistent probability sampling** (OTel `TraceIdRatioBased`):
the verdict is a deterministic function of `traceId`, so every service in the
request computes the same answer with no propagation header required.

```ts
export const traceKeep = (traceId: string | undefined, rate: number) => {
  if (rate >= 1) return true
  if (!traceId) return Math.random() < rate            // untraced: per-record fallback
  const tail = parseInt(traceId.slice(-8), 16)         // requires a random-tailed id
  return tail / 0xffffffff < rate
}
```

**Trace ids must be UUIDv7 or otherwise random in their low bits.** A sequential or
prefix-structured id makes this correlate with time and silently biases the sample.
An id with no parseable hex tail falls back to per-record sampling — the exact
failure this section exists to prevent — so §4.1 throws on it in dev.

**Force-keep** overrides the verdict for spans that carry money or an error, so the
`usage.idempotencyKey → span` join is never dangling. Those rows are stamped
`forced: true` and `sampleRate: 1`.

> Force-kept rows are **not** a representative sample. When a rate is below 1,
> extrapolated counts (§5.3) and any ratio must filter `forced: false`, or error
> rates will look ~20× smaller than they are. At keep-all the distinction is
> moot — but the flag is still stamped, so history stays interpretable if the
> rate ever changes.

### 2.7 What gets promoted to a real field

Exactly one id: `tenantId`. It is the shard key, the access-control boundary, and
the prefix of every index — it cannot be a map entry.

Everything else — user, team, project, workspace, device, session — lives in the
open `subjects` array. Adding a new subject type is a registry line, not a migration.

---

## 3. Envelope reference

```
_id             UUIDv7 string — sortable, insertion-local, replaces ObjectId
kind            event | error | span | state | usage   ← Mongoose discriminator key
name            "report.exported"                       ← must exist in REGISTRY
schemaVersion   int
occurredAt      when it happened (client clock)
receivedAt      when we got it (server clock)           ← the gap matters for backfill
severity        debug | info | warn | error | fatal

tenantId        required. shard key, access boundary, index prefix
subjects        [{ type, id, role? }]                   ← list: multi-party capable
subjectKeys     derived ['user:u_1','org:o_9']
actor           'user:u_1' | 'system:cron' | 'service:api'
onBehalfOf      impersonation / delegation
otherPrincipals derived — actor/onBehalfOf not already a subject

service         filled by hook, 'unknown' when absent   ← no schema default, see §7
release         filled by hook, 'unknown' when absent   ← source maps, regressions
env             prod | staging | dev                    ← filled by hook
origin          server | client
client          ClientContext — required for client-origin events

traceId         correlation across every kind. MUST have a random hex tail (§2.6)
spanId
parentId
durationMs

attrs           Map<string,string>  STRING VALUES ONLY. registry-validated, indexed on demand
metrics         Map<string,number>  aggregatable across all kinds
data            registry-declared object, or NOT STORED
body            free text

sampleRate      1 = kept all. 0.05 = multiply counts by 20
forced          true = kept despite sampling; exclude from ratios
expiresAt       per-kind TTL; absent = immortal
redactedAt      set by forget()

error?          { type, message, handled, fingerprint, frames[] }
state?          { key, from?, to, previousSinceMs? }
usage?          { meter, quantity, unit, idempotencyKey, billedTo, billable, priceVersion, reverses }
```

### Same envelope, five records

```jsonc
// product event — two parties, distinct roles
{ kind:"event", name:"report.shared", tenantId:"acc_9", traceId:"tr_01912f3a4b5c",
  subjects:[{type:"user",id:"u_123",role:"sender"},
            {type:"user",id:"u_456",role:"recipient"},
            {type:"org", id:"o_9"}],
  actor:"user:u_123",
  attrs:{ format:"pdf", route:"/reports" }, metrics:{ rows:4021 } }

// llm call
{ kind:"span", name:"llm.completion", tenantId:"acc_9",
  subjects:[{type:"org",id:"o_9"}],
  traceId:"tr_01912f3a4b5c", spanId:"s_3", parentId:"s_1", durationMs:1900,
  forced:true, sampleRate:1,
  attrs:{ gen_ai_system:"anthropic", gen_ai_request_model:"claude-opus-5" },
  metrics:{ tokens_in:1200, tokens_out:800, cost_usd:0.042 } }

// error
{ kind:"error", name:"error.unhandled", severity:"error", tenantId:"acc_9",
  subjects:[{type:"user",id:"u_123"},{type:"org",id:"o_9"}],
  traceId:"tr_01912f3a4b5c", release:"app@1.4.2", attrs:{ route:"/reports" },
  error:{ type:"TypeError", message:"x is not a function", handled:false,
          fingerprint:"abc123", frames:[] } }

// state transition — answers "where do accounts stall"
{ kind:"state", name:"account.lifecycle", tenantId:"acc_9",
  subjects:[{type:"org",id:"o_9"}], actor:"system:billing-worker",
  state:{ key:"lifecycle", from:"trial", to:"active", previousSinceMs: 1209600000 } }

// billable usage
{ kind:"usage", name:"billing.ai_tokens", tenantId:"acc_9",
  subjects:[{type:"org",id:"o_9"}], traceId:"tr_01912f3a4b5c", metrics:{ cost_usd:0.042 },
  usage:{ meter:"ai_tokens", quantity:2000, unit:"token",
          idempotencyKey:"tr_01912f3a4b5c:s_3", billedTo:"org:o_9", billable:true,
          priceVersion:"v3" } }
```

Five vendors' worth of data, one shape, joinable on `traceId` and `subjectKeys`.

---

## 4. Implementation

### 4.1 `telemetry.types.ts`

```ts
import { uuidv7 } from 'uuidv7'   // npm i uuidv7   (or `import { v7 } from 'uuid'`)

// NOTE: Node's crypto.randomUUID() is v4 — random, NOT sortable. Do not use it here.
// Trace ids must also be random-tailed; §2.6 samples on their low 32 bits.
export const newId = uuidv7

export enum TelemetryKind {
  Event = 'event', Error = 'error', Span = 'span', State = 'state', Usage = 'usage',
}
export enum LogLevel { Debug = 'debug', Info = 'info', Warn = 'warn', Error = 'error', Fatal = 'fatal' }
export enum Env { Prod = 'prod', Staging = 'staging', Dev = 'dev' }
export enum Origin { Server = 'server', Client = 'client' }
export enum Platform { Web = 'web', Electron = 'electron', Ios = 'ios', Android = 'android', Server = 'server' }

export type EntityRef = `${string}:${string}`

export const UNKNOWN = 'unknown'

/** null = never expires. Sized for small-SaaS volume; per-name override in EventSpec. */
export const RETENTION_DAYS: Record<TelemetryKind, number | null> = {
  [TelemetryKind.Span]: 90,     // keep-all + 90d is cheap at this scale, and it makes
                                // p95-by-route a raw query instead of a rollup design
  [TelemetryKind.Error]: 90,
  [TelemetryKind.Event]: 730,
  [TelemetryKind.State]: 730,
  [TelemetryKind.Usage]: null,
}

export const REJECT_TTL_DAYS = 30
export const SCHEMA_VERSION = 2

/**
 * Consistent probability sampling — deterministic per trace, no propagation needed.
 *
 * A traceId with no parseable hex tail silently degrades to per-record sampling,
 * which invalidates every per-trace aggregate (§2.6). That is a bug in the caller's
 * id generation, so it fails loudly in dev rather than skewing data in prod.
 */
export const traceKeep = (traceId: string | undefined, rate: number) => {
  if (rate >= 1) return true
  if (!traceId) return Math.random() < rate
  const tail = parseInt(traceId.slice(-8), 16)
  if (!Number.isFinite(tail)) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        `telemetry: traceId "${traceId}" has no parseable hex tail — trace-consistent ` +
        `sampling is impossible and would degrade to per-record. Use UUIDv7 or a ` +
        `32-hex OTel trace id.`,
      )
    }
    return Math.random() < rate
  }
  return tail / 0xffffffff < rate
}

/** Map has no toJSON — JSON.stringify(new Map()) is '{}'. Never stringify raw. */
export const plain = (v: any): any =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
  : Array.isArray(v) ? v.map(plain)
  : v instanceof Date ? v
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v
```

### 4.2 `telemetry.registry.ts`

The load-bearing file. Drives validation, TypeScript types, derived rollups,
**and index creation**.

```ts
import { z } from 'zod'
import { TelemetryKind, Origin } from './telemetry.types'

/**
 * A dimension source. `subject` fans the rollup out over matching subject refs;
 * `attr:`/`field:` read one value off the record.
 */
export type DimSource = 'subject' | `attr:${string}` | `field:${string}`

/**
 * Derived aggregate maintained on write (§4.5). One primitive, four jobs:
 * milestones, issue grouping, windowed spend, activity/retention.
 */
export interface RollupSpec {
  /** rollup family — several event names may feed one. Default: the event name */
  as?: string
  /** dimensions, in order. At most one `subject`. */
  by: readonly DimSource[]
  /** when `by` includes `subject`, restrict to these subject types */
  subjects?: readonly string[]
  /** time bucket (UTC). Omit for a lifetime rollup — that is the classic milestone.
   *  `hour` is for incident-grade dashboards; anything finer is the wrong store. */
  bucket?: 'hour' | 'day' | 'week' | 'month'
  /** metric keys accumulated with $add */
  sum?: readonly string[]
  /** dimension sources snapshotted at FIRST occurrence — cohort dimensions */
  capture?: readonly DimSource[]
  /** rollup TTL. Omit or null = immortal (bucketed rollups usually want a number) */
  retentionDays?: number | null
}

export interface EventSpec {
  kind: TelemetryKind
  origin: Origin | 'any'
  /** subject TYPES that must be present (any number of ids per type) */
  subjects: readonly string[]
  /** attrs values are STRINGS after Mongoose casting — use z.string()/z.enum()/z.coerce.* */
  attrs?: z.ZodObject<any>
  metrics?: z.ZodObject<any>
  /** `data` is UNSTORED unless declared here. Closes the erasure hole. */
  data?: z.ZodObject<any>
  /** attrs keys that get a real partial compound index built at boot */
  indexedAttrs?: readonly string[]
  /** metrics keys, same machinery — enables indexed numeric range queries (§4.4) */
  indexedMetrics?: readonly string[]
  /** derived aggregates maintained on write — funnels, issues, spend, retention (§4.5) */
  rollups?: readonly RollupSpec[]
  /** overrides RETENTION_DAYS[kind]. null = immortal */
  retentionDays?: number | null
  /** overrides SAMPLE_RATE[kind] */
  sampleRate?: number
  /**
   * Rate cap on RAW storage per resolved key, per minute. Rollups still see every
   * record (§4.6), so counts stay exact while an error storm or a client in a
   * retry loop cannot flood the collection. Omit `key` to cap the name as a whole.
   */
  burst?: { key?: DimSource; maxPerMinute: number }
  description: string
}

export const REGISTRY = {
  'user.signed_up': {
    kind: TelemetryKind.Event,
    origin: Origin.Client,
    subjects: ['user', 'org'],
    attrs: z.object({ source: z.string().max(64), plan: z.enum(['free', 'pro', 'enterprise']) }),
    indexedAttrs: ['source'],
    rollups: [
      // cohort anchor: firstAt becomes the signup week for every retention query
      { by: ['subject'], subjects: ['user'], capture: ['attr:source', 'attr:plan'] },
      // …and count as activity, so DAU/WAU/retention curves come off one family
      { as: 'activity', by: ['subject'], subjects: ['user'], bucket: 'day', retentionDays: 730 },
    ],
    description: 'Account created',
  },

  'report.shared': {
    kind: TelemetryKind.Event,
    origin: Origin.Client,
    subjects: ['user', 'org'],
    attrs: z.object({ format: z.enum(['pdf', 'csv', 'xlsx']), route: z.string().max(200) }),
    metrics: z.object({ rows: z.number().int().nonnegative() }),
    indexedAttrs: ['format'],
    rollups: [
      // separate families per subject class — see the §5.4 hazard note
      { by: ['subject'], subjects: ['user'] },
      { as: 'report.shared.org', by: ['subject'], subjects: ['org'] },
      { as: 'activity', by: ['subject'], subjects: ['user'], bucket: 'day', retentionDays: 730 },
    ],
    description: 'User shared a report with another user',
  },

  'llm.completion': {
    kind: TelemetryKind.Span,
    origin: Origin.Server,
    subjects: ['org'],
    attrs: z.object({
      gen_ai_system: z.string(),
      gen_ai_request_model: z.string(),
      gen_ai_response_finish_reason: z.string().optional(),
      /** which product surface spent the money — the dimension cost questions start from */
      feature: z.string().max(64),
    }),
    metrics: z.object({
      tokens_in: z.number().int(), tokens_out: z.number().int(), cost_usd: z.number(),
    }),
    /** numeric/nested request params (temperature, top_p, stop) belong here, not in attrs */
    data: z.object({
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      max_tokens: z.number().int().optional(),
    }).partial(),
    indexedAttrs: ['gen_ai_request_model', 'feature'],
    // "which calls cost more than a dollar" as an indexed range, not a scan
    indexedMetrics: ['cost_usd'],
    // spans default to 90d; spend evidence should outlive that (§4.5 note on rollups)
    retentionDays: 400,
    rollups: [{
      as: 'llm_cost',
      by: ['attr:gen_ai_request_model', 'attr:feature'],
      bucket: 'day',
      sum: ['cost_usd', 'tokens_in', 'tokens_out'],
      retentionDays: null,          // aggregate spend is immortal; the spans are not
    }],
    description: 'Single model call',
  },

  'error.unhandled': {
    kind: TelemetryKind.Error,
    origin: 'any',
    subjects: [],
    attrs: z.object({ route: z.string().max(200).optional() }),
    // storm control: raw evidence capped per crash group; the issue rollup below
    // still counts every occurrence, so the dashboard number stays exact
    burst: { key: 'field:error.fingerprint', maxPerMinute: 60 },
    // the issue/group object an error tracker is built on: first seen, last seen,
    // event count, first release. Outlives the 90d error rows on purpose.
    rollups: [{
      as: 'issue',
      by: ['field:error.fingerprint'],
      capture: ['field:release', 'field:error.type', 'attr:route'],
      retentionDays: null,
    }],
    description: 'Uncaught exception',
  },

  'account.lifecycle': {
    kind: TelemetryKind.State,
    origin: Origin.Server,
    subjects: ['org'],
    description: 'Account lifecycle transition — trial → active → churned',
  },

  'billing.ai_tokens': {
    kind: TelemetryKind.Usage,
    origin: Origin.Server,
    subjects: ['org'],
    // usage rows are immortal; the spans they came from are not. Any dimension a
    // spend question needs must be on the longest-lived row that can answer it.
    attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string().max(64) }),
    metrics: z.object({ cost_usd: z.number() }),
    indexedAttrs: ['gen_ai_request_model'],
    description: 'Billable token consumption',
  },
} as const satisfies Record<string, EventSpec>

export type TelemetryName = keyof typeof REGISTRY

export type AttrsOf<N extends TelemetryName> =
  (typeof REGISTRY)[N] extends { attrs: infer A extends z.ZodTypeAny } ? z.infer<A> : never
export type MetricsOf<N extends TelemetryName> =
  (typeof REGISTRY)[N] extends { metrics: infer M extends z.ZodTypeAny } ? z.infer<M> : never
```

### 4.3 `telemetry.model.ts`

```ts
import mongoose, { type Types } from 'mongoose'
import {
  prop, index, pre, modelOptions, Severity,
  getModelForClass, getDiscriminatorModelForClass, type DocumentType,
} from '@typegoose/typegoose'
import {
  TelemetryKind, LogLevel, Env, Origin, Platform,
  RETENTION_DAYS, SCHEMA_VERSION, newId, UNKNOWN,
} from './telemetry.types'
import { REGISTRY } from './telemetry.registry'

/** Mongoose Map keys cannot contain dots. gen_ai.request.model -> gen_ai_request_model */
const safeKey = (k: string) => k.replace(/\./g, '_')
const sanitize = <T>(m?: Map<string, T>) =>
  m ? new Map([...m].map(([k, v]) => [safeKey(k), v] as [string, T])) : m

/** surfaced on /metrics so drops are never silent */
export const telemetryCounters = { rejected: 0, defaulted: 0, sampled: 0, capped: 0, rollupSkipped: 0 }

@pre<TelemetryBase>('validate', function () {
  this._id ??= newId()
  this.schemaVersion ??= SCHEMA_VERSION
  this.occurredAt ??= new Date()

  this.attrs = sanitize(this.attrs)
  this.metrics = sanitize(this.metrics)

  // ── derived identity arrays ────────────────────────────
  const refs = (this.subjects ?? []).map(s => `${s.type}:${s.id}`)
  this.subjectKeys = [...new Set(refs)]
  this.otherPrincipals = [...new Set(
    [this.actor, this.onBehalfOf].filter((r): r is string => !!r && !refs.includes(r)),
  )]

  // Never fail on missing origin metadata — default and COUNT.
  // These fields deliberately carry no schema `default:`; Mongoose applies those
  // at construction, before this hook, which would make both branches dead code
  // and pin `telemetryCounters.defaulted` at zero forever. See §7.
  for (const f of ['service', 'release'] as const) {
    if (!this[f]) { this[f] = UNKNOWN; telemetryCounters.defaulted++ }
  }
  if (!this.env) {
    this.env = process.env.NODE_ENV === 'production' ? Env.Prod : Env.Dev
  }

  const spec = REGISTRY[this.name as keyof typeof REGISTRY]
  if (!spec) throw new Error(`telemetry: unregistered event "${this.name}"`)
  if (spec.kind !== this.kind) throw new Error(`telemetry: "${this.name}" is kind=${spec.kind}`)

  // retention: per-event override, else per-kind. undefined -> immune to the TTL index.
  // `in` rather than `??` so an explicit `retentionDays: null` means immortal.
  const days = 'retentionDays' in spec
    ? (spec as any).retentionDays
    : RETENTION_DAYS[this.kind]
  if (days != null && !this.expiresAt) {
    this.expiresAt = new Date(this.occurredAt.getTime() + days * 864e5)
  }

  const haveTypes = new Set((this.subjects ?? []).map(s => s.type))
  for (const t of spec.subjects) {
    if (!haveTypes.has(t)) throw new Error(`telemetry: "${this.name}" requires subject "${t}"`)
  }
  if (spec.origin === Origin.Client && !this.client) {
    throw new Error(`telemetry: "${this.name}" is client-origin and requires client context`)
  }

  // per-kind requiredness lives HERE, not in `declare` prop overrides —
  // TS emits no field definition for `declare`, so decorators on it never apply.
  if (this.kind === TelemetryKind.Span) {
    for (const f of ['traceId', 'spanId'] as const) {
      if (!this[f]) throw new Error(`telemetry: span requires ${f}`)
    }
    if (typeof this.durationMs !== 'number') throw new Error('telemetry: span requires durationMs')
  }
  if (this.kind === TelemetryKind.State && !this.state?.to) {
    throw new Error('telemetry: state requires state.to')
  }

  const check = (label: string, m: Map<string, any> | undefined, schema?: any) => {
    const obj = Object.fromEntries(m ?? [])
    if (!schema) {
      if (Object.keys(obj).length) throw new Error(`telemetry: "${this.name}" declares no ${label}`)
      return
    }
    const r = schema.strict().safeParse(obj)
    if (!r.success) throw new Error(`telemetry: ${label} invalid for "${this.name}": ${r.error.message}`)
  }
  check('attrs', this.attrs, (spec as any).attrs)
  check('metrics', this.metrics, (spec as any).metrics)

  // `data` is dropped unless the registry declares a schema for it.
  // This is what makes delete-by-subject a guarantee rather than best-effort.
  if (this.data) {
    const s = (spec as any).data
    if (!s) { this.data = undefined; telemetryCounters.rejected++ }
    else {
      const r = s.strict().safeParse(this.data)
      if (!r.success) throw new Error(`telemetry: data invalid for "${this.name}": ${r.error.message}`)
      this.data = r.data
    }
  }
})

@modelOptions({
  schemaOptions: {
    collection: 'telemetry',
    discriminatorKey: 'kind',
    timestamps: { createdAt: 'receivedAt', updatedAt: false },
    versionKey: false,
    minimize: false,
    _id: true,
  },
  options: { allowMixed: Severity.ALLOW },
})
// every subject, tenant-scoped and time-sorted, from ONE multikey compound index
@index({ tenantId: 1, subjectKeys: 1, occurredAt: -1 })
@index({ tenantId: 1, kind: 1, name: 1, occurredAt: -1 })
@index({ traceId: 1, occurredAt: 1 }, { partialFilterExpression: { traceId: { $exists: true } } })
// erasure completeness — usually a tiny array, so cheap to maintain
@index({ tenantId: 1, otherPrincipals: 1 },
  { partialFilterExpression: { otherPrincipals: { $exists: true, $ne: [] } } })
// partial: usage rows have no expiresAt and must not be indexed as null
@index({ expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } })
export class TelemetryBase {
  /** Mongoose owns this — never declare it as a @prop */
  public readonly kind!: TelemetryKind

  /** UUIDv7 — sortable, insertion-local, replaces the ObjectId (no second unique index) */
  @prop({ required: true, type: () => String }) public _id!: string

  @prop({ required: true }) public schemaVersion!: number
  @prop({ required: true }) public occurredAt!: Date
  @prop() public receivedAt?: Date                       // set by timestamps
  @prop({ required: true }) public name!: string
  @prop({ required: true, enum: LogLevel, type: String, default: LogLevel.Info })
  public severity!: LogLevel

  // ── identity ──────────────────────────────────────────
  /** tenancy root: shard key, access boundary, index prefix. The only promoted id. */
  @prop({ required: true }) public tenantId!: string

  /** multi-party capable: two users, sender/recipient, admin+impersonated */
  @prop({ type: () => [SubjectRef], _id: false, default: [] }) public subjects!: SubjectRef[]

  /** derived: ['user:u_1','org:o_9'] */
  @prop({ type: () => [String] }) public subjectKeys?: string[]

  /** who caused it */
  @prop() public actor?: string
  /** impersonation / delegation */
  @prop() public onBehalfOf?: string
  /** derived: actor/onBehalfOf NOT already in subjects. Erasure completeness. */
  @prop({ type: () => [String] }) public otherPrincipals?: string[]

  // ── origin — required, but filled by the hook, NEVER `default:` ───────
  // A schema default is applied at construction, before pre('validate'), which
  // would silently stamp dev traffic as `prod` and zero out the drop counter.
  @prop({ required: true }) public service!: string
  @prop({ required: true }) public release!: string
  @prop({ required: true, enum: Env, type: String }) public env!: Env

  @prop({ enum: Origin, type: String, default: Origin.Server }) public origin!: Origin

  /** required for client-origin events (enforced by registry, not by the schema) */
  @prop({ type: () => ClientContext, _id: false }) public client?: ClientContext

  // ── correlation ───────────────────────────────────────
  @prop() public traceId?: string
  @prop() public spanId?: string
  @prop() public parentId?: string
  @prop() public durationMs?: number

  // ── payload — no wildcard index; see §4.4 ─────────────
  /** STRING VALUES ONLY — Mongoose casts on assignment. Numbers belong in metrics. */
  @prop({ type: () => String, default: {} }) public attrs?: Map<string, string>
  @prop({ type: () => Number, default: {} }) public metrics?: Map<string, number>
  /** only stored when the registry declares a schema for it */
  @prop({ type: () => Object }) public data?: Record<string, unknown>
  @prop() public body?: string

  // ── ops ───────────────────────────────────────────────
  /** 1 = kept everything. 0.05 = multiply counts by 20 when aggregating. */
  @prop({ default: 1 }) public sampleRate!: number
  /** kept despite sampling (carried money or an error). NOT representative. */
  @prop({ default: false }) public forced!: boolean
  @prop() public expiresAt?: Date
  /** set by forget() — row survives, identifiers do not */
  @prop() public redactedAt?: Date

  // ── extensions (populated per discriminator) ──────────
  public state?: StateDetail
}

// ── identity subdoc ───────────────────────────────────────
class SubjectRef {
  @prop({ required: true }) public type!: string     // user | org | team | project
  @prop({ required: true }) public id!: string
  /** disambiguates same-type parties: sender | recipient | impersonated | owner */
  @prop() public role?: string
}

// ── client context: SPA / Electron / mobile ───────────────
class ClientContext {
  @prop({ enum: Platform, type: String, required: true }) public platform!: Platform
  @prop({ required: true }) public appVersion!: string
  @prop() public userAgent?: string
  @prop() public os?: string
  @prop() public osVersion?: string
  @prop() public browser?: string
  @prop() public browserVersion?: string
  @prop() public deviceType?: string          // desktop | mobile | tablet
  @prop() public locale?: string
  @prop() public timezone?: string
  @prop() public screenW?: number
  @prop() public screenH?: number
  @prop() public viewportW?: number
  @prop() public viewportH?: number
  @prop() public connection?: string          // 4g | wifi | slow-2g
  @prop() public online?: boolean
  /** client clock minus server clock, ms — client timestamps lie */
  @prop() public clockSkewMs?: number
}

// ── sub-docs ──────────────────────────────────────────────
class StackFrame {
  @prop() public filename?: string
  @prop() public fn?: string
  @prop() public lineno?: number
  @prop() public colno?: number
  @prop() public inApp?: boolean
  @prop({ type: () => [String] }) public context?: string[]
}

class ErrorDetail {
  @prop({ required: true }) public type!: string
  @prop({ required: true }) public message!: string
  @prop({ required: true, default: false }) public handled!: boolean
  /** grouping key */
  @prop({ required: true }) public fingerprint!: string
  @prop({ type: () => [StackFrame], _id: false }) public frames?: StackFrame[]
}

class StateDetail {
  /** 'lifecycle' | 'onboarding_step' | 'subscription' */
  @prop({ required: true }) public key!: string
  @prop() public from?: string
  @prop({ required: true }) public to!: string
  /** how long the subject sat in `from` — this is what answers "where do they stall" */
  @prop() public previousSinceMs?: number
}

class UsageDetail {
  @prop({ required: true }) public meter!: string
  @prop({ required: true }) public quantity!: number
  @prop({ required: true }) public unit!: string
  /**
   * Authoritative money. `metrics.cost_usd` is a BSON double — fine as a measure,
   * wrong as the thing that becomes an invoice once you sum millions of them.
   * Rule: money is authoritative only on kind=usage; the metric is a lossy copy
   * kept for rollups and per-trace arithmetic.
   */
  @prop({ type: () => mongoose.Types.Decimal128 }) public amount?: Types.Decimal128
  @prop() public currency?: string
  /** at-least-once dedupe. Deterministic, e.g. `${traceId}:${spanId}` */
  @prop({ required: true }) public idempotencyKey!: string
  /** who pays — 'org:o_9'. Distinct from subject and from actor. */
  @prop({ required: true }) public billedTo!: string
  @prop({ required: true, default: true }) public billable!: boolean
  @prop() public priceVersion?: string
  /** corrections are new reversing rows; never UPDATE a billed row */
  @prop() public reverses?: string
}

// ── discriminators ────────────────────────────────────────
export class TelemetryEvent extends TelemetryBase {}   // envelope suffices

@index({ tenantId: 1, 'error.fingerprint': 1, occurredAt: -1 },
  { partialFilterExpression: { kind: TelemetryKind.Error } })
export class TelemetryError extends TelemetryBase {
  @prop({ required: true, type: () => ErrorDetail, _id: false }) public error!: ErrorDetail
}

// requiredness for traceId/spanId/durationMs is enforced in pre('validate'),
// NOT via `declare` overrides — see the hook.
@index({ traceId: 1, parentId: 1 }, { partialFilterExpression: { kind: TelemetryKind.Span } })
export class TelemetrySpan extends TelemetryBase {}

@index({ tenantId: 1, 'state.key': 1, 'state.to': 1, occurredAt: -1 },
  { partialFilterExpression: { kind: TelemetryKind.State } })
export class TelemetryState extends TelemetryBase {
  @prop({ required: true, type: () => StateDetail, _id: false }) public declare state: StateDetail
}

@index({ 'usage.idempotencyKey': 1 },
  { unique: true, partialFilterExpression: { kind: TelemetryKind.Usage } })
@index({ tenantId: 1, 'usage.meter': 1, occurredAt: 1 },
  { partialFilterExpression: { kind: TelemetryKind.Usage } })
export class TelemetryUsage extends TelemetryBase {
  @prop({ required: true, type: () => UsageDetail, _id: false }) public usage!: UsageDetail
}

export const TelemetryModel = getModelForClass(TelemetryBase)
export const EventModel = getDiscriminatorModelForClass(TelemetryModel, TelemetryEvent, TelemetryKind.Event)
export const ErrorModel = getDiscriminatorModelForClass(TelemetryModel, TelemetryError, TelemetryKind.Error)
export const SpanModel  = getDiscriminatorModelForClass(TelemetryModel, TelemetrySpan,  TelemetryKind.Span)
export const StateModel = getDiscriminatorModelForClass(TelemetryModel, TelemetryState, TelemetryKind.State)
export const UsageModel = getDiscriminatorModelForClass(TelemetryModel, TelemetryUsage, TelemetryKind.Usage)

export type TelemetryDoc = DocumentType<TelemetryBase>
```

> `TelemetryState` uses `declare` on a base-declared optional made required in the
> subclass. If your TS config makes that decorator a no-op, the hook already
> enforces `state.to`, so the guarantee does not depend on it. Verify with a test
> that `StateModel.create({})` rejects.

### 4.4 `telemetry.indexes.ts` — registry-driven, replaces the wildcard

A wildcard index (`{'attrs.$**': 1}`) is standalone and cannot compound with
`tenantId` (pre-Mongo 7.0), so any attr query would scan across every tenant —
both a perf problem and the exact isolation hole `scoped()` exists to close.
It also contradicts the allowlist: if attrs are bounded and declared, pay for
targeted indexes instead of insert cost on everything.

```ts
import { TelemetryModel } from './telemetry.model'
import { REGISTRY } from './telemetry.registry'

/** Mongo caps a collection at 64 indexes. Base + discriminators use ~10. Budget the rest. */
const INDEX_BUDGET = 24

export async function syncTelemetryIndexes() {
  // one generator, two payload maps — attrs (string equality) and metrics
  // (numeric range). Identical shape: tenant-prefixed, name-pinned, time-sorted.
  const plan = (name: string, kind: 'attr' | 'metric', key: string) => ({
    name: `${kind}_${name.replace(/\./g, '_')}_${key}`,
    keys: { tenantId: 1, [`${kind === 'attr' ? 'attrs' : 'metrics'}.${key}`]: 1, occurredAt: -1 },
    partial: { name },                // keeps each index to just that event's rows
  })
  const planned = Object.entries(REGISTRY).flatMap(([name, spec]) => [
    ...((spec as any).indexedAttrs ?? []).map((k: string) => plan(name, 'attr', k)),
    ...((spec as any).indexedMetrics ?? []).map((k: string) => plan(name, 'metric', k)),
  ])

  const coll = TelemetryModel.collection
  const plannedNames = new Set(planned.map(p => p.name))

  // Drop orphans FIRST. If the budget check ran first, removing an entry to get
  // back under the cap would still throw, and the stale index would never be
  // dropped — unrecoverable without manual intervention.
  for (const ix of await coll.indexes()) {
    if ((ix.name?.startsWith('attr_') || ix.name?.startsWith('metric_')) && !plannedNames.has(ix.name)) {
      await coll.dropIndex(ix.name)
    }
  }

  if (planned.length > INDEX_BUDGET) {
    throw new Error(`telemetry: ${planned.length} payload indexes exceeds budget ${INDEX_BUDGET}`)
  }

  for (const p of planned) {
    await coll.createIndex(p.keys, {
      name: p.name, partialFilterExpression: p.partial, background: true,
    })
  }
}
```

Every payload index is tenant-prefixed and time-sorted. Because the partial
filter pins `name`, a query must include `{ name }` to use it. Undeclared attrs
and metrics stay queryable via a `$match` on `{tenantId, name, occurredAt}`
first — bounded, no index needed, fine for ad-hoc at this volume.

> Mongo 7.0+ supports Compound Wildcard Indexes (`{tenantId: 1, 'attrs.$**': 1}`)
> if you later want genuinely exploratory attr queries. Add it deliberately, not
> by default.

### 4.5 `telemetry.rollups.ts` — one derived-aggregate primitive

Raw events answer "how many, in this window, if you scan." They do **not** cheaply
answer:

| question | product this belongs to | key |
|---|---|---|
| did this user ever, and when first? | funnels, activation | `(subject)` |
| how many times has *this crash* fired, since when, in which release? | error tracker | `(error.fingerprint)` |
| what did we spend on this model, in this feature, on this day? | usage metering | `(model, feature, day)` |
| was this user active in week N? | retention | `(subject, week)` |

Four questions, one operation: **group a stream of records by a declared tuple and
keep first / last / count / sums.** Generalizing the key is what turns one rollup
into all four, so the registry declares the tuple and this file is agnostic.

```ts
import { prop, index, modelOptions, getModelForClass } from '@typegoose/typegoose'
import { REGISTRY, type RollupSpec, type DimSource } from './telemetry.registry'
import { telemetryCounters } from './telemetry.model'

@modelOptions({ schemaOptions: { collection: 'telemetry_rollups', versionKey: false } })
// cohort scan within one family, ordered by first occurrence
@index({ tenantId: 1, as: 1, subjectType: 1, firstAt: 1 })
// slice a family by dimension value, newest bucket first
@index({ tenantId: 1, as: 1, dims: 1, bucketAt: -1 })
// erasure + per-subject journey across ALL families — no `as` prefix on purpose
@index({ tenantId: 1, dims: 1 })
@index({ expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } })
export class TelemetryRollup {
  /** `${tenantId}|${as}|${dims.join('|')}|${bucketKey}` — deterministic, upsert-safe */
  @prop({ required: true, type: () => String }) public _id!: string
  @prop({ required: true }) public tenantId!: string
  /** rollup family. Several event names may feed one. */
  @prop({ required: true }) public as!: string
  /**
   * Dimension values in spec order. Subject dims keep their native `type:id` form
   * ('user:u_1') so erasure can match them directly; everything else is `key=value`
   * ('gen_ai_request_model=claude-opus-5'). Flattened strings for the same reason
   * subjectKeys is (§2.5) — never compound-index two fields of one subdoc array.
   */
  @prop({ type: () => [String], required: true }) public dims!: string[]
  /** denormalized prefix of the subject dim, when there is one — see §5.4 */
  @prop() public subjectType?: string
  /** UTC-truncated bucket start; absent on lifetime rollups */
  @prop() public bucketAt?: Date

  @prop({ required: true }) public firstAt!: Date
  @prop({ required: true }) public lastAt!: Date
  @prop({ required: true, default: 0 }) public count!: number
  /** registry `sum` keys accumulated across every contributing record */
  @prop({ type: () => Number, default: {} }) public sums?: Map<string, number>
  /** registry `capture` snapshot at FIRST occurrence — cohort dimensions */
  @prop({ type: () => String, default: {} }) public firstCapture?: Map<string, string>
  @prop() public firstTraceId?: string
  @prop() public expiresAt?: Date
}

export const RollupModel = getModelForClass(TelemetryRollup)

// ── dimension resolution ──────────────────────────────────
const path = (o: any, p: string) =>
  typeof o?.get === 'function' ? o.get(p) : p.split('.').reduce((a, k) => a?.[k], o)

/** `subject` is handled by fan-out, so it resolves to undefined here.
 *  Exported: emit()'s burst cap keys on the same sources (§4.6). */
export const resolveDim = (src: DimSource, doc: any): unknown =>
  src.startsWith('attr:')  ? doc.attrs?.get(src.slice(5))
  : src.startsWith('field:') ? path(doc, src.slice(6))
  : undefined

const label = (src: DimSource) => src.slice(src.indexOf(':') + 1)

/** UTC. Weeks start Monday. */
const truncate = (d: Date, b?: RollupSpec['bucket']) => {
  if (!b) return undefined
  if (b === 'hour') return new Date(Math.floor(d.getTime() / 36e5) * 36e5)
  const y = d.getUTCFullYear(), m = d.getUTCMonth()
  if (b === 'month') return new Date(Date.UTC(y, m, 1))
  const day = new Date(Date.UTC(y, m, d.getUTCDate()))
  if (b === 'day') return day
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 864e5)
}

/**
 * Update-pipeline upsert so late/backfilled events correct EVERYTHING, not just
 * the boundaries. `$setOnInsert` for firstCapture/firstTraceId would pin the cohort
 * dimensions to whichever record landed first rather than whichever occurred first —
 * silently wrong for offline clients, backfills, and queue retries.
 */
export async function recordRollup(doc: any, name: string, spec: RollupSpec) {
  const as = spec.as ?? name
  const at: Date = doc.occurredAt
  const bucketAt = truncate(at, spec.bucket)
  const bucketKey = bucketAt ? bucketAt.toISOString() : ''

  // Non-subject dims resolved once. A missing dim means the record cannot be keyed
  // at all — dropping it into a 'null' bucket would quietly corrupt every group.
  const fixed = new Map<DimSource, string>()
  for (const src of spec.by) {
    if (src === 'subject') continue
    const v = resolveDim(src, doc)
    if (v == null || v === '') { telemetryCounters.rollupSkipped++; return }
    fixed.set(src, `${label(src)}=${String(v)}`)
  }

  // At most one `subject` dim per spec (asserted in validateRollupSpecs).
  const fansOut = spec.by.includes('subject')
  const refs: (string | null)[] = fansOut
    ? (doc.subjectKeys ?? []).filter((r: string) =>
        !spec.subjects || spec.subjects.includes(r.split(':')[0]))
    : [null]
  if (!refs.length) return

  const firstCapture = Object.fromEntries(
    (spec.capture ?? [])
      .map(src => [label(src), resolveDim(src, doc)])
      .filter(([, v]) => v != null)
      .map(([k, v]) => [k as string, String(v)]),
  )

  const expiresAt = spec.retentionDays != null
    ? new Date(at.getTime() + spec.retentionDays * 864e5)
    : undefined

  await RollupModel.bulkWrite(refs.map(ref => {
    const dims = spec.by.map(src => (src === 'subject' ? ref! : fixed.get(src)!))
    /** true when this record becomes the new earliest occurrence */
    const isNewFirst = {
      $or: [{ $eq: [{ $type: '$firstAt' }, 'missing'] }, { $lt: [at, '$firstAt'] }],
    }
    const sums = Object.fromEntries(
      (spec.sum ?? [])
        .map(k => [k, doc.metrics?.get(k)])
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [`sums.${k}`, { $add: [{ $ifNull: [`$sums.${k}`, 0] }, v] }]),
    )
    return {
      updateOne: {
        filter: { _id: `${doc.tenantId}|${as}|${dims.join('|')}|${bucketKey}` },
        update: [{
          $set: {
            tenantId: doc.tenantId, as, dims,
            ...(ref ? { subjectType: ref.split(':')[0] } : {}),
            ...(bucketAt ? { bucketAt } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            // aggregation $min/$max ignore missing, so these are correct on insert too
            firstAt: { $min: ['$firstAt', at] },
            lastAt:  { $max: ['$lastAt', at] },
            count:   { $add: [{ $ifNull: ['$count', 0] }, 1] },
            ...sums,
            firstTraceId:  { $cond: [isNewFirst, doc.traceId ?? null, '$firstTraceId'] },
            firstCapture:  { $cond: [isNewFirst, firstCapture, '$firstCapture'] },
          },
        }],
        upsert: true,
      },
    }
  }), { ordered: false })
}

/**
 * Two events feeding one `as` with different `by` shapes produce docs whose dims
 * array means different things at the same position — silently unqueryable.
 * Call at boot, next to syncTelemetryIndexes().
 */
export function validateRollupSpecs() {
  const shapes = new Map<string, string>()
  for (const [name, spec] of Object.entries(REGISTRY)) {
    for (const r of (spec as any).rollups ?? [] as RollupSpec[]) {
      if (r.by.filter(d => d === 'subject').length > 1) {
        throw new Error(`telemetry: rollup on "${name}" has more than one subject dim`)
      }
      if (r.by.includes('subject') && !r.subjects?.length) {
        throw new Error(`telemetry: rollup on "${name}" uses subject without \`subjects\``)
      }
      const as = r.as ?? name
      // shape = dims + bucket + subject classes: any mismatch makes docs in one
      // family mean different things at the same array position (or triggers the
      // §5.4 null-join inflation), so all three are pinned per family.
      const shape = r.by.join(',') + '|' + (r.bucket ?? '') + '|' + [...(r.subjects ?? [])].sort().join(',')
      const seen = shapes.get(as)
      if (seen && seen !== shape) {
        throw new Error(`telemetry: rollup family "${as}" declared with two shapes: ${seen} / ${shape}`)
      }
      shapes.set(as, shape)
    }
  }
}
```

Only registry events with a `rollups` block pay this cost, and each block is one
`bulkWrite`. Everything else skips it entirely — the write amplification is opt-in
and countable.

**What the four questions cost now** — registry lines, no new code:

```ts
{ by: ['subject'], subjects: ['user'], capture: ['attr:plan'] }              // milestone
{ as: 'issue', by: ['field:error.fingerprint'], capture: ['field:release'] } // issue group
{ as: 'llm_cost', by: ['attr:gen_ai_request_model', 'attr:feature'],
  bucket: 'day', sum: ['cost_usd'] }                                         // windowed spend
{ as: 'activity', by: ['subject'], subjects: ['user'], bucket: 'day' }       // retention
```

`as` is the load-bearing field: it lets many event names feed one family, which is
what turns per-event milestones into a shared activity stream or a single issue index.

> **Rollups count kept records, with no `1/sampleRate` extrapolation.** On a
> sampled kind that means an undercount. Declare rollups only on unsampled names,
> or on spans whose rows are always force-kept — `llm_cost` is safe precisely
> because every `cost_usd` span survives (§2.6). If you need a rolled-up count of
> a genuinely sampled name, that is §5.3's extrapolation query, not a rollup.

> **Distinct counts do not fall out of this.** "How many users did this crash
> affect", "MAU" — an exact distinct needs an unbounded set per group, which is
> the one thing a fixed-size rollup doc cannot hold. Two honest options: `$group`
> over the bucketed `activity` family (cheap — it is already small), or add an HLL
> sketch field later. Do not approximate it with `count`.

> Rollups are written after the record lands and are not transactional with it.
> A process death between the two loses that group permanently, so this needs a
> periodic reconcile job, not just the one-off backfill in §9.

### 4.6 `telemetry.emit.ts`

Per-kind durability, the aggregate/evidence split, and (dormant) sampling. This
is where the abstraction is *allowed* to leak.

**The two planes.** A record passes through two independent decisions:

1. **Aggregate plane** — rollups. See every *valid* record, unconditionally.
2. **Evidence plane** — the raw row. Subject to sampling and the burst cap.

Sampling and capping are decisions about *storing evidence*, not about whether
the thing happened — so they must never bend an aggregate. Ordering rollups
before the verdict is what makes `sampleRate` a knob you can turn later without
corrupting a single dashboard.

**Plane order follows delivery semantics.** In-process `emit()` is at-most-once,
so rollup-first is safe. Records arriving over the wire (instrumentation.md §3)
are at-least-once — retried batches are the norm — so the ingest path inserts
first (client-supplied `_id`; duplicate key ⇒ drop, **no rollup**) and
aggregates after, exactly the usage inversion below generalized. Reversing
either order double-counts: rollup-first + retries inflates aggregates,
insert-first + sampling loses them.

```ts
import { TelemetryKind, newId, traceKeep, plain, REJECT_TTL_DAYS } from './telemetry.types'
import {
  EventModel, ErrorModel, SpanModel, StateModel, UsageModel,
  TelemetryModel, telemetryCounters,
} from './telemetry.model'
import { recordRollup, resolveDim } from './telemetry.rollups'
import { REGISTRY, type TelemetryName, type AttrsOf, type MetricsOf } from './telemetry.registry'

const MODELS = {
  [TelemetryKind.Event]: EventModel, [TelemetryKind.Error]: ErrorModel,
  [TelemetryKind.Span]: SpanModel,   [TelemetryKind.State]: StateModel,
  [TelemetryKind.Usage]: UsageModel,
}

// Keep-all across the board — small-SaaS scale, exactness beats extrapolation,
// and 90d of unsampled spans is what makes p95-by-route a raw query (§5.3).
// The per-trace machinery (§2.6) stays, dormant: turn a kind down here, or a
// single name via EventSpec.sampleRate, when volume ever demands it. Rollups
// are exact either way — they run before the verdict.
const SAMPLE_RATE: Record<TelemetryKind, number> = {
  [TelemetryKind.Span]: 1,
  [TelemetryKind.Event]: 1,
  [TelemetryKind.Error]: 1,     // raw storage burst-capped per fingerprint instead
  [TelemetryKind.State]: 1,
  [TelemetryKind.Usage]: 1,     // NEVER sample. money.
}

/** invalid events land here instead of vanishing into a .catch() */
const quarantine = () => TelemetryModel.db.collection('telemetry_rejects')

export async function ensureQuarantineTtl() {
  await quarantine().createIndex({ at: 1 }, { expireAfterSeconds: REJECT_TTL_DAYS * 86400 })
}

/** per-process token buckets — a storm cap, approximate on purpose, not an SLA */
const burstBuckets = new Map<string, { n: number; resetAt: number }>()
const burstAllow = (key: string, maxPerMinute: number) => {
  const now = Date.now()
  let b = burstBuckets.get(key)
  if (!b || now >= b.resetAt) {
    if (burstBuckets.size > 10_000) burstBuckets.clear()  // storm of DISTINCT keys
    b = { n: 0, resetAt: now + 60_000 }
    burstBuckets.set(key, b)
  }
  return ++b.n <= maxPerMinute
}

type SubjectInput = Array<{ type: string; id: string; role?: string }>

export async function emit<N extends TelemetryName>(name: N, doc: {
  tenantId: string
  subjects?: SubjectInput
  attrs?: AttrsOf<N>
  metrics?: MetricsOf<N>
  /** keep despite sampling — set automatically for money/errors */
  forceKeep?: boolean
  [k: string]: any
}) {
  const spec = REGISTRY[name]
  const kind = spec.kind
  const baseRate = (spec as any).sampleRate ?? SAMPLE_RATE[kind]

  // a span carrying money or an error must survive, or the usage→span join dangles
  const forced = !!doc.forceKeep
    || kind === TelemetryKind.Usage
    || !!doc.error
    || (doc.metrics as any)?.cost_usd != null

  const Model = MODELS[kind] as any
  const { forceKeep: _drop, ...rest } = doc

  // `...rest` FIRST. Spreading it last would let a caller override `forced`,
  // `sampleRate`, `name`, or `_id` — and a cost-bearing span passed forced:false
  // gets sampled away, dangling the usage→span join force-keep exists to protect.
  const payload = {
    ...rest,
    _id: newId(),
    name,
    sampleRate: forced ? 1 : baseRate,
    forced,
    attrs: new Map(Object.entries(doc.attrs ?? {})),
    metrics: new Map(Object.entries(doc.metrics ?? {})),
  }

  const onFail = async (e: unknown) => {
    telemetryCounters.rejected++
    // plain() first — JSON.stringify(Map) is '{}' and would erase every subject
    await quarantine().insertOne({
      at: new Date(), name, reason: String(e), raw: plain(doc),
    }).catch(() => {})
  }

  // Hydrate + validate ONCE, for every record — kept, sampled, or capped. The
  // pre('validate') hook derives subjectKeys, sanitizes dotted attr keys, and
  // runs the registry checks, so the aggregate plane below never sees an
  // invalid or under-derived record.
  const d = new Model(payload)
  try {
    await d.validate()
  } catch (e) {
    await onFail(e)
    if (kind === TelemetryKind.Usage) throw e            // caller must know
    return
  }

  const rollup = () => {
    for (const r of ((spec as any).rollups ?? [])) recordRollup(d, name, r).catch(onFail)
  }

  // Usage is the one inversion: its rollups run AFTER the durable write, because
  // the idempotency dedupe must also gate aggregation — a retried usage row is
  // the same money, and counting it twice is exactly what the unique index exists
  // to prevent.
  if (kind === TelemetryKind.Usage) {
    try {
      await d.save({ w: 'majority', j: true })           // durable. money.
      rollup()
    } catch (e: any) {
      if (e?.code === 11000) return                      // dedupe working — no re-count
      await onFail(e); throw e
    }
    return
  }

  // ── aggregate plane: unconditional ────────────────────
  rollup()

  // ── evidence plane: sampling verdict, then burst cap ──
  if (!forced && !traceKeep(doc.traceId, baseRate)) { telemetryCounters.sampled++; return }

  // Cost-bearing records are exempt from the cap — the usage→span join outranks
  // storm control, and money volume is bounded by spend anyway.
  const burst = (spec as any).burst
  if (burst && (doc.metrics as any)?.cost_usd == null) {
    const v = burst.key ? resolveDim(burst.key, d) : ''
    if (!burstAllow(`${doc.tenantId}|${name}|${v ?? ''}`, burst.maxPerMinute)) {
      telemetryCounters.capped++
      return
    }
  }

  // hook already ran; skip the re-validate on save
  d.save({ validateBeforeSave: false }).catch(onFail)    // fire-and-forget, but never silent
}

/** tenant scope is not optional — force every read through here */
export const scoped = (tenantId: string) => ({
  find: (q: object = {}) => TelemetryModel.find({ tenantId, ...q }),
  aggregate: (stages: object[]) => TelemetryModel.aggregate([{ $match: { tenantId } }, ...stages]),
})
```

### 4.7 `telemetry.forget.ts` — erasure, actually implemented

```ts
import { createHash } from 'crypto'
import { TelemetryModel } from './telemetry.model'
import { RollupModel } from './telemetry.rollups'
import { TelemetryKind, type EntityRef } from './telemetry.types'

/** keeps the `type:` prefix so subjectKeys stays re-derivable on any later save */
const pseudoId = (ref: string) =>
  'redacted_' + createHash('sha256')
    .update(ref + process.env.TELEMETRY_PEPPER!).digest('hex').slice(0, 16)

/**
 * Erasure covers subjects, actor, onBehalfOf, and client — every place an id can
 * appear, because `data` is registry-declared-or-unstored.
 *
 * DELETE only when the ref is the sole party on the row. Any row with surviving
 * subjects is REDACTED instead: forgetting a user must not destroy the org's
 * business record. Usage rows are always redacted (statutory retention).
 */
export async function forget(tenantId: string, ref: EntityRef) {
  const [type] = ref.split(':') as [string, string]
  const newId = pseudoId(ref)
  const newRef = `${type}:${newId}`

  const match = { tenantId, $or: [{ subjectKeys: ref }, { otherPrincipals: ref }] }

  // 1. sole-party, non-financial rows: delete outright
  const del = await TelemetryModel.deleteMany({
    ...match,
    kind: { $ne: TelemetryKind.Usage },
    subjectKeys: { $eq: ref, $size: 1 },      // ref is the ONLY subject
    otherPrincipals: { $in: [[], null] },
  })

  // 2. everything else: keep the row, destroy the linkage
  const red = await TelemetryModel.updateMany(match, [{
    $set: {
      subjects: {
        $map: {
          input: '$subjects', as: 's',
          in: {
            $cond: [
              { $eq: [{ $concat: ['$$s.type', ':', '$$s.id'] }, ref] },
              { $mergeObjects: ['$$s', { id: newId }] },
              '$$s',
            ],
          },
        },
      },
      subjectKeys: {
        $map: { input: '$subjectKeys', as: 'k',
                in: { $cond: [{ $eq: ['$$k', ref] }, newRef, '$$k'] } },
      },
      otherPrincipals: {
        $map: { input: { $ifNull: ['$otherPrincipals', []] }, as: 'k',
                in: { $cond: [{ $eq: ['$$k', ref] }, newRef, '$$k'] } },
      },
      actor:      { $cond: [{ $eq: ['$actor', ref] },      newRef, '$actor'] },
      onBehalfOf: { $cond: [{ $eq: ['$onBehalfOf', ref] }, newRef, '$onBehalfOf'] },
      client: '$$REMOVE',
      redactedAt: '$$NOW',
    },
  }])

  // 3. derived rollups — REKEY, never delete. Deleting a person's rollups
  //    retroactively shrinks every cohort they were counted in, so funnel
  //    denominators change under you. Aggregates survive; the person does not.
  //    _id is immutable in Mongo, so this is insert-then-delete rather than $set.
  //
  //    Only rollups that carry the ref as a DIMENSION are touched. A rollup grouped
  //    on something else — an issue keyed on error.fingerprint — never held the id
  //    in the first place, which is exactly why non-subject rollups are safe to
  //    keep forever.
  const rolls = await RollupModel.find({ tenantId, dims: ref }).lean()
  let rollups = 0
  if (rolls.length) {
    await RollupModel.bulkWrite(
      rolls.map(r => {
        const dims = r.dims.map((d: string) => (d === ref ? newRef : d))
        const bucketKey = r.bucketAt ? new Date(r.bucketAt).toISOString() : ''
        return {
          insertOne: {
            document: {
              ...r,
              _id: `${tenantId}|${r.as}|${dims.join('|')}|${bucketKey}`,
              dims,
            },
          },
        }
      }),
      { ordered: false },
    ).catch((e: any) => {
      // re-running forget() for the same ref collides on _id — already erased, no-op
      const errs = e?.writeErrors ?? []
      if (e?.code !== 11000 && !(errs.length && errs.every((w: any) => w.code === 11000))) throw e
    })
    rollups = (await RollupModel.deleteMany({ tenantId, dims: ref })).deletedCount
  }

  // 4. quarantine holds raw payloads — in scope for erasure too
  await TelemetryModel.db.collection('telemetry_rejects').deleteMany({
    'raw.tenantId': tenantId,
    $or: [
      { 'raw.subjects': { $elemMatch: { type, id: ref.split(':')[1] } } },
      { 'raw.actor': ref }, { 'raw.onBehalfOf': ref },
    ],
  })

  // 5. aliases (instrumentation.md §5) are pure linkage — anon→user. Either side
  //    matching is enough; there is nothing to redact, only to delete.
  const aliases = (await TelemetryModel.db.collection('telemetry_aliases').deleteMany({
    tenantId, $or: [{ anonRef: ref }, { userRef: ref }],
  })).deletedCount

  return { deleted: del.deletedCount, redacted: red.modifiedCount, rollups, aliases }
}
```

---

## 5. Usage

### 5.1 Emitting

```ts
await emit('llm.completion', {
  tenantId: 'acc_9',
  subjects: [{ type: 'org', id: 'o_9' }, { type: 'user', id: 'u_123' }],
  actor: 'user:u_123',
  service: 'api', release: 'app@1.4.2',
  traceId: 'tr_01912f3a4b5c', spanId: 's_3', parentId: 's_1', durationMs: 1900,
  occurredAt: new Date(),
  attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: 'claude-opus-5' },
  metrics: { tokens_in: 1200, tokens_out: 800, cost_usd: 0.042 },
  // cost_usd present -> forced:true automatically, join to usage stays intact
})

await emit('report.shared', {
  tenantId: 'acc_9',
  subjects: [
    { type: 'user', id: 'u_123', role: 'sender' },
    { type: 'user', id: 'u_456', role: 'recipient' },
    { type: 'org',  id: 'o_9' },
    { type: 'session', id: 'ses_01912f' },   // §2.3 convention: every client event
  ],
  actor: 'user:u_123',
  client: { platform: 'web', appVersion: '1.4.2', browser: 'Chrome', timezone: 'America/Vancouver' },
  occurredAt: new Date(),
  attrs: { format: 'pdf', route: '/reports' },
  metrics: { rows: 4021 },
})

await emit('account.lifecycle', {
  tenantId: 'acc_9',
  subjects: [{ type: 'org', id: 'o_9' }],
  actor: 'system:billing-worker',
  occurredAt: new Date(),
  state: { key: 'lifecycle', from: 'trial', to: 'active', previousSinceMs: 14 * 864e5 },
})
```

### 5.2 Raw queries

```ts
// everything touching a team, any kind, newest first
scoped('acc_9').find({ subjectKeys: 'team:t_3' }).sort({ occurredAt: -1 })

// full trace: request span + model calls + the error + the usage row
scoped('acc_9').find({ traceId: 'tr_01912f3a4b5c' }).sort({ occurredAt: 1 })

// monthly spend per meter
scoped('acc_9').aggregate([
  { $match: { kind: 'usage', occurredAt: { $gte: start } } },
  { $group: { _id: '$usage.meter', cost: { $sum: '$metrics.cost_usd' } } },
])

// top error groups this week
scoped('acc_9').aggregate([
  { $match: { kind: 'error', occurredAt: { $gte: weekAgo } } },
  { $group: { _id: '$error.fingerprint', n: { $sum: 1 }, msg: { $first: '$error.message' } } },
  { $sort: { n: -1 } }, { $limit: 20 },
])

// where do accounts stall — mean time spent in each state before leaving it
scoped('acc_9').aggregate([
  { $match: { kind: 'state', 'state.key': 'lifecycle', 'state.from': { $ne: null } } },
  { $group: { _id: { from: '$state.from', to: '$state.to' },
              n: { $sum: 1 }, avgDays: { $avg: { $divide: ['$state.previousSinceMs', 864e5] } } } },
  { $sort: { n: -1 } },
])
```

### 5.3 Distributions off raw, and the dormant sampling math

Keep-all means the raw collection *is* the sample — percentiles, distributions,
and outlier hunts are plain queries with no correction factor:

```ts
// p95 latency by model, straight off unsampled spans (Mongo 7.0+ $percentile)
scoped('acc_9').aggregate([
  { $match: { kind: 'span', name: 'llm.completion', occurredAt: { $gte: weekAgo } } },
  { $group: { _id: '$attrs.gen_ai_request_model',
              p95: { $percentile: { input: '$durationMs', p: [0.95], method: 'approximate' } },
              n: { $sum: 1 } } },
])

// outlier-expensive calls — hits the metric_llm_completion_cost_usd index (§4.4)
scoped('acc_9')
  .find({ name: 'llm.completion', 'metrics.cost_usd': { $gt: 1 } })
  .sort({ occurredAt: -1 })
```

**If a rate below 1 is ever set** (kind default or `EventSpec.sampleRate`), the
old rules reactivate — for raw queries only:

- Counts from raw: `$sum: { $divide: [1, '$sampleRate'] }`, filtered
  `forced: false` — force-kept rows are deliberately unrepresentative.
- Cost totals from raw: sum directly, `forced: true` included, **no** weighting —
  cost-bearing rows are always kept.
- **Rollup families need no correction, ever.** They are recorded before the
  sampling verdict and before the burst cap (§4.6), so their counts and sums are
  exact at any rate. If a number exists in both places, trust the rollup.

### 5.4 Reading the rollups

> **Never mix subject types in one `as` family.** If one family holds both `user:`
> and `org:` rollups, an org doc joins against a null `user.signed_up` — and
> because BSON null sorts below dates, `$gt: [date, null]` is *true* and
> `$subtract: [date, null]` is null, so any `$lt` window passes. Every org that
> ever shared a report counts as a converted signup, inflating the rate by roughly
> your org count. Two defences: give each subject class its own `as`
> (`report.shared` vs `report.shared.org` in §4.2), and still filter
> `subjectType` at query time.

```ts
// funnel: signed_up -> shared a report, ordered, within 30 days
RollupModel.aggregate([
  { $match: { tenantId, subjectType: 'user',                       // ← not optional
              as: { $in: ['user.signed_up', 'report.shared'] } } },
  { $group: { _id: { $arrayElemAt: ['$dims', 0] },                 // the subject dim
              steps: { $push: { k: '$as', at: '$firstAt' } } } },
  { $project: {
      signedUp: { $first: { $filter: { input: '$steps', cond: { $eq: ['$$this.k', 'user.signed_up'] } } } },
      shared:   { $first: { $filter: { input: '$steps', cond: { $eq: ['$$this.k', 'report.shared'] } } } } } },
  { $match: { signedUp: { $ne: null } } },                         // ← belt and braces
  { $project: {
      converted: { $and: [
        { $ne: ['$shared', null] },
        { $gt: ['$shared.at', '$signedUp.at'] },                       // order matters
        { $lt: [{ $subtract: ['$shared.at', '$signedUp.at'] }, 30 * 864e5] } ] } } },
  { $group: { _id: null, total: { $sum: 1 }, converted: { $sum: { $cond: ['$converted', 1, 0] } } } },
])

// retention: activation rate by signup week, split by acquisition source.
// One pass over both families — no correlated $lookup.
RollupModel.aggregate([
  { $match: { tenantId, subjectType: 'user',
              as: { $in: ['user.signed_up', 'report.shared'] } } },
  { $group: { _id: { $arrayElemAt: ['$dims', 0] },
              signup: { $max: { $cond: [{ $eq: ['$as', 'user.signed_up'] }, '$firstAt', null] } },
              source: { $max: { $cond: [{ $eq: ['$as', 'user.signed_up'] }, '$firstCapture.source', null] } },
              activated: { $max: { $cond: [{ $eq: ['$as', 'report.shared'] }, 1, 0] } } } },
  { $match: { signup: { $ne: null } } },
  { $group: { _id: { week: { $dateTrunc: { date: '$signup', unit: 'week' } }, source: '$source' },
              cohort: { $sum: 1 }, activated: { $sum: '$activated' } } },
  { $sort: { '_id.week': 1 } },
])

// spend by model and feature, last 30 days — reads the immortal llm_cost family,
// not the 400d spans; exact regardless of any future sampling (§4.6)
RollupModel.aggregate([
  { $match: { tenantId, as: 'llm_cost', bucketAt: { $gte: monthAgo } } },
  { $group: { _id: '$dims', cost: { $sum: '$sums.cost_usd' },
              tokens: { $sum: { $add: ['$sums.tokens_in', '$sums.tokens_out'] } } } },
  { $sort: { cost: -1 } },
])

// DAU, and MAU as an exact distinct over the day buckets
RollupModel.aggregate([
  { $match: { tenantId, as: 'activity', bucketAt: { $gte: monthAgo } } },
  { $group: { _id: '$bucketAt', dau: { $sum: 1 } } },              // one doc per user per day
  { $sort: { _id: 1 } },
])

// top issues this week — the error tracker's index page, one point read per group
RollupModel.find({ tenantId, as: 'issue', lastAt: { $gte: weekAgo } })
  .sort({ count: -1 }).limit(20)
```

Two-to-four step funnels over the rollups are cheap. **Arbitrary N-step,
time-windowed, property-filtered funnels over raw events are not** — that is a
columnar workload, and the honest answer stays ClickHouse (§8).

---

## 6. Operational rules

| Concern | Rule — per-kind default, per-name registry override |
|---|---|
| **Sampling** | default keep-all (small-SaaS scale). When enabled: **per trace** (deterministic on `traceId`), never per record; usage never sampled. `EventSpec.sampleRate` overrides per name |
| **Aggregates** | rollups run before the sampling verdict and the burst cap — exact at any rate; usage rolls up after its durable, deduped write |
| **Burst** | `EventSpec.burst` caps RAW rows per resolved key per minute (per-process, approximate); cost-bearing records exempt; overflow counted in `capped` |
| **Force-keep** | any span with `cost_usd` or an error; stamped `forced:true`, `sampleRate:1` |
| **Delivery** | analytics fire-and-forget; usage awaited with `{w:'majority', j:true}` |
| **Retention** | usage forever, event/state 730d, error/span 90d, rejects 30d. `EventSpec.retentionDays` overrides per name (`null` = immortal) |
| **Mutability** | usage rows append-only; corrections are new reversing rows (`usage.reverses`) |
| **Money** | authoritative only as `usage.amount` (Decimal128); `metrics.cost_usd` is a lossy double for aggregation |
| **Grain** | any dimension a question needs must live on the longest-retained row (or rollup family) that answers it; unbounded / nested / numeric payload goes in `data`, never `attrs` |
| **Cardinality** | attrs constrained by registry zod schema; ids never in attrs |
| **Failures** | quarantine collection + counters; nothing disappears into a `.catch()` |
| **Erasure** | delete sole-party rows, redact shared ones, always redact usage, **rekey** subject-dim rollups |

Eight load-bearing lines:

1. **`{ w: 'majority', j: true }` on usage.** Everything else is fire-and-forget by
   design; usage is the one path where a dropped write means a wrong invoice.
2. **Sample on `traceId`, never per record.** Per-record sampling silently
   invalidates every per-trace aggregate (§2.6).
3. **Filter `forced: false` before extrapolating counts.** Force-kept rows are
   deliberately unrepresentative.
4. **`partialFilterExpression` on the unique idempotency index.** Discriminator
   indexes apply to the whole collection; without the filter, every non-usage doc
   has `usage.idempotencyKey: null` and the second one collides.
5. **No schema `default:` on any field the validate hook also fills.** Mongoose
   applies defaults at construction, so the hook's branch becomes dead code —
   which is how dev traffic gets stamped `prod` and a drop counter reads zero
   forever.
6. **Spread caller input *first* when building a payload.** Computed fields last,
   or the caller can override `forced` and sample away a row that carries money.
7. **One `as` family, one shape, one subject class.** `validateRollupSpecs()`
   rejects mixed `by` shapes at boot; mixed subject types produce the null-join
   inflation in §5.4. Split families instead of filtering around it.
8. **Aggregate before you drop.** Rollups run before the sampling verdict and the
   burst cap (§4.6). Reordering that — "optimizing" the sampled path to skip
   rollups — silently changes every dashboard the moment a rate drops below 1.

---

## 7. Mongo gotchas

- **Schema defaults run before `pre('validate')`.** A `default:` on a field the
  hook also fills makes the hook a no-op. This bit `env` (dev data stamped `prod`)
  and `service`/`release` (the `defaulted` counter pinned at zero). Those three
  props deliberately carry no default; the hook owns them.
- **`attrs` values are strings, always.** Mongoose casts on assignment for
  `Map<string, String>`, so a zod `z.number()` in an `attrs` schema fails 100% of
  the time — by validation the value is already `'5'`. Use `z.string()`,
  `z.enum()`, or `z.coerce.number()`. Numbers belong in `metrics`.
- **`Map` has no `toJSON`.** `JSON.stringify(new Map([['a','b']]))` is `'{}'`. Any
  path that serializes a document — quarantine, webhooks, exports — must go
  through `plain()` first or it silently drops `attrs`, `metrics`, `sums`, and
  `firstCapture`.
- **Map keys cannot contain dots.** OTel keys like `gen_ai.request.model` break
  Mongoose Maps and dotted queries. Sanitized in `pre('validate')`; registry keys
  use underscores to match.
- **TTL is collection-wide on one field.** Can't vary per discriminator — hence
  `expiresAt` computed at write, with a **partial** filter so immortal usage rows
  aren't indexed as null on the largest collection. Changing `RETENTION_DAYS`
  governs rows written after the change, not existing ones.
- **Never compound-index two fields of the same subdoc array** — Mongo matches
  across elements. Index the derived `type:id` string instead.
- **`_id` is immutable.** Anything that has to be re-keyed later — rollups under
  `forget()` — is insert-then-delete, not `$set`.
- **BSON null sorts below dates.** `$gt: [date, null]` is `true`, and `$subtract`
  with null yields null so downstream comparisons pass. Any aggregation joining
  optional stages must exclude nulls explicitly (§5.4).
- **`declare` emits no field definition**, so a decorator on a `declare` property
  may never apply. Per-kind requiredness therefore lives in the validate hook.
  Assert it with a test rather than trusting the decorator.
- **`_id` holds the UUIDv7**, so there is exactly one unique index per row. A
  36-char string `_id` costs ~24 bytes more per index entry than an ObjectId;
  store as BSON Binary subtype 4 (16 bytes) if index size becomes the constraint.
- **Time-series collections cannot have unique indexes.** Never put `usage` in one —
  `idempotencyKey` would stop protecting you silently.
- **64-index cap per collection.** The generator enforces a budget *and* drops
  orphans first, or removed `indexedAttrs` entries drift toward the cap forever.

---

## 8. Storage strategy

This is columnar design. `attrs`/`metrics` as maps, sparse wide table, sort by
`(tenant, kind, name, time)` — that's a ClickHouse table shape. Mongo provides
none of the compression, `LowCardinality` dictionaries, or map-scan performance
that makes it sing. Being honest about where the fit is real:

| kind | Mongo verdict | why |
|---|---|---|
| `usage` | **genuine fit** | needs unique constraints, transactional durability, point reads, low volume. ClickHouse is bad at exactly this |
| `state` | **genuine fit** | low volume, point reads by subject, small |
| `error` | **fine** | moderate volume, queried by fingerprint or trace, and the row really is a document (nested frames) |
| `event` | **compromise** | works to order-of tens of millions of docs; degrades on the wide ad-hoc slicing that is the point of product analytics. The rollup primitive (§4.5) is the workaround |
| `span` | **fine at this scale** | keep-all + 90d is comfortable for thousands of users. The verdict flips to *wrong* at high volume — sampling would return as a workaround for the store, not a decision about the data — which is when this kind routes out first |

**At small-SaaS volume the compromises above are theoretical.** A few million
docs slice fine in Mongo with the registry indexes. The verdicts matter as the
*ordered exit plan*: `span` leaves first, then `event`; `usage`/`state`/`error`
never need to.

The design survives this because **the schema is the contract and storage is a
routing decision**. `emit()` already dispatches per kind, so the migration is
adding a ClickHouse destination for `span` + `event` while Mongo stays system of
record for `error` + `state` + `usage`. No schema change, no re-instrumentation.

That is also the argument for keeping the unified envelope even though it will
not get one unified store.

### Fan-out

Make this schema the canonical wire format; vendor UIs are worth paying for, their
storage is not.

```
emit() ──┬─→ Mongo        (system of record: error + state + usage + rollups)
         ├─→ ClickHouse   (span + event, when volume demands it; unlocks ad-hoc funnels)
         ├─→ Sentry       (kind=error|span)
         ├─→ PostHog      (kind=event|state)
         └─→ Orb/Stripe   (kind=usage, idempotent)
```

---

## 9. Open items

- [x] **Verify the multikey compound sort** with `explain()` — verified
      2026-08-10 against mongod 8.2.6 (mongodb-memory-server): equality
      subject + desc sort, + time range, ascending reverse scan, and `$all`
      two-subject all plan as `LIMIT<-FETCH<-IXSCAN` with **no blocking SORT**
      and 1:1 keys-to-docs examined; multikey dedup returns each row once.
      The one-index claim in §2.5 holds.
- [x] **The ingest surface** — now specified in instrumentation.md: key model
      and trust modes (§2), batch wire protocol with client-generated `_id`s
      (§3), handler pipeline and host adapters (§4). Still open *there*:
      consent UX default-off, IP truncate-or-drop enforcement, offline queue
      caps (instrumentation.md §10).
- [ ] **Ad-hoc N-step funnels** still need a columnar store. The rollup primitive
      covers fixed, named funnels and retention; it cannot answer "any five events
      in any order with property filters" without a scan.
- [ ] **Rollup reconcile, not just backfill.** Rollups are written after the
      event and are not transactional with it, so a crash between the two loses one
      permanently. Needs a periodic job over raw `telemetry`, which also covers
      events emitted before a `rollups` block was added — but note the raw rows may
      have TTL'd out (or been sampled/burst-capped away), so reconcile can only
      repair within what the evidence plane kept. Non-subject families (issues, llm_cost) outlive
      their sources by design; the rollup is then the only surviving record.
- [ ] **Distinct counts.** Users-affected per issue, MAU as one number — an exact
      distinct needs an unbounded set per group. Today: `$group` over the bucketed
      `activity` family (§5.4). If that gets hot, add an HLL sketch field to
      `TelemetryRollup`; never approximate it with `count`.
- [ ] **Identity stitching.** Backfilling `user` onto pre-login rows carrying only
      an `anon` subject rewrites `subjectKeys`, `otherPrincipals`, *and* rollup
      `_id`s (the subject dim is in the key). Needs a bounded batch job, not a
      hook. Its input now exists — `identify()` writes `telemetry_aliases`
      (instrumentation.md §5); the job itself is still unwritten.
- [ ] **Source map upload** keyed on `release` + `client.appVersion`, or
      `error.frames` stay minified.
- [x] **Clock skew** — resolved at the ingest boundary: the handler computes
      `clockSkewMs` from the batch's `sentAt` vs `receivedAt` and corrects
      `occurredAt` by it before validation and rollups run
      (instrumentation.md §3). Server-origin records trust their own clock.
- [ ] **Invoice reconciliation.** Compare `usage` totals against provider invoices
      on a schedule; a drift alert is the only real proof the metering path works.
- [ ] **Erasure index cost.** `otherPrincipals` adds a second multikey index to the
      largest collection. If insert throughput becomes the constraint, drop the
      index and let `forget()` do a background scan — erasure SLAs are measured in
      days, not milliseconds.
- [ ] **`data` policy.** Currently registry-declared-or-unstored, which is what
      makes §4.7 a guarantee rather than best-effort. Loosening it forfeits that.

---

## 10. Coverage matrix

Storage-model evaluation per use case, **assuming dashboards aggregate at query
time** — no precomputation beyond the write-time rollups that already exist.
Each axis grades the stored shape only: is the grain right, are the dimensions
present and typed correctly, do the rows live long enough, and can a query-time
aggregation over them come back at dashboard latency. Not graded: any UI.

Calibrated for the actual deployment target — small SaaS, thousands of users,
order-of millions of rows — not a hypothetical billion-event future. §8 keeps
the exit plan for growth.

✔ fits · ⚠ fits with caveats · ✘ does not fit

| Use case | Grain | Dimensions & indexes | Retention | Query-time cost | Verdict |
|---|---|---|---|---|---|
| **Error monitoring** | ✔ doc per event; `ErrorDetail` holds the grouping key | ✔ `{tenantId, error.fingerprint, occurredAt}`; `release`, `route`, `ClientContext`, trace join | ✔ raw 90d for debugging; `issue` family carries history forever | ✔ low volume, indexed group-by; storms burst-capped per fingerprint with exact counts preserved (§4.6) | **Strong** |
| **Application metrics** | ✔ request/operation measures on spans + events, kept 100%; ⚠ still no gauge/counter kind — ops TS stays out of scope | ✔ numeric `metrics` map; `indexedAttrs` for slicing, `indexedMetrics` for ranges | ✔ spans 90d, events 730d, per-name override | ✔ percentiles/distributions straight off unsampled raw (§5.3); `hour`-bucket rollups for anything hotter | **Good** (business + request metrics) |
| **Usage tracking** | ✔ row per billable consumption; unique `idempotencyKey` is storage-level dedupe, and it gates aggregation too (§4.6) | ✔ `meter`, `billedTo`, `priceVersion` + declared attrs (`gen_ai_request_model`, `feature`) | ✔ immortal | ✔ tiny volume; `{tenantId, usage.meter, occurredAt}` range → group | **Strong** |
| **Analytics** | ✔ doc per event; multi-party `subjects`, actor split out | ✔ declared attrs indexed for equality, declared metrics for ranges; ⚠ unbounded / nested dims → `data` by design, unindexed | ✔ 730d | ✔ at this volume even undeclared-attr slices are bounded scans behind `{tenantId, name, occurredAt}`; ✘ only genuinely exploratory wide slicing (§8) | **Good** |
| **Journey / funnels** | ✔ events + `kind=state` (`from`/`to`/`previousSinceMs` is a real journey primitive) + per-subject stream | ✔ `session` subject convention declared (§2.3); ⚠ anon→known stitching still a batch job (§9) | ✔ raw 730d; milestone/activity families immortal | ✔ one subject's journey = single `{tenantId, subjectKeys, occurredAt}` range scan; ✔ fixed funnels/retention off rollups; ⚠ ad-hoc N-step = raw group-by-user, feasible at this volume, slow if it becomes routine | **Good fixed, fair exploratory** |

### Where query-time aggregation is not enough

Three questions cannot be computed at query time at all, because the raw rows
TTL out (or are capped) before the question's window closes. There the
write-time rollup is not an accelerator — it is the only surviving storage:

1. **Error-group history past 90d** ("first seen in which release") → `issue` family.
2. **Spend by model/feature past span retention** → `llm_cost` family.
3. **First-ever per subject past 730d** (cohort anchors) → milestone families.

Everything else in the matrix is honestly computable at query time; rollups
there just make dashboards cheap. The inverse rule also holds: rollups are
recorded before sampling and the burst cap (§4.6), so if a number exists in both
planes, the rollup is the exact one.

### Out of scope by design

Free-form **logs** (the registry's pre-declared-names contract is what makes
erasure and cardinality hold — do not bend it; Loki/CloudWatch, join on
`traceId`), **ops-resolution time series** (Prometheus; the rollup bucket floor
is `hour`, and `minute` would be the wrong store), **flame
graphs** (aggregate-native, not document-shaped; dedicated profiler, correlate
via `traceId`). The **trace model** itself is sound — §8 routes span storage to
ClickHouse when volume demands, with zero re-instrumentation.

The pattern in one sentence: **strong wherever a record is a document with
identity, money, or derived state attached** (errors, usage, journeys) —
**deliberately weak where the workload is a specialized store's physics**
(log search, sub-minute time series, flame graphs, columnar scans), where the
answer is correlation via `traceId`, not schema extension.
