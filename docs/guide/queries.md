# Queries & funnels

Everything the [dashboard](/guide/dashboard) renders comes through eight read
primitives. Kind pages never touch Mongo — that seam is what would let `span` and
`event` route to a columnar store later without touching a component.

```ts
import { createQueries } from '@jeffjassky/telemetry';

const q = createQueries({
  TelemetryModel: t.models.telemetry,
  RollupModel: t.models.rollups,
  registry: t.registry,
  onSlowQuery: ({ op, ms, params }) => log.warn('slow telemetry read', { op, ms, params }),
});

const { items, nextCursor } = await q.records('tn_1', { from, to }, { kind: 'error' });
```

`createDashboard()` builds its own instance internally, so most hosts never call
this directly — reach for it when you want the numbers without the UI.

## Scope, not tenant

Every primitive takes a **scope**: a `tenantId`, or `PLATFORM_SCOPE` (`'*'`) for a
cross-tenant read. Under `'*'` the tenant term is dropped from the match and
**nothing else changes** — the time range is still mandatory where it was
mandatory, the caps still apply, and every row-shaped response still carries each
row's own `tenantId`, so a cross-tenant number stays attributable. Do not project
`tenantId` away.

`'*'` is only ever reachable because your
[`viewerAdapter`](/guide/adapters) put it on a `Viewer`. The package never infers
platform admin from a role, a header, or a config flag. It is reserved on the
write side, so no stored row can carry it and "omit the tenant term" is
unambiguous.

`series()` and `distribution()` aggregate **across** tenants under `'*'` — the sum
of every tenant is the number a platform operator came for. A per-tenant
breakdown is a different question; ask it with `rollups()` or by scoping to a
tenant.

For raw model access there is `t.scoped(tenantId)`, whose isolation guarantee is
unconditional: it does not understand `'*'`, so `scoped('*')` matches the literal
string, which is to say nothing.

## The eight primitives

| Primitive | Answers | Time range | Cap | `dataSource` |
|---|---|---|---|---|
| `records` | "show me the rows" — tables, lists, detail drawers | **required** | 200 rows (`limits.records`), keyset cursor | `raw` |
| `series` | "how many per hour/day/week/month" | **required** | 744 buckets (`limits.series`) | `raw` |
| `distribution` | "what does the latency/cost spread look like" | **required** | 100,000 documents (`limits.distribution`) + `truncated` | `raw` |
| `rollups` | "read a family" — issues, spend, activity, milestones | optional | 500 docs (`limits.rollups`) + `truncated` | `rollups` |
| `trace` | "one trace, every kind, one time axis" | **none** | 500 rows (`limits.trace`) | `raw` |
| `journey` | "one subject's whole story" | **required** | 500 records (`limits.journey`) + 100 milestones | `raw+rollups` |
| `distinctCount` | "DAU / WAU / MAU, exactly" | **required** | 100,000 rollup docs (`limits.distinct`) + `truncated` | `rollups` |
| `funnel` | "cohort conversion and time-to-step" | **cohort window required** | 5,000 subjects (`limits.funnel`) + `truncated` | `rollups` |

Every cap is config (`queryLimits` on `createDashboard`, `limits` on
`createQueries`) and every `$limit` lives **inside** the pipeline rather than
being applied to a materialised result. `DEFAULT_LIMITS` is exported if you want
to reason about the shipped numbers.

Two entries in that table deserve their exceptions stated plainly rather than
buried: `trace()` takes no range at all — it is pinned by `traceId`, which is
indexed and bounded by the trace itself — and `rollups()`'s range is optional
because a lifetime family has no time axis to filter on.

`series`, `distribution`, `rollups` and `distinctCount` are memoized in process
for 10 minutes (60 entries, LRU by age; a rejected promise is evicted rather than
cached as the answer). `records`, `trace`, `journey` and `funnel` are not. Expect
a chart to lag a write by up to that window.

### `records`

```ts
q.records(scope, { from, to }, filter?, { limit?, cursor? })
  → { items, nextCursor, dataSource: 'raw' }
```

Paging is keyset on `(occurredAt desc, _id desc)`, never `$skip`. `nextCursor` is
an opaque base64url token; a `null` means the page was the last one.

`RecordFilter` covers `kind`, `name`, `severity`, `env`, `service`, `release`,
`subject` (a `type:id` ref), `traceId`, equality on `attrs`, ranges on `metrics`,
and `excludeActorTypes` — the customer toggle. That last one excludes only *typed*
actors: a record with no `actor` at all is a customer fact and always survives the
filter.

Only attrs and metrics listed in `indexedAttrs` / `indexedMetrics` have a real
index behind them; the rest stay queryable through the `{tenantId, name,
occurredAt}` prefix. See [The registry](/guide/registry).

### `series`

```ts
q.series(scope, { from, to }, filter, { measure?, interval? })
  → { buckets: [{ at, value }], dataSource: 'raw' }
```

`measure` is `'count'` (default), `'sum:<metricKey>'`, or `'avg:<metricKey>'`.
`interval` is `hour` | `day` | `week` | `month`, UTC, Monday-start weeks.

