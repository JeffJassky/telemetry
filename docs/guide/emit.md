# Emitting records

`t.emit(name, doc)` is the only write. Everything else in the package —
[rollups](/guide/rollups), the [dashboard](/guide/dashboard),
[erasure](/guide/erasure) — reads what emit produced.

```ts
import mongoose from 'mongoose';
import { z } from 'zod';
import { createTelemetry, defineRegistry } from '@jeffjassky/telemetry';

const registry = defineRegistry({
  'report.shared': {
    kind: 'event', origin: 'server', subjects: ['user'],
    attrs: z.object({ format: z.enum(['pdf', 'csv']) }),
    description: 'A report was shared with someone',
  },
  'ledger.charge': {
    kind: 'span', origin: 'server', subjects: ['org'],
    metrics: z.object({ amount_usd: z.number() }),
    durable: true,
    description: 'The cost ledger — the caller awaits this row',
  },
  'billing.ai_tokens': {
    kind: 'usage', origin: 'server', subjects: ['org'],
    description: 'Billable token consumption',
  },
});

const t = createTelemetry({ registry, connection: mongoose });
await t.syncIndexes();

const r = await t.emit('report.shared', {
  tenantId: 'tn_1',
  subjects: [{ type: 'user', id: 'u_1' }],
  attrs: { format: 'pdf' },
});
r.outcome; // 'queued'
```

`name` must exist in the [registry](/guide/registry); `attrs` and `metrics` are
typed from that spec's zod schemas. Everything else on the envelope is described
in [Data model](/guide/data-model) and [Types](/reference/types).

## The two planes

A record passes through two independent decisions, and the whole write path is
organised around keeping them independent.

1. **The aggregate plane** — the [rollups](/guide/rollups) declared on the spec.
   They see every *valid* record, unconditionally.
2. **The evidence plane** — the raw row in Mongo. Subject to sampling and the
   burst cap.

Sampling and capping are decisions about whether to store *evidence*, not about
whether the thing *happened*. So they must never bend an aggregate. A sampled-away
record still moves its rollup; a burst-capped error storm still counts every
occurrence on the issue family. That is why a dashboard built on rollups stays
exact under a cap that keeps the raw collection bounded.

Invalid records reach **neither** plane. Hydration and validation run once, up
front, for every record — kept, sampled, or capped alike — so the aggregate plane
never sees an under-derived or unvalidated document.

## The inversion, and the single rule behind it

The plane order above reverses for two cases, and both are the same rule:

> **When the INSERT is the dedupe, the insert must gate aggregation too.**

That covers `kind: 'usage'` (whose `usage.idempotencyKey` carries a unique index)
and any record carrying a `dedupeKey` (unique per `(tenantId, dedupeKey)`). For
those, emit saves first and rolls up only if the insert won. A duplicate returns
having aggregated **nothing** — that is the entire point.

Idempotency that still lets rollups run twice does not fix the bug. A retried
usage row is the same money; a redelivered webhook is the same event. If the row
is deduped but the rollup increments anyway, the row count is right and every
number derived from it is wrong — which is the failure mode this package exists
to prevent.

The [ingest router](/guide/ingest) inverts for the same reason: wire delivery is
at-least-once, so the client-generated `_id` is the dedupe, and a duplicate drops
without rolling up.

## `dedupeKey`

`dedupeKey` is caller idempotency for the four non-usage kinds. It exists for
duplicates that are **guaranteed, not hypothetical**:

- a Stripe webhook redelivery — a key of `stripe:<event.id>`
- a nightly lifecycle diff that re-derives the same day —
  `lifecycle:<accountId>:<day>`
- a bridge or importer that rewinds its watermark by design (see
  [`t.checkpoint()`](/reference/factory))

```ts
await t.emit('report.shared', {
  tenantId: 'tn_1',
  subjects: [{ type: 'user', id: 'u_1' }],
  attrs: { format: 'pdf' },
  dedupeKey: `stripe:${event.id}`,
});
```

It is for **trusted server callers only**. The wire path does not accept it — a
browser dedupes on its client-generated `_id` instead.

Three things about its shape are deliberate:

**It is a stored, indexed field, not an `_id` passthrough.** `_id` is a UUIDv7 and
doubles as insertion order; every reader that sorts on `_id` depends on that.
Letting a caller supply an arbitrary string as `_id` would break the invariant for
everyone to save one index.

**It is tenant-scoped.** The unique index is `{ tenantId, dedupeKey }` with a
partial filter on `dedupeKey` existing. The same key under another tenant is a
different fact. The partial filter is load-bearing: without it, every record
*without* a `dedupeKey` would index `null` and the second one would collide.

