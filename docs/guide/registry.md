# The registry

The registry is the single contract. It drives validation, TypeScript types,
derived rollups, and index creation — and it is **host-owned**: this package
ships no event names, and never will. You author the registry in your own code
and pass it to [`createTelemetry()`](/guide/configuration#registry-required).

If you read one page in this guide, read this one. Everything else is downstream.

## `defineRegistry()`

```ts
import { z } from 'zod';
import { boundedMeta, defineRegistry } from '@jeffjassky/telemetry';

export const REGISTRY = defineRegistry({
  'account.signed_up': {
    kind: 'event',
    origin: 'server',
    subjects: ['account'],
    attrs: z.object({ source: z.string().max(64) }),
    indexedAttrs: ['source'],
    rollups: [{ by: ['subject'], subjects: ['account'], capture: ['attr:source'] }],
    description: 'Account created',
  },
});
```

`defineRegistry` is an identity function with a `const` type parameter. It
returns exactly what you gave it; the `const` is the entire point, because it
keeps the literal shapes so that `t.emit('account.signed_up', …)` knows this
event takes `attrs: { source: string }` and no other keys.

It does **not** validate. `createTelemetry()` calls `validateRegistry()` for you
at construction; call it yourself in a unit test if you want the failure before
you have a database:

```ts
import { validateRegistry } from '@jeffjassky/telemetry';
validateRegistry(REGISTRY);   // throws on misconfiguration
```

Naming is a convention, not a rule: `noun.verb_past_tense`
(`account.signed_up`, `llm.completion`, `error.unhandled`). Dots in event names
are fine. Dots in *attr and metric keys* are not — they are rewritten to
underscores before storage, because mongoose `Map` keys cannot contain them.
Declare `gen_ai_request_model`, not `gen_ai.request.model`.

## `EventSpec`, field by field

```ts
interface EventSpec {
  kind: 'event' | 'error' | 'span' | 'state' | 'usage';
  origin: 'server' | 'client' | 'any';
  subjects: readonly string[];
  attrs?: z.ZodObject<any>;
  metrics?: z.ZodObject<any>;
  data?: z.ZodType<any>;
  indexedAttrs?: readonly string[];
  indexedMetrics?: readonly string[];
  rollups?: readonly RollupSpec[];
  retentionDays?: number | null;
  sampleRate?: number;
  burst?: { key?: DimSource; maxPerMinute: number };
  durable?: boolean;
  description: string;
}
```

### `kind` — required

One of the five. It picks the discriminator model, the required extension
subdocument, the default retention, and the write-path behaviour:

- `span` requires `traceId`, `spanId` and `durationMs` on every record.
- `state` requires `state.to`.
- `error` requires `error` with `type`, `message` and `fingerprint`.
- `usage` requires `usage` with `meter`, `quantity`, `unit`, `idempotencyKey`
  and `billedTo`, is never sampled, is always durable, and never expires.
- `event` requires nothing beyond the envelope.

Requiredness is enforced in the schema hook rather than left to mongoose's
discriminator merging, so it holds identically across mongoose 7, 8 and 9.

A record whose `kind` disagrees with the spec is a hard error:
`telemetry: "llm.completion" is kind=span`.

### `origin` — required

`'server'`, `'client'`, or `'any'`. Two things hang off it.

A `client`-origin spec **requires** `client` context on every record — a record
without it throws. That is what makes "browser events always have an app version
and a platform" a schema guarantee instead of a code review comment.

And it is half of the trust split on the wire: a publishable key cannot write a
server-origin name. An account can be told it signed up by the browser; it
cannot talk itself into `account.converted`. See [Ingest & keys](/guide/ingest).

### `subjects` — required

The subject **types** that must be present on every record — not ids, types.
`subjects: ['account']` means every record of this name must carry at least one
`{ type: 'account', id: … }`; a record without one throws.

An empty array is legitimate and common for infrastructure-ish records:

```ts
'error.unhandled': { kind: 'error', origin: 'any', subjects: [], /* … */ }
```

Multiple parties are the normal case, not an edge case: an admin impersonating a
user, a sender and a recipient, a user inside an account inside a session. Pass
as many as apply, and use `role` to disambiguate two of the same type.

### `attrs` — string dimensions

A `z.object()` whose values are **strings**. Not "should be" — mongoose casts
`attrs` to `Map<string, String>` on assignment, so a number you put in comes back
out as a string. Use `z.string()`, `z.enum([...])`, or `z.coerce.*` if the caller
has a number and you want a dimension out of it. Numbers belong in
[`metrics`](#metrics-numeric-measures).

The schema is parsed in **strict** mode, so an undeclared key is a validation
failure, not a silently stored extra. And if a record passes `attrs` for a spec
that declares none at all:

```
telemetry: "page.view" declares no attrs
```

That strictness is what makes the dimension set knowable, which is what makes
breakdowns and indexes possible.

### `metrics` — numeric measures

Same shape, cast to `Map<string, Number>`. These are the values rollups can
`sum`, the dashboard can chart, and `indexedMetrics` can range-query.

One metric name is special by convention: `cost_usd`. A record carrying it is
never sampled and never burst-capped, because the usage→span cost join must not
dangle. It remains a lossy BSON double — authoritative money is
`usage.amount` (Decimal128). See [Data model](/guide/data-model#usage).

### `data` — the unstructured escape hatch, declared

**`data` is dropped unless the spec declares a schema for it.** Not stored,
counted in `counters.rejected`, no error. That is the rule that turns erasure
from best-effort into a guarantee: there is no untyped corner of the envelope
where an email address can hide from `forget()`.

Declaring a real schema is best:

```ts
data: z.object({ route: z.string().max(200), referrer: z.string().max(500).optional() }),
```

When you genuinely want a bag of properties — and the ceremony of a schema per
event is what stopped the last three attempts at instrumenting anything — use
`boundedMeta()`.

### `boundedMeta()`

```ts
import { boundedMeta } from '@jeffjassky/telemetry';

'page.view': {
  kind: 'event', origin: 'client', subjects: ['user', 'account', 'session'],
  data: boundedMeta(),
  retentionDays: null,
  description: 'Navigation telemetry',
},
```

A zod schema encoding one specific shape guard:

- **scalars only** — string, finite number, boolean, `null`
- **≤ 12 keys** at the top level
- **strings ≤ 200 characters**
- **one nesting level** — a nested object may itself hold ≤ 12 scalars; arrays
  may hold ≤ 20 scalars
- **≤ 4096 bytes** serialized

Everything outside those bounds is rejected. Parsing never throws.

**The rule that matters: it drops the WHOLE object, never truncates.** A `data`
payload that violates any bound resolves to `undefined`, the record is still
written, and `counters.rejected` increments.

This is deliberate and it is the opposite of what `body` does. A truncated
structured payload is a lie about what the caller sent — a reader cannot tell a
`data` object with eleven keys that arrived that way from one that arrived with
thirty. So a stored `data` is *always exactly* what the caller sent, and a
missing one is visible in a counter. `body`, being prose, inverts this: it is
clipped with a visible marker, because a marked prefix of a log line is more
useful than nothing.

::: warning `data` inherits a TTL you did not choose
A spec that declares `data` and says nothing about `retentionDays` inherits the
per-kind default — 730 days for `event`, 90 for `span` and `error`. Evidence you
went out of your way to declare gets a fuse nobody chose.

`createTelemetry()` warns once per offending entry at boot **through your
logger**, which means the default no-op logger swallows it. And `expiresAt` is
stamped **per row at write time**, so it is unrecoverable after the fact: rows
already written carry their expiry, and changing the spec later does not reach
them.

Set an explicit `retentionDays` — including `null` for immortal — to choose, and
to silence the warning. The warning is about not having made a choice, not about
the choice.
:::

### `indexedAttrs` / `indexedMetrics`

Keys that get a real partial compound index built at boot:

```
{ tenantId: 1, attrs.<key>: 1, occurredAt: -1 }   partialFilterExpression: { name }
{ tenantId: 1, metrics.<key>: 1, occurredAt: -1 } partialFilterExpression: { name }
```

Every payload index is tenant-prefixed and time-sorted, and the partial filter
pins `name` so the index covers only that event's rows. **A query must include
`{ name }` to use it.**

Both keys must be declared in the corresponding schema — `indexedAttrs: ['plan']`
with no `plan` in `attrs` throws at boot.

Why not a wildcard index on `attrs`? Because a wildcard cannot compound with
`tenantId` (before Mongo 7.0), so every attr query would scan across every
tenant — a performance problem and precisely the isolation hole `scoped()`
exists to close. Attrs are bounded and declared, so pay for targeted indexes
instead of insert cost on everything.

#### The index budget

```ts
import { INDEX_BUDGET } from '@jeffjassky/telemetry';   // 24
```

Mongo caps a collection at 64 indexes. The base envelope and the discriminators
use about ten. The remaining budget for registry-driven payload indexes is 24,
and `syncIndexes()` throws if your registry plans more:

```
telemetry: 27 payload indexes exceeds budget 24
```

`syncIndexes()` drops orphaned `attr_*` / `metric_*` indexes **before** the
budget check, on purpose: if the check ran first, removing an entry to get back
under the cap would still throw, and the stale index would never be dropped —
unrecoverable without going into the shell.

Undeclared attrs stay queryable. A `$match` on `{tenantId, name, occurredAt}`
first bounds the scan to one event's rows in one tenant's time window, which is
fine for ad-hoc work at this scale. Index the dimensions you group by every day,
not every dimension you might ever filter on.

### `rollups`

Derived aggregates maintained on write, declared next to the event that feeds
them. One primitive covers milestones, error-issue grouping, windowed spend, and
activity/retention streams:

```ts
rollups: [
  // lifetime milestone — one doc per account, firstAt IS the milestone timestamp
  { by: ['subject'], subjects: ['account'], actors: ['user', 'system'], capture: ['attr:source'] },
  // daily activity — one doc per (account, day), so the doc count IS the DAU
  { as: 'activity', by: ['subject'], subjects: ['account'], bucket: 'day', retentionDays: 730 },
]
```

`RollupSpec` gets its own page: [Rollups](/guide/rollups). Two things belong
here, because they are validation rules rather than modelling advice.

**Dimension sources** are `'subject'`, `` `attr:${string}` `` or
`` `field:${string}` ``. `subject` fans the rollup out over matching subject
refs; the others read one value off the record (`field:error.fingerprint`,
`field:release`). Anything else fails at boot.

**Family shapes are pinned across specs.** Several event names may feed one `as`
family — that is the point of `as`. But every spec feeding a family must declare
the same `by` order, the same `bucket`, and the same `subjects` set, because
`dims` is a positional array: two shapes in one family produce documents whose
position 0 means different things, silently unqueryable.

```
telemetry: rollup family "activity" declared with two shapes: subject|day|account / subject||account
```

`dimDefault` is deliberately *not* part of the shape — it changes which bucket a
record lands in, never what a position means, so two names may feed one family
with different fallbacks.

### `retentionDays`

**Default: the per-kind value** — `event` 730, `state` 730, `span` 90,
`error` 90, `usage` `null` (money is immortal).

Set a number to override, or `null` to make this event immortal. The distinction
between "absent" and "explicitly `null`" is load-bearing and is checked with
`in`, not `??`: absent inherits, `null` means forever.

`expiresAt` is computed per row at write time as `occurredAt + retentionDays`,
and a partial TTL index expires them. Which means:

- Changing `retentionDays` affects **future rows only**. Rows already written
  carry the fuse they were stamped with.
- Lengthening retention does not resurrect anything.
- Rows with no `expiresAt` are not indexed as null — the TTL index is partial —
  so immortal rows cost nothing.

### `sampleRate`

**Default: the per-kind value, which is `1` for every kind.** Everything ships
keep-all: at small-SaaS volume, exactness beats extrapolation, and the stored
`sampleRate` on every row means a future aggregate can weight correctly if you
ever turn it down.

Must be in `(0, 1]` or boot fails. The machinery is present and dormant:
sampling is consistent **per trace**, not per record, so a kept trace keeps all
its spans and a cost rollup over a trace stays valid. A `traceId` with no
parseable hex tail would degrade that to per-record sampling, so it throws in
development rather than skewing data in production.

Sampling only ever declines the **raw row**. Rollups run first, so aggregates are
exact at any rate. Records carrying money, an error, or a `dedupeKey` are forced
regardless.

### `burst`

```ts
burst: { key: 'field:error.fingerprint', maxPerMinute: 60 }
```

A cap on **raw storage** per resolved key, per minute. Omit `key` to cap the
event name as a whole. `maxPerMinute` must be positive; `key` must be a valid
dimension source.

The reason this exists and sampling does not: user count bounds most volume, but
it does not bound a storm. One deploy with a broken import throws the same error
sixty thousand times in a minute, and a client stuck in a retry loop does the
same. Sampling that error kind down to 5% would still store three thousand
copies of one stack trace *and* make every error count wrong.

`burst` is better because rollups still see **every** record. Your issue counts
stay exact — "this fingerprint occurred 60,000 times" — while the collection
stores sixty examples of it. The bucket is per process and approximate on
purpose: it is a storm cap, not an SLA.

Cost-bearing records (`metrics.cost_usd` present) are exempt: the usage→span
join outranks storm control, and money volume is bounded by spend anyway.

### `durable`

**Default: `false`** (and unconditionally `true` for `kind: 'usage'`).

`emit()` is fire-and-forget by default: it validates, updates rollups, and
returns `{ outcome: 'queued' }` with the row save in flight. `durable: true`
awaits the save with `{ w: 'majority', j: true }` and **rethrows** on failure, so
the outcome is `'written'` and a failed write reaches your error handler. It
awaits the record's **rollups** too, so a `written` durable emit means both
planes are readable — awaiting the row and then reading a stale aggregate is the
same race one layer over.

This exists for the host whose cost ledger is a span. Before it, the only way to
await a specific write was `t.flush()`, which drains every in-flight write
globally and serializes a busy worker.

Declare it per event on the spec; override per call with `EmitInput.durable`. The
per-call value wins.

### `description` — required

A sentence. It is required because the registry is the documentation of your
event vocabulary, and the dashboard surfaces derived views from it — an entry
nobody can describe is usually an entry nobody should add.

## What boot-time validation catches

`validateRegistry()` runs inside `createTelemetry()`. Every one of these throws
at construction, with the offending event name in the message:

| rule | message shape |
|---|---|
| unknown `kind` | `unknown kind "evnet"` |
| unknown `origin` | `unknown origin "browser"` |
| `subjects` not an array | ``` `subjects` must be an array of subject types ``` |
| `sampleRate` outside `(0, 1]` | `sampleRate 1.5 outside (0, 1]` |
| non-positive `burst.maxPerMinute` | `burst.maxPerMinute must be positive` |
| malformed `burst.key` | `bad burst key "fingerprint"` |
| `indexedAttrs` key not in `attrs` | `indexedAttrs "plan" not declared in attrs` |
| `indexedMetrics` key not in `metrics` | `indexedMetrics "cost" not declared in metrics` |
| empty rollup `by` | ``` rollup has empty `by` ``` |
| malformed dimension source | `bad dim source "attrs.source"` |
| more than one `subject` dim | `rollup has more than one subject dim` |
| `subject` dim without `subjects` | ``` rollup uses subject without `subjects` ``` |
| empty `actors` array | ``` rollup `actors` must be non-empty when present ``` |
| `dimDefault` empty or containing `\|` or `=` | `rollup dimDefault "a=b" may not contain "\|" or "="` |
| one family, two shapes | `rollup family "activity" declared with two shapes: …` |

Plus, at `syncIndexes()` time, the payload index budget.

### Why this is boot-time and not a lint rule

Every failure above produces data that looks fine. A rollup with two shapes
writes documents happily; you notice when a funnel returns numbers that are
subtly too low. An `indexedAttrs` typo builds no index; you notice when a query
that used to be instant times out at 3 a.m. A `dimDefault` containing `=`
corrupts the rollup `_id` itself, merging two groups into one.

None of those announce themselves. A process that refuses to start does.
Misconfiguration fails deploy, not dashboards — which is only true if the check
runs where deploys can see it, so it runs in the constructor.

## Next

- [Rollups](/guide/rollups) — `RollupSpec` in full: dimensions, buckets,
  captures, actor gates, and the four jobs one primitive does.
- [Data model](/guide/data-model) — where everything the registry validates
  actually lands.
- [Emitting records](/guide/emit) — what happens to a record after it passes.
