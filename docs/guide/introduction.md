# Introduction

Product analytics, error tracking, and usage metering sell three different UIs
over substantially the same record:

> something happened, at a time, caused by someone, about someone, with
> properties and numbers attached.

Errors add a stack trace. Spans add a duration and a parent. State transitions
add a from/to. Usage adds an idempotency key and a billing target. The envelope
is shared; the extensions are sparse. So this package stores one envelope in one
Mongo collection, discriminated on `kind`, driven by a registry your application
owns.

Three vendors, three SDKs, three retention policies, and three answers to "who
is this about" is the normal cost of that split. The bill for a small SaaS is
not mainly money — it is that the question *"what did this feature cost us, and
did the accounts that hit it convert?"* spans all three products and can be
answered by none of them.

## What it is not

Stating this first, because the scope is narrow on purpose ([build plan
§10](https://github.com/JeffJassky/telemetry/blob/main/plans/build-plan.md)):

- **Not an APM.** No profiling, no gauges, no ops time series — no `minute`
  bucket, no RED metrics. Spans exist to attribute work and cost inside a trace,
  not to replace your infrastructure monitoring.
- **Not a log aggregator.** There is no free-form log stream. `body` exists for
  the prose attached to a record, capped and marked; it is not a place to pipe
  stdout.
- **Not a warehouse.** Ad-hoc N-step funnels over raw events are a ClickHouse
  job. What this package answers is the set of questions you declared in
  advance, exactly, from aggregates it maintained on write.
- **Not session replay, not an issue tracker.** Error grouping is here; status,
  assignee, and workflow are host data.
- **No components in your tree.** The dashboard is a router you mount, not a
  React component you import. Your app can be Vue, Svelte, or server-rendered.
- **No schedulers.** The package ships jobs; your host schedules them.

Sized for small SaaS — thousands of users, not billions of events. That
calibration is why sampling ships dormant (everything is kept at rate 1) and why
exactness beats extrapolation everywhere it can.

## Why one envelope beats five collections

The alternative design is one collection per kind: `events`, `errors`, `spans`,
`state_changes`, `usage_records`. It looks tidier, and it loses on every question
that matters.

**A trace crosses kinds.** A single request produces spans, an error, and a
usage row. Reading it back from five collections is five queries and a merge you
write by hand — and the sort order across them is yours to get right. Here it is
one indexed read on `traceId`.

**A subject's journey crosses kinds.** "What happened to this account" is signups
(event), a lifecycle transition (state), a failed export (error), and what they
were billed (usage), interleaved in time. One multikey index on
`{tenantId, subjectKeys, occurredAt}` answers it.

**Erasure crosses kinds.** Five collections means five delete paths, and a
guarantee is only as good as the one somebody forgot to add when they added a
sixth collection. `forget()` walks one envelope.

**And the tidiness is fake.** The fields five collections would not share are
`error`, `state`, `usage`, `durationMs`/`parentId` — four sparse subdocuments.
Everything else — identity, origin, correlation, payload, retention, sampling,
redaction — is common to all five, and in the split design it is common code
copied five times. Mongo discriminators give the sparse extensions their own
required-field validation and their own indexes (partial-filtered to their kind)
without any of that duplication.

What one collection costs you is stated too: every kind shares an index budget
and a document ceiling, so both are bounded explicitly rather than left to
accrete. See [Data model](/guide/data-model).

## Why the registry is host-owned

This package ships **no event names**. Not a starter set, not a
`page_view` convention, nothing. You write a `defineRegistry({...})` block in
your own code and pass it to `createTelemetry()`.

That is not minimalism, it is where the leverage is. One registry file drives
four things that are otherwise four independent chances to drift:

1. **Validation** — attrs and metrics are parsed against your zod schemas at
   write time; an unregistered name is quarantined, never stored.
2. **TypeScript** — `emit()` and the client's `track()` are typed against your
   registry, so a typo in an event name is a compile error rather than a chart
   that is quietly missing a fifth of its data.
3. **Rollups** — the aggregates are declared next to the event that feeds them,
   and maintained on write.
4. **Indexes** — `indexedAttrs` / `indexedMetrics` build real partial compound
   indexes at boot, and orphans from a removed entry get dropped.

A package-owned vocabulary would have to be either so generic it constrains
nothing, or so opinionated that every host with a different noun for "account"
starts lying to it. The one place this package *did* ship a closed list — the
client `platform` enum — turned out to be the one place a host had to lie, so
it is now extensible too ([Configuration](/guide/configuration)).

The corollary is that misconfiguration must fail loudly and early. `createTelemetry()`
runs `validateRegistry()` at construction: a bad dimension source, a rollup family
declared with two different shapes, an `indexedAttrs` key that is not in `attrs`
— all throw at boot. Misconfiguration fails deploy, not dashboards.

## The five kinds

| kind | adds | sampled | default retention |
|---|---|---|---|
| `event` | nothing — the envelope suffices | no | 730d |
| `error` | `error` (type, message, fingerprint, frames) | no — raw storage burst-capped per fingerprint instead | 90d |
| `span` | requires `traceId`, `spanId`, `durationMs` | no (machinery dormant) | 90d |
| `state` | `state` (key, from, to, `previousSinceMs`) | no | 730d |
| `usage` | `usage` (meter, quantity, Decimal128 `amount`, `idempotencyKey`, `billedTo`) | **never** | forever |

Retention and sampling are per-kind *defaults*; any registry entry overrides
both. Rollups run before the sampling verdict and before the burst cap, so
derived aggregates are exact regardless of either.

## Where to go next

- [Quickstart](/guide/quickstart) — install, registry, first `emit()`, mounted
  routers, in about ten minutes.
- [The registry](/guide/registry) — the page to actually read. Everything else
  is downstream of it.
- [Data model](/guide/data-model) — the envelope field by field, and why each
  field is where it is.
- [Emitting records](/guide/emit) — the two-plane write path, outcomes,
  idempotency, durability.
- [Erasure](/guide/erasure) — what `forget()` guarantees and why `data` is
  dropped unless declared.
