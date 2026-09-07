# Reports — infer the report surface, declare only the pins

**Status 2026-09-07: steps 1–8 shipped in the working tree, unreleased.**
Docs are `docs/guide/reports.md` plus the updated dashboard/queries/mcp guides
and the HTTP + types references; the CHANGELOG entry is consolidated under
`[Unreleased]` and the version bump is the owner's call.

The dashboard's next layer, over [dashboards.md](./dashboards.md)'s primitives
and [mcp-tools.md](./mcp-tools.md)'s tool surface. Normative for the catalog,
the Report shape, the resolver, and what the UI may offer.

Written 2026-09-07 against 0.3.0, from the source rather than the docs. The
driving host is StoryFolder, which wants its hand-built admin page (signup
charts, journey funnel, revenue, all by period) replaced by pages that need no
per-chart code.

---

## 1. Design position

**Infer over declare.** The registry already says which events exist, which
attrs and metrics they carry, which are indexed, and which rollup families
they feed. The rollup collection already holds every dimension value ever
observed. Between the two, the package knows enough to offer every grouping,
filter, measure and interval that it can answer — and to refuse the ones it
cannot. Nothing about a chart should have to be written twice: once in the
registry as a fact, again in a view as a wish.

Today that inference is shallow and scattered. `registryProjection` exists
twice ([dashboard.ts](../src/server/dashboard.ts), [mcp.ts](../src/server/mcp.ts))
and projects key names only — no types, no enum domains. `deriveViews`
([views.ts](../src/server/views.ts)) writes one view per event and one per
family. The pages then re-derive on their own: `familiesBy` and
`milestoneFamilies` in [pages.jsx](../src/ui/pages.jsx), a client-side
`groupBy` over the fifty rows on screen, and `sum:cost_usd` hardcoded on the
Usage page and the Overview spend tile. The cohort funnel takes **every**
lifetime subject family in registry order as its stage list, which is
meaningless the moment a host declares thirty milestones.

So the rule this plan installs:

> **A page may not name a metric, an attr, or a family. It asks the catalog.**

`ViewSpec` stays — a view is still a named URL (dashboards §11.6) — but its
`query` grows into a **Report**: one shape that every page renders, the
explore UI builds, the sidebar links, and `run_report` executes.

---

## 2. What exists, and what it becomes

| today | file | becomes |
|---|---|---|
| `registryProjection()` ×2 | dashboard.ts, mcp.ts | `deriveCatalog()` in `src/server/catalog.ts`, one copy, served by `/registry` and `describe_telemetry` |
| `deriveViews()` — per event, per family | views.ts | derived Reports: per namespace, per family, per usage meter, one funnel per subject type |
| `familiesBy`, `milestoneFamilies`, client `groupBy` | pages.jsx | gone — pages read `catalog` + `resolveReport()` |
| `sum:cost_usd` literal | pages.jsx (Overview, Usage) | first `*_usd` measure the catalog reports for `kind: 'usage'` |
| `CohortFunnel` = all lifetime families | pages.jsx | stage picker; default stages inferred (§7) |
| `ViewSpec.query` = range/filters/groupBy/sort/display | views.ts | `Report` (§4), superset — every stored view still parses |
| `runReport()` | mcp.ts | the executor (§6), shared with the SPA's `/report` route |
| `/series` measure `count|sum:|avg:` | query.ts | unchanged; `breakdown()` added beside it (§6) |

Nothing is removed from the HTTP surface. `/registry` gains fields; the
primitives gain one sibling; views gain fields with defaults.

---

## 3. The catalog

`deriveCatalog(registry): Catalog` — pure, computed once at `createDashboard()`
and `createTelemetryMcp()`, cached on the instance. Boot-time like
`validateRegistry`, and for the same reason: if the catalog cannot be built,
the registry is wrong.

