# Reports

A **Report** is one shape that says what is being counted, over what range, by
which dimensions and with what measure. It is what a page renders, what a saved
view stores, what a URL hash carries, what `GET /api/report` parses, and what the
`run_report` MCP tool executes. Nothing else in the read path is a query.

```ts
{
  source: { event: 'llm.completion' },
  range: '30d',
  interval: 'day',
  measure: 'sum:cost_usd',
  groupBy: ['attr:gen_ai_request_model'],
  filters: [{ dim: 'attr:feature', op: 'eq', value: 'chat' }],
}
```

That Report is answered by one indexed read of the `llm_cost` rollup family,
because the registry declared that family and the resolver noticed. Nobody wrote
that mapping down.

## Infer over declare

The registry already says which events exist, which attrs and metrics they carry,
which of those are indexed, and which rollup families they feed. The rollup
collection already holds every dimension value that has ever been observed.
Between the two, the package knows enough to offer every grouping, filter,
measure and interval it can answer — and to refuse the ones it cannot.

So a chart is not written twice, once in the registry as a fact and again in a
view as a wish. The rule is:

> **A page may not name a metric, an attr, or a family. It asks the catalog.**

`cost_usd` appearing in a component is the alarm. It means the component has
over-fit to one host's registry, and it will be wrong for the next one.

Two consequences follow. Nothing is offered that the resolver cannot plan — a
greyed control with a reason beats a query that 400s at the database. And
exactness is rendered rather than inferred: every answer carries whether it came
off maintained rollup docs, an indexed scan, or an unindexed one.

## The catalog

`deriveCatalog(registry)` is the registry projected into what a reader can ask.
It is pure — no Mongo, no I/O — and it is built once at `createDashboard()` and
`createTelemetryMcp()`, boot-time like `validateRegistry` and for the same
reason: if the catalog cannot be built, the registry is wrong, and a request is
the wrong place to find that out.