`count` sums `1 / sampleRate` rather than counting documents, so it extrapolates
correctly if sampling is ever turned on. While every rate sits at 1 the two are
identical — the machinery is there so the number stays honest the day one drops.
Note that `forceKeep` rows are stamped `sampleRate: 1` and are therefore *not* a
representative sample of anything.

### `distribution`

```ts
q.distribution(scope, { from, to }, filter, { measure? })
  → { p50, p90, p95, p99, min, max, avg, n, histogram, truncated, dataSource: 'raw' }
```

`measure` defaults to `durationMs`; anything else reads `metrics.<key>`. Documents
missing the field are excluded, and an empty match returns
`{ n: 0, truncated: false, dataSource }` with no percentile keys at all — check
`n` before destructuring. `truncated` is the one key that is always there: a flag
you have to check for is a flag you end up inferring.

The percentiles come from Mongo's `$percentile` with `method: 'approximate'`
(t-digest) over up to `limits.distribution` matching documents, and the histogram
is a 20-bucket `$bucketAuto` over the same ceiling. Because the package keeps
every row rather than sampling, the *sample* is complete; the percentile
computation over it is still an approximation. **A match wider than the ceiling
is an undercount, and `truncated` says so** — when it is true, `n` is what was
scanned rather than what matched, and every number describes that prefix.
Requires Mongo 7+.

### `rollups`

```ts
q.rollups(scope, { as, dims?, subjectType?, on?, range?, sort?, limit? })
  → { rows, bucketed, truncated, dataSource: 'rollups' }
```

`dims` accepts one value or an array, which becomes an `$in` — one read for N
subjects instead of N reads, or an unfiltered family scan that the cap would
truncate into a plausible wrong answer.

`on` picks which date field `range` filters, and the default is `bucketAt` when
the family is bucketed and `lastAt` otherwise. **Cohort selection wants
`firstAt`.** On a once-per-subject milestone `firstAt` and `lastAt` are equal only
until something re-emits it; after that, filtering on `lastAt` silently selects on
the most recent occurrence. `on: 'firstAt'` makes the choice explicit rather than
lucky, and there is already an index for it.

The range is half-open (`$gte` / `$lt`) either way. `truncated` is observed — the
read asks for `limit + 1` — not inferred from an exact match.

### `trace` and `journey`

```ts
q.trace(scope, traceId)               → { items, dataSource: 'raw' }
q.journey(scope, subjectRef, range, { limit? })
                                      → { records, milestones, dataSource: 'raw+rollups' }
```

`journey` returns raw records newest-first alongside up to 100 **lifetime**
milestone rollups for that subject, ascending by `firstAt`. Bucketed activity rows
are deliberately excluded — they would drown the markers.

A subject ref is unique only *within* a tenant, so a `'*'`-scoped journey can
legitimately braid two tenants' `user:u_1` together. Every row and milestone
carries its `tenantId`, which is what keeps that readable.

## Distinct counts without approximation

DAU/WAU/MAU normally means either a `$group` over raw rows that gets slower every
month, or an HLL sketch with an error bar and a write path to maintain. This
package needs neither, and the trick is that there is no trick.

A rollup family declared `by: ['subject']` **with a bucket** already writes exactly
one document per `(subject, bucket)` — the deterministic `_id` guarantees it:

```ts
rollups: [{ as: 'activity', by: ['subject'], subjects: ['account'], bucket: 'day', retentionDays: 730 }],
```

So distinct-subjects-in-a-bucket **is** the document count, and distinct over a
range is one `$group` on `dims`. Exact, no sketch, no write-path change.

```ts
const dau = await q.distinctCount('tn_1', {
  as: 'activity',
  subjectType: 'account',
  range: { from, to },
  interval: 'day',
});
dau.buckets;   // [{ at, value }] — distinct subjects per bucket
dau.distinct;  // distinct subjects across the WHOLE range — never the sum of buckets
dau.truncated; // the scan ceiling was hit; every number is an undercount
```

`interval` may be **coarser** than the family's own bucket — daily rows rolled up
to monthly MAU — because re-truncating bucket starts cannot split a bucket across
two periods. Asking for something *finer* than the family writes cannot invent
detail; you get the family's own grain back, reported in `interval`.

`distinctCount()` **throws** when the named family cannot answer the question, and
the message names the family, the file it was declared on, and the fix:

- no such family
- no `bucket` — a lifetime family has one doc per subject forever, so every period
  would report the same number
- no `subject` dim — its documents count occurrences, not subjects
- extra dims alongside `subject` — one subject splits across several docs per
  period, so the count would exceed the true distinct total

A registry mistake here would otherwise surface as a number that looks like DAU
and is not. Over HTTP the dashboard turns these into a `400` carrying the same
message, rather than a `500` that hides it.

## Funnels and cohorts

```ts
const f = await q.funnel('tn_1', {
  stages: [
    { as: 'signed_up',  label: 'Signed up' },
    { as: 'activated',  label: 'Activated' },
    { as: 'converted',  label: 'Converted' },
  ],
  exits: [{ as: 'churned', label: 'Churned' }],
  cohort: { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') },
  subjectType: 'account',
  interval: 'week',
});
```