```ts
interface Catalog {
  events: Record<string, EventFacet>;
  families: Record<string, FamilyFacet>;
  /** name prefix before the first '.', so `library.*` is one page */
  namespaces: Record<string, string[]>;
  /** dims every record carries — always filterable, groupable raw */
  envelope: DimFacet[];
  subjectTypes: string[];
}

interface EventFacet {
  kind: TelemetryKind; origin: Origin | 'any'; subjects: string[]; description: string;
  namespace: string;
  dims: DimFacet[];          // attrs typed, then this kind's own envelope fields
  measures: MeasureFacet[];  // 'count', then sum/avg/p50/p95/p99 per metric key
  families: string[];        // rollup families this event feeds (`as`, or its own name)
  indexedAttrs: string[]; indexedMetrics: string[];
  retentionDays: number | null;   // EFFECTIVE: the override, else RETENTION_DAYS[kind]
}

interface FamilyFacet {
  as: string;
  by: DimSource[];           // the grain, in order
  labels: string[];          // `label(src)` per dim — the `x=` prefix rollups.ts writes
  bucket: 'hour' | 'day' | 'week' | 'month' | null;
  lifetime: boolean;         // !bucket
  subjectTypes: string[];    // `subjects` when `by` has a subject dim
  sums: string[];
  capture: string[];
  feeders: string[];         // event names declaring this `as`
  retentionDays: number | null;
}

interface DimFacet {
  /** the DimSource form, so it passes straight to `by`, groupBy and filters:
   *  'attr:model' | 'field:client.platform' | 'subjectType' | 'actorType' */
  key: string;
  /** what rollups.ts writes before '=' — for the two pseudo-dims, the key itself */
  label: string;
  type: 'string' | 'enum' | 'number' | 'boolean' | 'date';
  values?: string[];         // closed domain — z.enum, z.literal, envelope enums
  optional: boolean;
  indexed: boolean;          // a REAL index answers it — indexedAttrs, or a base index
}

interface MeasureFacet {
  key: string;               // 'count' | 'sum:cost_usd' | 'avg:duration_ms' | 'p95:duration_ms'
  metric?: string;
  /** which families can answer it exactly — empty means raw only */
  exactVia: string[];
}
```

**Attr typing walks zod.** `attrs.shape[key]` unwrapped through
optional / nullable / default / catch / readonly / pipe (the input side) until
a leaf; the leaf's `def.type` (zod 4) maps to `type`, and `enum` / `literal`
populate `values`. `z.coerce.*` needs no case — it is the base type with
`def.coerce` set. `optional` is true when the walk passed an optional, nullable
or default. Anything the walker does not recognise is `'string'` — attrs are
strings after casting anyway (registry.ts). No `z.toJSONSchema`: the walker
needs five cases, and a JSON-schema round trip would be a second vocabulary.

**Envelope dims are fixed**, not inferred, and they are written in DimSource
form so a `groupBy` built from one matches what a rollup `by` writes:
`field:kind`, `field:name`, `field:severity`, `field:env`, `field:service`,
`field:release`, `field:origin`, `field:client.platform`,
`field:client.appVersion`, plus the two pseudo-dims `subjectType` and
`actorType` — those carry no prefix, because they are derived at query time
from `subjectKeys` and `actor` rather than read off a path.
`kind`/`severity`/`env`/`origin`/`client.platform` carry their enum domains
from [model.ts](../src/server/model.ts), the platform list including whatever
`createTelemetry({ platforms })` added. `indexed` is true only where model.ts
actually builds a base index: `field:kind`, `field:name`, `subjectType`.

The discriminator's own fields go on the events of that kind, after the attrs,
so a usage event's dims include its meter and an event event's do not:
`kind: 'usage'` adds `field:usage.meter`, `field:usage.billedTo`,
`field:usage.unit`; `kind: 'state'` adds `field:state.key`, `field:state.to`;
`kind: 'error'` adds `field:error.type`, `field:error.handled`.

**Measures are conventions made explicit.** `count` always. Per metric key:
`sum:`, `avg:`, and `p50/p95/p99:` (the last three only raw, via
`distribution`). `exactVia` lists every family whose `sum` includes the metric.
The `*_usd` / `*_ms` / `tokens_*` formatting rules in [util.js](../src/ui/util.js)
stay where they are; the catalog does not carry display hints (dashboards §4).

---

## 4. The Report — one shape