`GET /api/registry` serves it under a `catalog` key beside the unchanged
`registry` projection, and so does the `describe_telemetry` MCP tool. See
[`Catalog`](/reference/types#catalog-types) for the full shape.

```ts
interface Catalog {
  events: Record<string, EventFacet>;
  families: Record<string, FamilyFacet>;
  namespaces: Record<string, string[]>;   // 'billing' → ['billing.plan_selected', …]
  envelope: DimFacet[];
  subjectTypes: string[];
}
```

**A `DimFacet` is something you can group or filter by.** Its `key` is the same
token a rollup `by` uses, so it passes straight through from one to the other:
`attr:gen_ai_request_model`, `field:client.platform`, `subjectType`, `actorType`.
Its `label` is what the rollup writer puts before the `=` in a stored `dims`
entry, which is what lets a fold match a rollup doc to a requested group. It also
carries a `type`, an `optional` flag, and `indexed`.

**`indexed` is true only where a real index answers the dim** — an attr listed in
`indexedAttrs`, or an envelope field the base schema indexes (`field:kind`,
`field:name`, `subjectType`). Everything else is a collection scan bounded by the
range, and the UI badges it as one. A dim several events declare is `indexed`
only when *all* of them index it; one unindexed feeder makes the whole read a
scan, and claiming otherwise sells a scan as a lookup.

**Enum domains come from zod.** The attr's schema is unwrapped through
`optional` / `nullable` / `default` / `catch` / `readonly` / `pipe` until it
reaches a leaf; a `z.enum` or `z.literal` leaf populates `values` with its closed
domain. Anything the walk does not recognise types as `'string'`, which is
honest — attrs are strings after Mongoose casting anyway. Envelope dims carry
their domains from the model: `kind`, `severity`, `env`, `origin`, and
`client.platform`, the last including whatever `createTelemetry({ platforms })`
added.

**A `MeasureFacet` makes a convention explicit.** `count` always; then per
declared metric key `sum:`, `avg:`, and `p50:` / `p95:` / `p99:`. A `span` also
gets `avg:durationMs` and its percentiles, because a duration lives on the
envelope rather than in `metrics`, so no registry can declare it and every span
has it.

**`exactVia` is the interesting field.** It lists the rollup families whose `sum`
carries that metric *for this event* — the families that can answer the measure
without reading a record. Only `sum:` keys ever have one.

```ts
catalog.events['llm.completion'].measures
// [ { key: 'count', exactVia: [] },
//   { key: 'sum:cost_usd', metric: 'cost_usd', exactVia: ['llm_cost'] },
//   { key: 'avg:cost_usd', metric: 'cost_usd', exactVia: [] }, … ]
```

A family is never listed because a *different* feeder declared the sum: this
event's records would not be in that total.

**A `FamilyFacet` describes a rollup family** — its `by` grain in declared order,
the `labels` those dims are stored under, its `bucket` (or `lifetime: true` when
there is none), the `sums` it accumulates, and the `feeders` that declare it. The
resolver reads nothing else to decide whether a family answers a Report.

## The Report shape

See [`Report`](/reference/types#reports) for the declared types. In prose:

| Field | |
|---|---|
| `source` | `{ event }` one registered name, `{ namespace }` every name under `billing.*`, `{ kind }`, or `{ family }` to read a rollup family directly |
| `range` | a shorthand (`'7d'`, `'24h'`, `'90d'`, or any `<n>h` / `<n>d`) or an explicit half-open `{ from, to }` ISO pair |
| `interval` | `hour` \| `day` \| `week` \| `month` |
| `measure` | a `MeasureFacet.key`, default `'count'`; also `'distinct:<subjectType>'` and `'funnel'` |
| `groupBy` | at most two `DimFacet.key`s — three dims is a pivot nobody can read and a group count that multiplies |
| `filters` | `{ dim, op, value }` terms, `op` one of `eq` \| `in` \| `gte` \| `lte` |
| `excludeActorTypes` | the customer toggle |
| `sort`, `limit`, `compare` | rendering and window controls; `compare: 'previous'` is the window of the same length immediately before |
| `stages`, `anchor`, `exits`, `subjectType` | funnel only |

An unknown range shorthand **throws** rather than defaulting to seven days. On
the client a wrong default draws a chart; here it would silently answer a
different question than the one asked.

### A Report is a URL

`reportToQuery(report)` and `parseReportQuery(query)` are inverses, and they are
the only encoding. `GET /api/report` reads it, the Explore hash carries it, and
the SPA implements the same grammar — so a shared link and a saved view are the
same object.

```
source=event:<name> | namespace:<ns> | kind:<kind> | family:<as>
range=7d                                   # or from=<ISO>&to=<ISO>
interval=day  measure=sum:cost_usd  sort=value  limit=50  compare=previous
groupBy=attr:gen_ai_request_model,field:client.platform
filter=<dim>:<op>:<value>                  # REPEATED; op ∈ eq | in | gte | lte
excludeActors=admin,system
stages=a,b,c  anchor=a  exits=x,y  subjectType=account     # measure=funnel
```

Two things the grammar had to settle.

**The op is found, not positioned.** A dim contains a colon of its own
(`attr:feature`) and so may a value (`user:u_1`), so a term splits at the *first*
token that is one of the four operators. A dim whose last segment were literally
`eq` would mis-split; nothing the catalog produces is one.

**`filter` repeats rather than joining with commas**, because an `in` list is
itself a comma list. That is also why `reportToQuery` returns
`Record<string, string | string[]>` rather than a flat string map.

Unknown params are ignored — a URL may carry a page's own state alongside the
Report. A malformed one is a `400` naming the param. If a Report ever needs
state a URL cannot hold, the query layer is missing a parameter.

The worked form of the Report at the top of this page:

```
GET /telemetry/api/report
  ?source=event:llm.completion
  &range=30d
  &interval=day
  &measure=sum:cost_usd
  &groupBy=attr:gen_ai_request_model
  &filter=attr:feature:eq:chat
  &compare=previous
```

## The resolver

`resolveReport(report, catalog, opts?)` turns a Report into a `Plan`. It is pure
and deterministic given `now`, so it is unit-pinned without a database, like
`deriveCatalog` and `summarizeStages`.

```ts
interface Plan {
  primitive: 'records' | 'series' | 'breakdown' | 'distribution'
    | 'rollups' | 'distinctCount' | 'funnel';
  args: unknown[];                    // positional, AFTER scope
  exactness: 'exact' | 'raw' | 'scan';
  via?: string;                       // the family that answered it
  why: string;                        // a sentence, for the badge and the agent
  shape?: PlanShape;                  // how to fold a rollups plan
  previous?: { args: unknown[] };     // under compare: 'previous'
}
```

`args` is positional and spreads straight into the primitive it names. That is
the entire contract between the resolver and the query layer:

```ts
const plan = resolveReport(report, catalog);
if ('primitive' in plan) await q[plan.primitive](scope, ...plan.args);
```

A `params` bag would have needed a per-primitive adapter in the executor, which
is the plumbing this design exists to avoid. Adding a primitive costs a rule and
no wiring.

Rules run in preference order — first match wins — and the order is a preference:
an exact rollup read beats a raw scan, and a refusal with a reason beats a query
that fails at the database.

| Report shape | Plan | `exactness` |
|---|---|---|
| `measure: 'funnel'` | `funnel` — every stage, the anchor and every exit must be a lifetime `by: ['subject']` family, all of one subject type | `exact` |
| `measure: 'distinct:<subjectType>'` | `distinctCount` — a bucketed single-subject family whose `feeders` cover the source events | `exact` |
| `groupBy` ⊆ a family's dims, its `bucket` no coarser than `interval`, measure `count` or one of its `sum`s, feeders matching the source | `rollups`, folded by `plan.shape`. Fewest dims wins | `exact` |
| `groupBy`, measure `count` / `sum:` / `avg:` | `breakdown` | `raw` |
| as above, but a dim it touches is not `indexed` | the same plan, flagged | `scan` |
| no `groupBy`, an explicit measure or an interval | `series` | `raw` / `scan` |
| `measure: 'p50\|p95\|p99:<metric>'`, no `groupBy` | `distribution` | `raw` / `scan` |
| no measure, no `groupBy`, no interval | `records` — the reader wants the rows | `raw` / `scan` |
| anything else | `{ unavailable: true, why }` | — |

`records` is tried **before** `series`, because the default measure is `'count'`
and the series rule would otherwise match everything. Asking for `measure:
'count'` explicitly is what distinguishes "chart this" from "show me the rows".

### What the three exactness values mean

| | |
|---|---|
| `exact` | answered from rollup documents maintained on write. One indexed read, no scan of records. |
| `raw` | an indexed scan of the records collection, bounded by the range and the indexes. |
| `scan` | the same read, but a dimension it groups or filters on has no index behind it. Still bounded by the range; the `why` names the offending dim. |

Render it, never infer it. The SPA draws it as a badge above every chart, and
`plan_report` returns it to an agent for the same reason.

### A refusal names the registry change

`Unavailable.why` is not "bad request". It names the offending key and the line
that would make the question answerable:

```
no bucketed `by: ['subject']` family covers account.signed_up for subject type
"account" — declare `rollups: [{ as: 'activity', by: ['subject'],
subjects: ['account'], bucket: 'day' }]` on the events that count as activity
```

```
"attr:gen_ai_system" has no index behind it, so this is a collection scan
bounded only by the range; add "gen_ai_system" to `indexedAttrs` to make it a
lookup
```

That is what lets the Explore page grey a control with a tooltip instead of
letting someone submit a query that fails, and what lets an agent pick a
different measure rather than retrying the same one.

## The executor

`executeReport(q, scope, report, catalog, opts?)` is the resolver plus the read.
It lives in its own module because `resolveReport` is pure and executing needs
the whole `Queries` handle.

```ts
const out = await executeReport(q, scope, report, catalog);
out.plan.exactness;   // 'exact'
out.plan.via;         // 'llm_cost'
out.result;           // the primitive's own result
out.dataSource;       // 'rollups'
```

Three doors, one executor: [`GET /api/report`](/reference/http-admin#get-api-report),
the `run_report` MCP tool (which also takes an inline Report, so an agent composes
rather than picks), and the dry runs —
[`GET /api/report/plan`](/reference/http-admin#get-api-report-plan) and
`plan_report` — which return `Plan | Unavailable` without reading anything.

**A refusal is a `200` on `/report/plan` and a `400` on `/report`.** On the dry
run a refusal is the answer someone asked for. On the real route they asked for
data, and the `why` becomes the error message verbatim.

### The rollups fold

The executor performs exactly one translation. `rollups()` has no server-side
`groupBy` — it returns a family's own documents — but when the resolver picks it,
the requested dims *are* that family's dims, so the grouping is arithmetic over
rows already read rather than a second query.

`foldRollups(rows, plan.shape)` produces the same
`{ rows: [{ dims, at?, value }], groups, truncated, dataSource }` shape
`breakdown()` returns:

- `count` sums each doc's `count`.
- `sum:<k>` sums `sums[k]`.
- `avg:<k>` is `Σ sums[k] / Σ count` — exact off the same document, not an
  average of averages.
- An `interval` re-truncates `bucketAt`. A family may bucket *finer* than the
  interval asked for; re-truncating a bucket start cannot split one, so the roll
  up stays exact.
- A subject dim keeps its native `type:id` ref, with no `label=` prefix, because
  that is how rollups store it and how erasure matches it.

The fold is pure and unit-tested without Mongo, and the suite asserts its numbers
equal a `breakdown()` over the same records, row for row. That equality is what
makes preferring the exact plan free: a renderer never learns which store
answered.

### `compare: 'previous'`

Pure arithmetic on the Report. The plan carries `previous.args` — the same call
with its range shifted back by its own length — and the executor runs it
alongside, returning the second answer as `previous`. No primitive changes; each
one keeps its range in a different place, which is why the shift lives in the
resolver rather than in seven call sites.

## Values — the observed domain of a dimension

"What values does this dimension actually take" is the question standing between
a report builder and every filter it offers. `createValues()` answers it, served
by [`GET /api/values`](/reference/http-admin#get-api-values) and the
`dimension_values` MCP tool.

It is **not a tenth primitive.** The primitives read records and rollups and know
nothing about the registry; this reads the catalog first and touches Mongo only
when the catalog cannot answer. That is why it is its own factory beside
`createQueries` rather than inside it.

Four sources, tried cheapest first, and the response says which one answered:

| `source` | when | reads |
|---|---|---|
| `catalog` | the dim has a closed domain — a `z.enum`, an envelope enum. Verbatim, in schema order | nothing |
| `rollups` | a family's `by` names the dim. Fewest dims wins; `names` restricts to families those events feed | one `$group` on the `{tenantId, as, dims, bucketAt}` index prefix |
| `raw` | the dim is groupable, a range was given, and an attr is `indexed` on one of the named events | one `$group` over the range |
| `none` | nothing above applies | nothing |

`catalog` returns no `counts`; the other two sort by count descending and carry
them. The `label=` prefix is stripped where it is present. Records missing the
dimension are not a value — the `null` group `breakdown()` reports is real, but
it is not something a filter can name.

**`none` is an answer, never a throw** — including for a dim that would need a
range and was given none. The caller's fallback is a text box, and an exception
there would replace a working control with an error page.

That distinction is exactly what the filter bar renders. A dim that resolves to
`catalog`, `rollups` or `raw` becomes a **picker**: a select of real values, each
with its count where one exists, tagged with the source that answered and with
`via` on hover. A dim that resolves to `none` — or that returns an empty list —
becomes **free-text equality with a *scan* badge**, because typing a value the
package cannot enumerate is honest and an empty select is not.

## Views are Reports

`ViewSpec.query` is a `Report`. A view is still nothing but named query state —
a page and a Report — and still has [three
producers](/guide/dashboard#views-one-shape-three-producers) that shadow by name.

**Derived views grew from two shapes to five**, all zero-config, all generated
from the catalog in registry order so the sidebar does not reshuffle between
requests:

| shape | name | what it answers |
|---|---|---|
| per event | `<name>` | that one name over a week |
| per family | `rollup: <as>` | the family's own docs — the cheapest read there is |
| per namespace | `namespace: <ns>` | `billing.*` split by name over a month |
| per usage event | `spend: <name>` | its `*_usd` sum per day |
| per subject type | `funnel: <type>` | that type's lifetime milestones as a cohort funnel |

A namespace of one event is skipped — it would be that event's view under a
second name. A subject type with fewer than two milestone families is skipped —
one stage is a count, and there is already a view for it. The `*_usd` suffix is a
formatting convention, which makes it the one thing a derived view may read off a
key; it never names one.

**Configured and saved views are the same shape.** A configured view can name a
Report the catalog already allows; it cannot unlock a dimension the registry did
not declare. Declared config pins, it never enables.

**Every view saved before Reports existed still parses.** `spec` is a Mixed
document, and `normalizeQuery(query)` lifts the old `{ range, filters, groupBy,
sort }` shape: `filters.name` becomes an `{ event }` source, `filters.rollup` a
`{ family }` one, `filters.kind` a `{ kind }` one, and every other key an
`{ dim, op: 'eq', value }` term. It returns `null` when nothing in the query
names a source, because a legacy query that names neither an event, a kind nor a
family is not a Report — it is a page's default, and the caller's own fallback is
the honest answer.

The `display` key a view's `query` used to carry is **removed**. It was a
rendering hint no page read, and with a Report the renderer is decidable:
`groupBy` + `interval` is a stacked
series, `groupBy` alone a breakdown table, `interval` alone a series, neither a
stat tile, and `funnel` the funnel steps. A stored view that still carries the
key keeps parsing, and the key is ignored.

## The Explore page

Explore is the report builder, and its URL is the Report. Source, measure, group
by, then by, interval, compare — every control populated from the catalog, and
every option pre-checked by `resolveReport` before it is offered.

**A disabled option carries its `why`.** The page builds the Report each option
would make, resolves it, and if the resolver refuses, the option is greyed with
the refusal as its tooltip. Nothing is offered that the resolver cannot plan, so
a control is never a way to reach a 400. A groupable dim that is not `indexed` is
offered and marked `(scan)` — that read works, it is just not a lookup.

Changing the source keeps the window and drops the question. A new source has a
different vocabulary of measures, dims and filters, and carrying the old ones
over would produce a Report about the new source that nobody asked for.

The other pages are the same surface with the source fixed: Events is Explore
pre-sourced to `kind: 'event'`, Usage draws one series per observed
`usage.meter` with the first `*_usd` measure the catalog reports, and the
Overview tiles are each a Report — dropped entirely when the resolver says this
registry cannot answer one. An instance with no bucketed subject family genuinely
has no "active subjects" number, and inventing one from a raw scan would be a
different quantity wearing the same label.

"Save view" stores the Report under a name. Derived views link into the page.

## The funnel picker

With `measure: 'funnel'` the builder grows a stage picker: the lifetime
single-subject families of the chosen `subjectType`, multi-select and
reorderable. `subjectType` comes from the catalog, and families are filtered by
it — a host with `machine` and `user` milestones sees two funnels rather than one
interleaved list. `exits` are offered from the same list, unchecked by default.

The **anchor is always the first stage**. The cohort is "subjects who reached step
one in this window", which is the only reading that makes the later steps
conversions rather than totals.

Two orderings are offered:

- **registry** — the order the host typed the families in.
- **observed** — one `rollups({ as, subjectType, sort: 'firstAt' })` read per
  candidate family, sorted by the median `firstAt`. A family nobody has reached
  sorts last.

Registry order was never a claim about sequence, which is why observed order
exists. **Sort-by-count is deliberately not offered at all:** a funnel that reads
as monotonic because its stages were sorted by size hides exactly the anomaly
worth seeing. Stage counts in this package are literal and genuinely not
monotonic — see [Funnels](/guide/queries#the-funnel-is-literal).

## Suggestions

Everywhere else the registry tells the data what is allowed. The System page
reads it the other way round, and it can, because nothing was ever dropped
silently. `deriveSuggestions()` is pure and runs over the counters and quarantine
rows the handler already fetched, so the page costs no extra read. The
`telemetry_health` MCP tool returns the same list.

| `kind` | from | |
|---|---|---|
| `undeclared_attr` | `counters.undeclaredAttrs` | an attr key that keeps arriving undeclared |
| `missing_dim_default` | `counters.rollupSkippedBy` | a family that keeps losing a dimension |
| `unregistered_event` | the quarantine, grouped by name | a name nobody registered |

Each carries a `message` a human reads and a `fix` that is **code, not prose**:
the zod line to add (or the whole `attrs: z.object({ … })` block when the spec
declares no attrs), a `dimDefault` line commented with every spec that feeds the
family, or a minimal registry stub.

**Undeclared attrs are not a leak this feature closes.** An undeclared key has
always failed the strict parse and quarantined the whole record, on both the
`emit()` and the ingest path — the record is rejected, never stored with an extra
and never silently stripped. What the counter adds is grouping: the diff is
visible at write time, so it is counted into `counters.undeclaredAttrs` under
`` `${name}|${attrKey}` `` before the parse kills the record, and forty identical
failures become one sentence naming the key instead of forty quarantine rows
nobody reads.

The two attributed counter maps are bounded at 1000 distinct keys, folding into
`(other)|(other)` past that. Both are keyed on client-controlled strings, so an
unbounded map would be a way to grow the process heap from outside. The totals
stay honest; only the attribution stops.

Nothing here writes anything. The host still edits the registry by hand; the
package just stops making it guess.

## Running one yourself

```js
import { createQueries, deriveCatalog, executeReport, resolveReport } from '@jeffjassky/telemetry';

const catalog = deriveCatalog(t.registry);
const q = createQueries({ TelemetryModel: t.models.telemetry, RollupModel: t.models.rollups, registry: t.registry });

const report = {
  source: { event: 'llm.completion' },
  range: '30d', interval: 'day',
  measure: 'sum:cost_usd', groupBy: ['attr:gen_ai_request_model'],
};

const plan = resolveReport(report, catalog);        // 'unavailable' in plan → plan.why
const out = await executeReport(q, 'tn_1', report, catalog);
out.plan.exactness;  // 'exact' — via 'llm_cost', one indexed rollup read
out.result.rows;     // [{ dims: ['opus'], at, value: 41.02 }, …]
```

And the same question asked by an agent, planned before it is paid for:

```jsonc
// plan_report — no read
{ "report": {
    "source": { "event": "llm.completion" },
    "range": "30d", "interval": "day",
    "measure": "sum:cost_usd",
    "groupBy": ["attr:gen_ai_request_model"] } }

// → { "primitive": "rollups", "exactness": "exact", "via": "llm_cost",
//     "why": "family \"llm_cost\" is keyed by attr:gen_ai_request_model, attr:feature
//             and maintained on write, so this is one indexed rollup read …" }

// run_report — the same input, now with the answer beside that plan
```

## Limits

`limits.breakdown` (default 50) and `limits.values` (default 200) are **output**
caps. Their `$limit` sits after the `$group`, so the work behind them is bounded
by the range and the indexes rather than by the number, and truncation keeps the
**top** groups or values by measure — which is what a breakdown table means. A
cap on documents read would return an arbitrary prefix and call it the top.

Both report `truncated` when more existed than were returned, observed by reading
one past the cap rather than inferred from an exact match.

`breakdown()` with an `interval` has a second ceiling: the per-bucket pass returns
at most `limits.series` buckets per returned group, reported as
`bucketsTruncated`. The two flags cut different axes — `truncated` drops groups
entirely, `bucketsTruncated` drops periods of a group you were given — so they
are two flags rather than one. `bucketsTruncated` is always `false` without an
interval.

The three primitives that cap the **scan** — `distribution`, `distinctCount` and
`funnel` — are unchanged, and an answer past one of those ceilings is genuinely an
undercount. See [Queries](/guide/queries#the-nine-primitives).

## See also

- [Queries & funnels](/guide/queries) — the nine primitives a plan dispatches to
- [The dashboard](/guide/dashboard) — views, pages, and the System page
- [MCP tools](/guide/mcp) — `run_report`, `plan_report`, `dimension_values`
- [Admin HTTP API](/reference/http-admin#reports) — `/api/report`, `/api/report/plan`, `/api/values`
- [Types & payloads](/reference/types#reports) — `Catalog`, `Report`, `Plan`, `ReportResult`, `ValuesResult`