Every `as` must be a **lifetime milestone family** — `by: ['subject']`, no
`bucket`, no extra dims — because `firstAt` is the moment the subject reached the
stage. A bucketed family has one doc per period and would count the same subject
repeatedly; an extra dim splits one subject across several docs and over-counts
every stage. Both throw, naming the family and the fix, for the same reason
`distinctCount` does.

### Cohort membership

Membership is assigned by the **anchor** milestone (default: `stages[0].as`), not
by first event. A subject whose earliest record is a page view three weeks before
signup is still assigned by the signup. A subject with **no anchor document in the
window is absent from the cohort entirely** — every other milestone it has is
invisible, counted at no stage.

The window applies to the anchor family's `firstAt` and is half-open, like
everything else in the package. `cohort.endInclusive: true` includes `to` itself;
it exists so a host migrating off a closed-on-both-ends funnel keeps its numbers.
It is translated to a half-open bound internally (BSON dates are integer
milliseconds, so `$lte: e` and `$lt: e + 1ms` select identically) rather than
leaking `$lte` into the read layer.

Stage documents are read with the cohort's lower bound and **no upper bound**: a
conversion landing months after the window still belongs to its cohort. The lower
bound is deliberate — drop it and a backfill dated before the window silently adds
stages to a report already published.

### The funnel is literal

A subject counts at stage N **only** if a stage-N document exists for it. Reaching
N+1 does not imply N — deep links, operators doing it on someone's behalf, and
imported history all produce that shape.

Consequences you must be willing to render:

- Stage counts are **not** monotonic. A later stage may legitimately exceed an
  earlier one.
- `pctOfPrevious` may exceed 100.
- A subject that skipped a stage contributes to `subjects` for the later stage and
  to **nothing else** on that row — not `notReached`, not the from-previous median
  sample.

That is a data fact, not a bug, and smoothing it would invent subjects that never
existed.

### `notReached` vs `stalledAt`

Two genuinely different quantities that the source implementation spelled with
one word:

| Field | Definition | Reads as |
|---|---|---|
| `notReached` | reached the **previous** stage and not this one | drop-off **into** this stage. `0` on stage 1. |
| `stalledAt` | reached **this** stage and not the next | drop-off **out of** this stage. **`null`** on the terminal stage. |

`stalledAt` is `null` — not `0` — at the end of the funnel. "How many stalled
here" has no answer when there is nowhere to go next, and the original's
equivalent reported every *converted* subject as stuck for exactly that reason.
Neither predicate has a time threshold; both are purely structural.

### Percentages and medians

- `pctOfFirst` — `subjects / first × 100`, unrounded, `null` when `first` is 0.
  `first` is `|{ s : stage 1 present }|`, which equals `cohortSubjects` when the
  anchor *is* stage 1.
- `pctOfPrevious` — `null` on stage 1, and `null` whenever the previous count is 0.
  Never `0`, never `Infinity`. It divides **all** subjects that reached this stage
  by only those that reached the previous one: two independent counts, not a
  conversion rate. That is ported deliberately — changing it would silently
  disagree with the funnel a migrating host reads today.
- `medianDaysFromAnchor` / `medianDaysFromPrevious` — fractional days, unrounded,
  the caller formats. On an **even**-sized sample the median is the **mean of the
  two middles**, not the lower middle. An empty sample is `null`, never `0`:
  "nobody got here" and "everybody got here instantly" are different facts and a
  chart must be able to tell them apart. When the anchor *is* stage 1, that stage's
  `medianDaysFromAnchor` is `0` — same document, zero elapsed.

`median()` and `summarizeStages()` are exported and pure: same input, same output,
no Mongo. Unit-pin your own expectations against them without a database.

### Slices and exits

`interval` (`day` | `week` | `month`) adds `slices` — the same stage table
recomputed per anchor-date bucket, ascending. `at` is the truncated UTC bucket
start, a `Date`, not a `'2026-W31'` label; weeks start Monday.

`exits` are families that are counted but never staged — churn, cancellation.
Each returns one row with a subject count, zeros included.

### Truncation is reported, not implied

All four capped primitives — `rollups`, `distribution`, `distinctCount` and
`funnel` — set `truncated` by reading one more document than the cap and
observing the overflow. When it is true, **every number in that result is an
undercount** — render that, do not smooth it. The alternative is a short funnel,
or a p95 off the first slice of the range, that looks like the real one.

`distribution` was the exception until recently: it carried the same hard scan
ceiling and reported nothing, which is the silent cap this package refuses
everywhere else.

## Slow reads

`onSlowQuery({ op, ms, params })` fires for any primitive exceeding `slowMs`
(default 500). It is an adapter, not a logger call — see
[Adapters](/guide/adapters).

## Where to go next

- [Rollups](/guide/rollups) — declaring the families these primitives read
- [The dashboard](/guide/dashboard) — the same primitives over HTTP, behind a viewer
- [Public API](/reference/http-public) and [Admin API](/reference/http-admin)
- [Types & payloads](/reference/types) — every result shape
