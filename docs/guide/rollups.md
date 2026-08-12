# Rollups

A rollup is a derived aggregate maintained on write: group a stream of records by
a declared tuple, keep first / last / count / sums. That is the whole primitive.
It is declared per event in the [registry](/guide/registry) and it does four jobs
that hosts normally build four times:

| Job | Shape |
|---|---|
| **Milestones** — when did this subject first do X | `by: ['subject']`, no bucket. `firstAt` *is* the milestone. |
| **Issue grouping** — how many times has this error fired, and since when | `by: ['field:error.fingerprint']`, `capture` for release/route |
| **Windowed spend** — cost per model per day | `by: ['attr:model'], bucket: 'day', sum: ['cost_usd']` |
| **Activity / retention** — who was active on which day | `by: ['subject'], bucket: 'day'` |

The engine does not know which of the four you asked for. It is one operation.

```ts
'llm.completion': {
  kind: 'span', origin: 'server', subjects: ['org'],
  attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string().max(64) }),
  metrics: z.object({ tokens_in: z.number().int(), tokens_out: z.number().int(), cost_usd: z.number() }),
  rollups: [{
    as: 'llm_cost',
    by: ['attr:gen_ai_request_model', 'attr:feature'],
    bucket: 'day',
    sum: ['cost_usd', 'tokens_in', 'tokens_out'],
    retentionDays: null,
  }],
  description: 'Single model call',
},
```

Rollups run on the aggregate plane, which sees every valid record unconditionally
— a sampled or burst-capped record still moves its rollup. See
[Emitting records](/guide/emit) for the one case where that inverts.

## What a rollup document looks like

```
_id          `${tenantId}|${as}|${dims.join('|')}|${bucketKey}`  — deterministic
tenantId
as           the family
dims         dimension values in spec order
subjectType  denormalized prefix of the subject dim, when there is one
bucketAt     UTC bucket start; absent on lifetime rollups
firstAt      earliest contributing occurrence  ($min)
lastAt       latest                            ($max)
count        contributing records              ($add)
sums         declared `sum` metric keys        ($add)
firstCapture declared `capture` sources, snapshotted at first occurrence
firstTraceId the traceId of the first occurrence
expiresAt    from retentionDays; absent = immortal
```

The `_id` is computed from the key, not generated, which is what makes the write
an idempotent upsert — and what makes "one doc per (subject, bucket)" a
guarantee rather than a hope. [`distinctCount()`](/guide/queries) rests entirely
on that.

Reads go through [`rollups()`, `distinctCount()` and `funnel()`](/guide/queries),
or `t.scoped(tenantId).rollups(...)` for anything ad hoc.

## `by` — dimensions

`by` is an ordered tuple of dimension sources:

- `attr:<key>` — reads `attrs.<key>` off the record
- `field:<path>` — reads a dotted path off the envelope (`field:release`,
  `field:error.fingerprint`)
- `subject` — **fan-out**, not a value read

Order matters: `dims` is a positional array, and every query that slices a family
by dimension value depends on position meaning the same thing in every document.

### Subject fan-out

At most one `subject` dim per spec (enforced at boot). When present, the record is
written **once per matching subject ref** — a record naming a user and an org
writes two docs, one keyed `user:u_1`, one keyed `org:o_9`.

`subjects` is required alongside it and restricts the fan-out to those types:

```ts
rollups: [{ by: ['subject'], subjects: ['account'] }],
```

Subject dims keep their native `type:id` form in `dims`; every other dim is stored
as `label=value`. That is not cosmetic — [`forget()`](/guide/erasure) matches
subject dims by their native form to rekey them, so a subject stored any other way
would be unreachable by erasure.

If a record has no subject matching `subjects`, the rollup is skipped entirely
(no counter — there was nothing to attribute).

## Families and the family-shape rule

`as` names the **family**. Several event names may feed one:

```ts
'account.signed_up':  { /* … */ rollups: [{ as: 'activity', by: ['subject'], subjects: ['account'], bucket: 'day' }] },
'data.first_viewed':  { /* … */ rollups: [{ as: 'activity', by: ['subject'], subjects: ['account'], bucket: 'day' }] },
```

Omit `as` and it defaults to the event name.

Two events feeding one family **must declare the same shape**. Shape is
`by` + `bucket` + the sorted `subjects` list. A mismatch produces documents whose
`dims` array means different things at the same array position — silently
unqueryable, and no query can detect it after the fact. So `validateRegistry()`
throws at boot:

```
telemetry: rollup family "activity" declared with two shapes:
  subject|day|account / subject,attr:plan|day|account
```

Misconfiguration fails deploy, not dashboards.

`dimDefault` is deliberately *not* part of the shape: it changes which bucket a
record lands in, never what a position means, so two names may feed one family
with different fallbacks.

Because the shape is pinned, the *first* declaration of a family speaks for all of
them — which is how `findFamily()`, `requireMilestoneFamily()` and the query layer
can reason about a family without scanning every spec.

## `bucket` vs lifetime

Omit `bucket` and the family is a **lifetime** rollup: one doc per key, forever.
`firstAt` is the milestone; `count` keeps the honest total of how many times it
happened afterwards. This is the shape [funnels](/guide/queries) require.