**It implies `forceKeep`.** A record with a `dedupeKey` is never sampled and never
burst-capped. Sampling away a record whose rollup is gated on its own insert loses
the *count*, not just the evidence — the aggregate would silently drop the record
rather than merely drop the row.

A malformed `dedupeKey` (empty, non-string, over 200 chars) is rejected and
quarantined rather than ignored. A silently dropped key is a duplicate row.

## `durable`

By default a non-gated write is fire-and-forget: emit validates, aggregates,
starts the save, and returns `queued`. `durable` changes that — the save is
awaited with `{ w: 'majority', j: true }` and a failure is rethrown to the caller.

**Its rollups are awaited too.** `durable` exists to remove the gap between "the
emit resolved" and "the data is readable", and a host that awaited the row and
then read the aggregate would otherwise hit that same gap one plane over. So a
`written` from a `durable` emit covers both planes.

Declare it on the spec when every caller of that name needs it:

```ts
'ledger.charge': {
  kind: 'span', origin: 'server', subjects: ['org'],
  metrics: z.object({ amount_usd: z.number() }),
  durable: true,
  description: 'The cost ledger — the caller awaits this row',
},
```

…or per call, which overrides the spec:

```ts
const r = await t.emit('ledger.charge', {
  tenantId: 'tn_1',
  subjects: [{ type: 'org', id: 'o_9' }],
  traceId, spanId, durationMs: 812,
  metrics: { amount_usd: 4.5 },
  durable: true,
});
r.outcome; // 'written' — the row AND its rollups are on disk, queryable now
```

`kind: 'usage'` is durable unconditionally, with or without the flag — which is
the case that matters most, because usage rollups are money and an invoice read
that has to guess whether the spend total landed is the bug `durable` exists to
close.

**What it costs:** a majority-acknowledged, journaled round trip on the emitting
request, plus one more round trip per declared rollup family, plus an exception
you now have to handle. That is the right trade for a cost ledger and the wrong
one for a page view — which is why the non-durable path is unchanged and still
returns the moment the aggregate writes are *started*.

**Why `t.flush()` is not a substitute.** `flush()` awaits *every* in-flight write
in the process, so a host that calls it to make one row durable serializes a busy
worker behind unrelated traffic — and it still gives no per-record failure. It is
for tests and SIGTERM handlers ([Testing](/guide/testing)), not for the write
path.

`durable` is a routing instruction, not data: it never lands on the stored
document. `dedupeKey` is the opposite — it is stored, because the index is the
dedupe.

## `EmitResult`

`emit()` returns what actually happened. A `Promise<void>` could not distinguish
"written" from "queued" — it meant *written* for `usage` and *queued* for the
other four kinds, and callers had no way to tell.

```ts
interface EmitResult {
  id: string;
  outcome: 'written' | 'queued' | 'deduped' | 'sampled' | 'capped' | 'rejected';
}
```

`id` is the record `_id`, minted before any decision, so it is usable for
correlation **even on the paths that store nothing**.

| Outcome | What happened | What the caller can conclude |
|---|---|---|
| `written` | The row is durably in Mongo, awaited — **and on a `durable` emit, its rollups too** | The row is queryable now, no `flush()` needed. So are its rollups when the emit was `durable` (which is every `usage`). A `dedupeKey` write on a non-durable spec awaits only the row. |
| `queued` | Validated and aggregated; the save is in flight | Aggregates are already correct. The row is a promise — `await t.flush()` before asserting on it. |
| `deduped` | The `dedupeKey` / `usage.idempotencyKey` already existed | Nothing written, **nothing aggregated**. The original record stands. Counted in `counters.deduped`. |
| `sampled` | The evidence plane declined | Aggregates were still updated. No raw row exists. Counted in `counters.sampled`. |
| `capped` | The burst cap declined | Aggregates were still updated. No raw row exists. Counted in `counters.capped`. |
| `rejected` | Unregistered name, or validation failed | Nothing written, nothing aggregated. The payload is quarantined in the rejects collection. Counted in `counters.rejected`. |

A rollup that *fails* is the one thing `written` does not promise. It is
quarantined and counted, exactly as on every other path, rather than rethrown:
the row is already on disk by then, and turning a failed aggregate into an
exception would tell the caller nothing was written when something was. Those
land in `counters.rejected` and the rejects collection, as always — visible on
the System page rather than silent.

Two paths **throw** instead of returning:

- A `durable` write whose save fails. The failure is quarantined first, then
  rethrown — money failures are never fire-and-forget.