```ts
type ReportSource =
  | { event: string }                // one registered name
  | { namespace: string }            // every event under `library.*`
  | { kind: TelemetryKind }
  | { family: string };              // read a rollup family directly

type ReportRange = string | { from: string; to: string };   // '7d' | explicit ISO pair

interface ReportFilter {
  dim: string;                       // DimFacet.key
  op: 'eq' | 'in' | 'gte' | 'lte';
  value: string | string[] | number;
}

interface Report {
  source: ReportSource;
  range: ReportRange;
  interval?: 'hour' | 'day' | 'week' | 'month';
  measure?: string;                  // MeasureFacet.key — default 'count'
  groupBy?: string[];                // DimFacet.key, ≤ 2
  filters?: ReportFilter[];
  excludeActorTypes?: string[];
  sort?: 'value' | 'label' | 'time';
  limit?: number;
  compare?: 'previous';              // same length, immediately before
  /** funnel-only — `measure: 'funnel'` */
  stages?: string[];                 // family names, ordered
  anchor?: string;
  exits?: string[];
  subjectType?: string;
}
```

Shipped 2026-09-07 in `src/server/report.ts`, with the legacy `ViewSpec.query`
kept beside it as `LegacyQuery` (`@deprecated`) and lifted by
`normalizeQuery(query): Report | null` — `filters.name` → `{ event }`,
`filters.rollup` → `{ family }`, `filters.kind` → `{ kind }`, every other key an
`{ dim, op: 'eq', value }` term, `null` when nothing names a source.

`ViewSpec.query` **is** a `Report`. The existing fields keep their meaning:
`range`, `filters` (old object form is accepted and lifted to `{dim, op:'eq'}`
terms), `groupBy` (string → one-element array), `sort`. `page` and `display`
survive as rendering hints and become optional: with neither, the renderer
picks from the Report (§8). Every saved view in `<collection>_views` parses
unchanged, and `resolveViews` is untouched — the three producers and the
shadowing rule are exactly the DRY line this plan needs, so it does not add a
fourth.

A Report is a URL. Shipped 2026-09-07 as `parseReportQuery` / `reportToQuery`
in report.ts — pure, inverse, and round-trip tested — which `GET /api/report`
reads and util.js will implement identically on the client:

```
source=event:<name> | namespace:<ns> | kind:<kind> | family:<as>
range=7d                                  # or from=<ISO>&to=<ISO>
interval=day  measure=sum:cost_usd  sort=value  limit=50  compare=previous
groupBy=attr:model,field:client.platform  # comma
filter=<dim>:<op>:<value>                 # REPEATED; op ∈ eq|in|gte|lte
excludeActors=admin,system
stages=a,b,c  anchor=a  exits=x,y  subjectType=account     # measure=funnel
```