Declare `bucket` (`hour` | `day` | `week` | `month`) and the family gets one doc
per key per period. Truncation is UTC and weeks start Monday — display timezones
are a rendering concern and never leak into storage. `hour` is for incident-grade
dashboards; anything finer is the wrong store.

The same event usually wants both:

```ts
'data.first_viewed': {
  kind: 'event', origin: 'client', subjects: ['account'],
  rollups: [
    // the milestone — one doc per account, forever
    { by: ['subject'], subjects: ['account'] },
    // the activity stream — one doc per account per day
    { as: 'activity', by: ['subject'], subjects: ['account'], bucket: 'day', retentionDays: 730 },
  ],
  description: 'The dashboard rendered real measured numbers on screen',
},
```

## `sum`

`sum` lists metric keys accumulated with `$add` across every contributing record.
A key absent from a given record contributes nothing rather than zero.

Sums are stored in `sums.<key>`, and they are the reason a spend chart can outlive
its raw spans: the `llm.completion` spans above expire after their retention
window while `llm_cost` is declared `retentionDays: null` and keeps the totals
forever.

## `capture` — cohort dimensions

`capture` snapshots dimension sources at **first occurrence** into `firstCapture`.
That is how a milestone carries the signup source, or an issue carries the release
and route it first appeared on.

```ts
rollups: [{ by: ['subject'], subjects: ['account'], capture: ['attr:source'] }],
```

The upsert is an update pipeline, not `$setOnInsert`, and the difference is the
point. `$setOnInsert` pins the captured values to whichever record **landed**
first. `capture` pins them to whichever record **occurred** first:

```js
firstCapture: { $cond: [isNewFirst, { $literal: firstCapture }, '$firstCapture'] }
```

Those are different records for offline clients that sync late, for backfills, and
for any retry. A late-arriving *earlier* record corrects `firstAt`,
`firstTraceId` and `firstCapture` together — everything, not just the boundaries.

## `actors` — the write-time allowlist

`actors` is a list of actor **types**. A record whose `actor` has a type not on the
list skips this rollup; the raw row is written normally and stays visible in the
explorer.

```ts
rollups: [{ by: ['subject'], subjects: ['account'], actors: ['user', 'system'] }],
```

This is how "admin support browsing must never move a customer aggregate" becomes
a declaration instead of a discipline. A record with **no** actor always passes —
an unattributed record is a customer fact. Absent `actors`, every actor passes.

**The honest tradeoff:** this is aggregation at emit time, so it cannot be undone
at query time. Once a record has been excluded from a family there is nothing in
the rollup to filter, and no query flag can bring it back. Changing the policy
means rebuilding the family from raw records — which is only possible while those
records are still inside their retention window. The raw-row equivalent,
`excludeActorTypes` on [record queries](/guide/queries), *is* a query-time filter,
because raw rows kept the actor.

Choose `actors` when the exclusion is a property of the number (a customer
funnel), and the query filter when it is a property of the question.

## `dimDefault`

A non-subject dim that resolves to `null` or `''` cannot key the document. The
default behaviour is to skip the record and count it in `counters.rollupSkipped` —
an implicit `null` bucket would silently corrupt every group in the family.

`dimDefault` makes that bucket **explicit**: the host names it, so "no value"
becomes a group you can query instead of a drop you have to notice in a counter.

```ts
'checkout.started': {
  kind: 'event', origin: 'client', subjects: ['account'],
  attrs: z.object({ plan: z.string().optional() }),
  rollups: [{ as: 'checkout_by_plan', by: ['attr:plan'], dimDefault: 'none' }],
  description: 'Checkout began, with or without a plan chosen',
},
```

Records with no `plan` now land in `plan=none` rather than vanishing.

`dimDefault` may not contain `|` or `=` — dims are `label=value` and the rollup
`_id` joins them on `|`, so either character corrupts the key itself. Validated at
boot.

It **never applies to the subject dim.** A missing non-subject dim is a record we
can still attribute to someone; a record with no matching subject cannot be
attributed at all. Bucketing it under a placeholder subject would invent a party
that does not exist — and since erasure matches subject dims by their native
`type:id` form, that placeholder would be permanently unreachable by
[`forget()`](/guide/erasure).

## `retentionDays`

Per family. A number stamps `expiresAt` at `occurredAt + days` and a TTL index
removes the doc; `null` or omitted means immortal.

Bucketed families usually want a number — an hourly family accumulates
indefinitely otherwise. Lifetime milestone families and financial aggregates
usually want `null`: deleting a milestone rewrites history for every cohort the
subject was counted in.

Note that `expiresAt` is stamped **per document at write time**, so changing
`retentionDays` later affects new documents only. The same is true of the raw-row
retention discussed in [Data model](/guide/data-model).

## Erasure

[`forget()`](/guide/erasure) **rekeys** rollups carrying the ref as a dimension —
it never deletes them. Deleting a person's rollups retroactively shrinks every
cohort they were counted in, so funnel denominators would change under you.
Aggregates survive; the person does not.

A family grouped on something else — an issue keyed on `error.fingerprint` — never
held an identifier in the first place, which is exactly why non-subject families
are safe to keep forever.

## Where to go next

- [The registry](/guide/registry) — where rollups are declared and validated
- [Queries & funnels](/guide/queries) — reading families back
- [Emitting records](/guide/emit) — the aggregate plane and where it inverts
- [Erasure](/guide/erasure) — rekeying, and why