- An invalid `kind: 'usage'` record. It quarantines and rethrows: a caller
  building an invoice has to know.

Everything else — including a `tenantId` of `'*'`, which is
[reserved](/guide/configuration) for the dashboard's cross-tenant read scope —
quarantines and returns `rejected` rather than throwing. Hosts call `emit()`
fire-and-forget, and an unhandled rejection on attacker-shaped input is a way to
stop the process.

Note that on the insert-gated path the save is awaited whether or not `durable`
was asked for, because gating requires it. So `usage` and `dedupeKey` writes
report `written`, never `queued`; `durable` adds the write concern, the rethrow,
and the awaited rollups on top. A `dedupeKey` write on a non-durable spec is
therefore the one `written` whose rollups are still in flight — add
`durable: true` to the call or the spec if you need to read the aggregate
straight after.

## The burst cap

`EventSpec.burst` caps **raw rows** per resolved key per minute. Rollups still see
every record.

```ts
'error.unhandled': {
  kind: 'error', origin: 'any', subjects: [],
  burst: { key: 'field:error.fingerprint', maxPerMinute: 60 },
  rollups: [{ as: 'issue', by: ['field:error.fingerprint'], retentionDays: null }],
  description: 'Uncaught exception',
},
```

A client stuck in a retry loop stores 60 rows a minute for that fingerprint and
counts all 10,000 on the `issue` family. The key isolates groups: a storm on one
fingerprint never starves another. Omit `key` to cap the name whole.

The buckets are per process and reset on a rolling minute; the map is cleared
wholesale past 10,000 distinct keys. It is a storm cap — approximate on purpose,
not an SLA.

**The money exemption.** A record carrying `metrics.cost_usd` is never capped.
The `usage` → `span` join outranks storm control, and money volume is bounded by
spend anyway. `kind: 'usage'`, errors, and anything with `forceKeep: true` or a
`dedupeKey` bypass both sampling and the cap for the same family of reasons.

## Sampling

`SAMPLE_RATE` ships at `1` for every kind — the machinery is present and dormant.
Turn a kind down there, or one name via `EventSpec.sampleRate`, when volume ever
demands it.

The verdict is consistent per trace: `traceKeep(traceId, rate)` hashes the
traceId's low 32 bits, so a whole trace is kept or dropped together rather than
shredded. A traceId with no parseable hex tail would silently degrade to
per-record sampling and invalidate every per-trace aggregate, so it throws in dev
and falls back to `Math.random()` in prod.

Kept rows are stamped with the `sampleRate` in force, which is what lets
[`series()`](/guide/queries) extrapolate counts by `1/sampleRate` — exact while
rates sit at 1, still honest the day one drops. Forced rows are stamped
`forced: true, sampleRate: 1` and are therefore *not* representative of the
sampled population; a ratio computed over them is a ratio over a biased sample.

## Nothing drops silently

Every path that declines to store something increments a counter and, where there
is a payload, quarantines it.

| Counter | Incremented when |
|---|---|
| `rejected` | unregistered name, validation failure, reserved tenant, undeclared `data` dropped |
| `sampled` | the sampling verdict declined the row |
| `capped` | the burst cap declined the row (also: ingest rate-limited records) |
| `deduped` | an insert-gated write hit an existing key |
| `rollupSkipped` | a non-subject dim resolved empty with no `dimDefault` — see [Rollups](/guide/rollups) |
| `defaulted` | `service` or `release` was missing and stamped `unknown` |
| `truncated` | a `body` was clipped to `BODY_MAX_CHARS` (16384) and marked |

Three places to look:

- **`t.counters`** — a plain object. Surface it on your `/metrics` endpoint.
- **`<collection>_rejects`** — the quarantine, holding `{ at, name, reason, raw }`
  with the payload as sent. It has a 30-day TTL, built by `t.syncIndexes()`.
  Reachable as `t.collections.rejects()`, and inside the
  [erasure](/guide/erasure) boundary.
- **The dashboard's System page** — counters, the last 50 quarantined records, and
  the index budget, in one screen.

`body` is the one field that is clipped rather than dropped: it is prose, where a
marked prefix (`… [truncated N chars]`) beats nothing. `data` is the opposite —
an out-of-bounds or undeclared object is dropped whole, because a partial
structured payload is a lie about what the caller sent.

## Where to go next

- [The registry](/guide/registry) — what you may emit, and the boot-time checks
- [Rollups](/guide/rollups) — the aggregate plane in detail
- [Ingest & keys](/guide/ingest) — the same write path over the wire
- [Testing](/guide/testing) — `flush()`, `syncIndexes()`, and asserting on counters