Two things the encoding had to settle. The dim inside a `filter` contains a
colon of its own (`attr:model`) and so may the value (`user:u_1`), so the term
is split on the FIRST operator token rather than by position. And `filter`
REPEATS rather than joining with commas, because an `in` list is itself a comma
list — which is also why `reportToQuery` returns `Record<string, string |
string[]>` rather than the flat string map first drafted here. Unknown params
are ignored (a URL may carry a page's own state); a malformed one is a 400
naming the param. If a Report ever needs state a URL cannot hold, the query
layer is missing a parameter (dashboards law 6).

---

## 5. Values — the observed domain

`GET /api/values?dim=<DimFacet.key>&names&from&to` answers "what values does
this dimension actually take", in this order, reporting which one it used:

1. **`catalog`** — a closed `values` list on any DimFacet of the named events,
   or on the envelope. Verbatim, in schema order. No read.
2. **`rollups`** — a family whose `by` names the dim (`family.by[i] === dim`),
   fewest dims first, restricted to families the `names` actually feed:
   `$match {tenantId, as}` → `$project` the i-th `dims` element → `$group`
   summing `count`, on the `{tenantId, as, dims, bucketAt}` index prefix. Every
   value that ever hit an aggregate, with its total, in one indexed read. The
   `label=` prefix is stripped; a subject dim keeps its native `type:id`.
3. **`raw`** — `dimExpression()` accepts the dim, a range is given, and an attr
   is `indexed` on one of the named events: `$group` over the range counting
   `1/sampleRate`, under `limits.values`, with `truncated`. The null group is
   dropped — a "no value" is not a value to pick.
4. **`none`** — the UI offers free-text equality with a *scan* badge, as the
   FilterBar already does.

Shipped 2026-09-07 as `createValues()` in `src/server/values.ts`:

```ts
interface ValuesParams { dim: string; names?: string[]; range?: TimeRange; limit?: number }
interface ValuesResult {
  values: string[];
  counts?: number[];                                  // absent for 'catalog'
  source: 'catalog' | 'rollups' | 'raw' | 'none';
  via?: string;                                       // the family, when 'rollups'
  truncated: boolean;
  dataSource: 'catalog' | 'rollups' | 'raw' | 'none';
}
function createValues(ctx: { catalog; TelemetryModel; RollupModel; limits?; … }):
  (scope: string, params: ValuesParams) => Promise<ValuesResult>;
```

Three things settled by shipping it. **`none` never throws**, including when the
raw step is the only eligible one and no range was given — the caller's fallback
is a text box, and an exception would replace it with an error page. **The cap
is `limits.values`** (200), its own number rather than a borrowed
`limits.breakdown`, and it bounds the values returned, never the rows scanned.
**It is not a tenth primitive**: it reads the catalog, which `createQueries`
deliberately does not, so it is its own factory built beside it. `subjectType`
has no `by` equivalent and falls through to raw; the literal `'subject'` is
accepted as a dim and is the only way to ask a family for its subject refs.

Memoized like `series`. This is the endpoint that turns the FilterBar's
`window.prompt` into a picker, and it needs no declaration from the host.

---

## 6. The resolver and the executor

`resolveReport(report, catalog, limits): Plan` — pure, no Mongo, unit-pinned
like `summarizeStages`. It picks the cheapest primitive that answers the
Report **exactly**, falls back to raw, and refuses with a reason otherwise.

```ts
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
  /** how to fold the rows a `rollups` plan returns — it has no server-side groupBy */
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
```

Two things the first draft of this block did not say, both settled by shipping
it. **`args` is positional, not a `params` bag**: the primitives take
`(scope, range, filter, opts)` and `(scope, params)` in equal measure, so one
`params` shape would have needed a per-primitive adapter in the executor — the
exact plumbing this file exists to avoid. `q[plan.primitive](scope, ...plan.args)`
is the whole executor, and dashboard.test.ts proves it for all seven.
**`shape` is how a rollups plan is folded**: `rollups()` has no server-side
groupBy, so the plan carries the requested dims, the `dims` label prefix
rollups.ts writes for each, the measure, and any dim equalities the fold applies.

`records` joins the union: a Report with no measure, no groupBy and no interval
is asking for the rows. It is tried BEFORE `series`, because the default measure
`'count'` would otherwise make the series rule match everything — asking for
`measure: 'count'` explicitly is what distinguishes "chart this" from "show me
the rows".

Rules, in order of preference:

| Report shape | Plan | exactness |
|---|---|---|
| `measure: 'funnel'` | `funnel({ stages, anchor, exits, cohort: range, subjectType, interval })`. Every stage must be a lifetime single-subject family of one `subjectType` (funnel.ts `requireMilestoneFamily`) | exact |
| `measure: 'distinct:<subjectType>'` | `distinctCount({ as })` — a bucketed single-subject family whose `feeders` ⊇ the source events. None → unavailable, with the family to declare | exact |
| `groupBy ⊆ family.labels` **and** `bucket ≤ interval` (or no interval) **and** `measure ∈ {count} ∪ sums` **and** `feeders == source events` | `rollups({ as, on, range })`, grouped client-side by the requested dims (they are the family's own dims, so the docs are already the groups). Smallest matching `by` wins | exact |
| `groupBy` all `indexed` or envelope; `measure ∈ count / sum: / avg:` | `breakdown()` (new, below) or `series()` when no `groupBy` | raw |
| as above but some dim `indexed: false` | same plan, flagged | scan |
| `measure: pNN:` | `distribution()` per group (≤ 5 groups) | raw |
| anything else | `{ unavailable: true, why }` — never offered by the UI | — |

`compare: 'previous'` shifts the range back by its own length and runs the
plan twice; the executor returns `{ current, previous }`. Pure arithmetic on
the Report, no primitive changes.

**`breakdown()` — the one new primitive.**

```ts
breakdown(scope, range, filter, { groupBy: string[]; measure?: string; interval?: Interval; limit?: number })
  → { rows: [{ dims: string[]; at?: Date; value: number }], truncated: boolean, dataSource: 'raw' }
```

`$group` on the resolved dim paths (attrs → `attrs.<k>`, envelope → the field,
`subjectType` → `$arrayElemAt` of a split on `subjectKeys`) plus `$dateTrunc`
when `interval` is set. Under `PLATFORM_SCOPE` it aggregates across tenants
like `series` does. It replaces the Events page's fifty-row client grouping,
which answered "this page" while labelled as if it answered the range.

**The cap is on groups returned, never on rows scanned.** `series` already
works this way: its `$limit` sits after the `$group`, so a month of a million
records is one pass and 31 buckets. `breakdown()` does the same — scan is
bounded by the range and the indexes, exactly like `series`, and the only
limit is `$sort` by value then `$limit` on distinct groups (`limits.breakdown`,
default 50 groups × the family's buckets), read as cap+1 so `truncated` is
observed. Truncation therefore keeps the **top** groups by measure, which is
what a breakdown table means. A cap on scanned documents would be the wrong
kind of cap here: the reader wants "the top models this quarter" and Mongo is
built to fold a hundred thousand rows into that in one stage. (The two
primitives that DO cap the scan — `distribution` at 100k documents, `funnel`
at 5k cohort subjects — do so because one runs an approximate `$percentile`
and the other assembles the cohort in Node memory; both are `queryLimits`
config and both report `truncated`.)

**The executor**, shipped 2026-09-07 as `executeReport(q, scope, report,
catalog, opts?)` in a NEW file, `src/server/execute.ts` — not in report.ts as
this block first said, because report.ts is pure (type-only imports, unit-pinned
without Mongo) and executing needs the whole `Queries` handle. Same reason
mcp.ts's old `runReport` is deleted rather than moved: it branched on `display`,
a renderer's hint, where the planner now decides.

```ts
executeReport(q, scope, report, catalog, { now?, limits?, redact? })
  → { report, plan, result, previous?, dataSource }
```

Three doors, one executor: `GET /api/report`, the `run_report` MCP tool (which
also takes an INLINE Report, so an agent composes rather than picks), and
`GET /api/report/plan` / `plan_report`, which return `Plan | Unavailable`
without reading — a refusal is a 200 there and a 400 on `/report`, because by
then someone asked for data.

The one translation the executor performs is `foldRollups(rows, plan.shape)`:
a `rollups` plan's docs are folded into the SAME row shape `breakdown()`
returns (`{ dims, at?, value }`, `groups`, `truncated`), so a renderer never
learns which store answered. `count` sums `count`, `sum:<k>` sums `sums[k]`,
`avg:<k>` is `Σ sums[k] / Σ count` — exact off one doc, not a mean of means —
an `interval` re-truncates `bucketAt`, and a subject dim keeps its native
`type:id`. dashboard.test.ts asserts the folded numbers equal a `breakdown()`
over the same records, row for row; that equality is what makes preferring the
exact plan free.

---

## 7. Funnels — pick, and infer the default

Stages become a `Report` (`measure: 'funnel'`, `stages: [...]`). The UI gains a
stage picker: the lifetime single-subject families of the chosen `subjectType`,
multi-select, reorderable, saved as a view. `subjectType` comes from the
catalog's `subjectTypes`; families are filtered by it, so a host with `machine`
and `user` milestones sees two funnels, not one interleaved list.

**The default order is inferred from data, not the registry.** For each
candidate family, one `rollups({ as, subjectType, sort: 'firstAt', limit })`
read yields median `firstAt`; stages sort by it. A family nobody has reached
sorts last. Registry order was never a claim about sequence — it is the order
the host typed them in — and a funnel that reads as monotonic because its
stages were sorted by size hides exactly the anomaly worth seeing, so
sort-by-count is not offered.

`exits` are offered from the same family list, unchecked by default.

---

## 8. What the UI generates

The seven pages stay. Each stops naming things:

| page | reads from the catalog |
|---|---|
| **Overview** | tiles: errors (kind), events (kind), p95 (first span metric ending `_ms` or `durationMs`), active (first bucketed subject family), spend (first `*_usd` measure with `exactVia`) — each tile is a Report, and a missing precondition means no tile |
| **Events** | the explore surface (below), pre-sourced to `kind: 'event'` |
| **Usage** | meters from `usage.meter` values (§5), one series per meter; money measure = first `*_usd` measure — never a literal key |
| **Journeys** | RollupExplorer takes any family; funnel = §7 |
| **Errors / Traces** | unchanged — they already derive the issue family from `field:error.` |
| **System** | + suggestions (§9) |

**Explore** is one new page and the report builder: source → measure →
groupBy → filters → interval → compare, every control populated from the
catalog and every option pre-checked by `resolveReport` so an unanswerable
combination is greyed with its `why`, not submitted. Its URL is the Report.
"Save view" stores it. Derived views link into it.

Derived views grow from two shapes to five, still zero-config:
per event (unchanged), per family (unchanged), per **namespace** (one Explore
Report per `library.*`, `storyboard.*`), per **usage meter**, and one
**funnel per subject type** (§7 defaults). Configured views are the same shape
and shadow by name as before.

`ViewSpec.display` is **removed** (decided 2026-09-07). Today the SPA passes
it into the hash ([shell.jsx](../src/ui/shell.jsx)) and no page reads it. With
a Report the renderer is decidable: `groupBy` + `interval` → stacked series;
`groupBy` alone → breakdown table; `interval` alone → series; neither → stat
tile; `funnel` → FunnelSteps. Saved views that carry the key keep parsing —
`spec` is a Mixed document — and the key is ignored. A chart/table toggle, if
one is ever wanted, is a UI preference and not view state.

---

## 9. Suggestions — the data tells the registry

Three cheap reads on the System page close the loop in the other direction.
Shipped as `deriveSuggestions()` in [suggest.ts](../src/server/suggest.ts) —
pure, unit-tested without Mongo like `deriveCatalog` and `resolveReport`, and
served on `GET /api/system` and by `telemetry_health` from the counters and
quarantine rows those handlers already fetch:

- **`undeclared_attr`.** Not the quarantine grouped after the fact, as first
  sketched — the diff is visible at write time, so emit.ts and ingest.ts count
  it directly into `counters.undeclaredAttrs` (`` `${name}|${attrKey}` ``)
  before the strict parse kills the record. Renders as *"`import.started` has
  been sent with attr `codec` 41 times — not declared"* with the zod line to
  add, or the whole `attrs: z.object({ … })` block when the catalog shows the
  spec declares none.
- **`missing_dim_default`.** `rollupSkipped` was global; it is now also counted
  per `(family, dim)` into `counters.rollupSkippedBy` in
  [rollups.ts](../src/server/rollups.ts). Renders as *"`screens_viewed` skipped
  12 records with no `name` — declare `dimDefault`"*, and the fix names every
  feeder spec from the catalog, because `dimDefault` is declared on an event and
  not on the family.
- **`unregistered_event`.** The quarantine grouped by name where the reason is
  the unregistered-name refusal, with a minimal registry stub.

Both counter maps are bounded at 1000 keys, folding into `(other)|(other)`:
they are keyed on client-controlled strings, so unbounded they would be a way to
grow the process heap from outside.

Neither writes anything. The host still edits the registry by hand; the
package just stops making it guess.

---

## 10. Host impact — StoryFolder

Registry work only: `account.created`, the tag-backed milestones (one lifetime
`user` family each), `billing.invoice_paid` as `kind: 'usage'` with a `*_usd`
metric and a `revenue_by_plan` family, `storyboard.created`. No `views` to
write; three to five configured pins at most. The Vue admin page's charts fall
out of derived views; its customer list is host data and stays a host page,
linked from the dashboard via `subjectAdapter.describe`.

The machine → user join stays out of this plan. Today `$identify` writes an
alias row and nothing reads it ([ingest.ts](../src/server/ingest.ts)); host
subject enrichment exists only for session-mode keys (`contextAdapter`), and
StoryFolder's key is fixed-mode. The direction decided 2026-09-07 is
**write-time linking**, its own plan (`linking.md`): a `t.link(tenantId, from,
to)` primitive the host calls when it learns the truth (activation), which
(1) records the alias, (2) merges the machine's existing lifetime milestones
onto the user subject once, and (3) enriches every later record from that
machine with the user subject at ingest, so rollups fan out to both. Reads
stay ignorant of aliases.

That leaves exactly one population unlinked by construction: machines that
installed and launched but never activated. They are not a gap — they are the
**pre-activation funnel**, a second funnel over the `machine` subject type
whose terminal stage is activation, and whose drop-off is the number the host
most wants to shrink. The user funnel starts at account creation and, once
linking lands, includes the machine steps for every account that did activate.

---

## 11. Laws

1. **A page may not name a metric, an attr, or a family.** It asks the
   catalog. `cost_usd` in a `.jsx` file is the over-fit alarm.
2. **Nothing is offered that the resolver cannot plan.** A greyed option with
   a `why` beats a query that 400s.
3. **Exactness is rendered, never inferred.** `exact` / `raw` / `scan` on
   every chart, from the Plan, the same way `truncated` is today.
4. **A Report is a URL.** The hash is the view; the executor is the only
   reader of the shape.
5. **Declared config pins; it never enables.** A configured view can name a
   Report the catalog already allows. It cannot unlock a dimension the
   registry did not declare.
6. **Inference is boot-time and pure.** `deriveCatalog` and `resolveReport`
   run without Mongo and are pinned by unit tests, like `validateRegistry`
   and `summarizeStages`.

---

## 12. Work plan

In order; each step ships on its own.

| # | change | files | tests |
|---|---|---|---|
| 1 | ✅ 2026-09-07 — `deriveCatalog()`; `/registry` and `describe_telemetry` serve it; delete both `registryProjection` | `catalog.ts`, dashboard.ts, mcp.ts | `catalog.test.ts` — zod walk cases, envelope dims, `exactVia` |
| 2 | ✅ 2026-09-07 — `Report` type; `ViewSpec.query` lifted; `resolveReport()` | `report.ts`, views.ts | `report.test.ts` — one case per resolver row, no Mongo |
| 3 | ✅ 2026-09-07 — `breakdown()` primitive + `/breakdown` route + `limits.breakdown` | query.ts, dashboard.ts | in `dashboard.test.ts` against memory Mongo |
| 4 | ✅ 2026-09-07 — `executeReport()` + `foldRollups()` in a new `execute.ts` (report.ts stays pure); `GET /api/report` + `/api/report/plan`; `run_report` takes an inline Report; new `plan_report`; the URL encoding | execute.ts, report.ts, dashboard.ts, mcp.ts | `execute.test.ts` (fold + round trip, no Mongo), dashboard.test.ts, `mcp.test.ts` |
| 5 | ✅ 2026-09-07 — `createValues()`; `GET /api/values`; mcp `dimension_values`; `limits.values` | `values.ts`, dashboard.ts, mcp.ts | `values.test.ts`, dashboard.test.ts, mcp.test.ts |
| 6 | ✅ 2026-09-07 — UI: Explore page, FilterBar pickers, pages read the catalog, `cost_usd` literals gone, funnel picker + inferred order, derived views ×5, `ViewSpec.display` deleted. util.js imports report.ts, so the SPA and the router share ONE encoder and ONE resolver | pages.jsx, shell.jsx, atoms.jsx (`ReportView`, N-series `TimeSeries`), util.js, api.js, App.jsx, views.ts | `views.test.ts` (pure), dashboard.test.ts, mcp.test.ts |
| 7 | ✅ 2026-09-07 — System suggestions; `rollupSkipped` per family. `SuggestionList` plus a table per attributed counter map render on the System page | suggest.ts, rollups.ts, emit.ts, ingest.ts, types.ts, dashboard.ts, mcp.ts, pages.jsx, atoms.jsx | suggest.test.ts, rollups.test.ts, emit.test.ts, dashboard.test.ts, mcp.test.ts |
| 8 | ✅ 2026-09-07 — Docs: new `guide/reports.md`; `guide/dashboard.md` (pages table + views + System), `guide/queries.md` (Reports trimmed to a pointer + the rule table), `guide/mcp.md`, `guide/registry.md`, `reference/http-admin.md`, `reference/types.md`, `reference/routers.md`, introduction/index/README, VitePress sidebar; CHANGELOG `[Unreleased]` consolidated (additive except `run_report`'s return shape). Version bump deferred to the owner | docs/, CHANGELOG.md | `npm run docs:build` |

Steps 1–5 are server-side and small; 6 is the bulk. Nothing before 6 changes
what a viewer sees, so the package can publish 0.4.0 after 5 and hosts can
build on the API before the SPA catches up.

---

## 13. Open items

Steps 1–8 are shipped, so what remains is what the shipping surfaced.

- [ ] **Write-time linking** — `t.link()` (§10): alias + one-shot milestone
      merge + ingest enrichment. Separate plan, `linking.md`. Needs the
      multi-machine rule (one user, three machines: milestones take `$min
      firstAt`, bucketed activity stays one doc per (user, day)), the erasure
      path (a linked user's docs are sole-party; the machine's are not a
      person), and whether the desktop still calls `identify()` at all once the
      server links at activation.
- [ ] **`compare` on an exact plan is unverified against bucket alignment.**
      `executeReport` runs `plan.previous.args` for every primitive, exact ones
      included, but a previous window that does not align to bucket starts
      would compare a partial bucket to a whole one — and the risk is worst when
      the family's bucket is coarser than the range length. Raw plans compare
      cleanly. An exact plan should SAY when it cannot compare cleanly rather
      than answering anyway.
- [ ] **`limits.breakdown` default** — 50 top groups is a starting point;
      measure on maxed and StoryFolder before pinning. (`breakdown()`'s SECOND
      ceiling is now reported: `bucketsTruncated`, `limits.series` buckets per
      returned group — it was the one cap in the package that could cut an
      answer silently.)
- [ ] **Percentiles per group** — `resolveReport` refuses `pNN:<metric>` with a
      `groupBy` today, because `distribution()` answers one sample and per-group
      would be N reads. Either cap it (≤ 5 groups, one read each) or teach
      `distribution()` a `groupBy` with a `$percentile` per bucket; the second is
      one pipeline but loses the histogram. The refusal already names the option
      and says to drop the groupBy or filter to one group.

Closed 2026-09-07, by step 4:

- [x] **`RecordFilter` has no name-set term** — it does now (`name: string |
      string[]` → one `$in`, `?name=a,b` on every filtered route), so a
      namespace or family source is planned as its exact name set and reported
      `raw` rather than `scan`. The refusal that said "read the family, or pick
      one event" is gone.
- [x] **`sum:`/`avg:durationMs` was unanswerable** — the shared measure
      accumulator now resolves `durationMs` to the ENVELOPE field, so
      `series()`/`breakdown()` read what a span actually carries and the
      resolver plans it instead of refusing it. `catalog.ts` needed no change:
      it already declared the measure for spans.

Closed 2026-09-07, by step 6:

- [x] **Two-dim groupBy rendering** — decided against small multiples and
      against a pivot: `rowsToSeries` joins the dim tuple into one series label
      (`opus · web`), keeps the top six by total and folds the rest into an
      `other (N)` series, so a chart of the top six never reads as a chart of
      everything. `BreakdownTable` renders one column per dim when there is no
      time axis, labelled from `plan.shape.labels` — the family's own dim
      labels — falling back to the Report's `groupBy` keys.
