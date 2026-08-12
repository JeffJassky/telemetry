# Telemetry Dashboards

The read surface over [schema.md](./schema.md)'s storage and
[instrumentation.md](./instrumentation.md)'s ingest. Normative for the query
API, the UI architecture, and the design language.

---

## 1. Design position

The schema's rule — *one envelope, sparse typed extensions* — repeats here as
**one view engine, sparse kind-specific components**. And the registry stays
the contract: `indexedAttrs` declares what filters fast, `metrics` declares
what charts, `rollups` declares what families exist. The dashboard *derives*
from the registry; adding an event to it lights up filtering, charting, and a
rollup explorer with **zero UI code**. UI written per event name is the
over-fit alarm.

---

## 2. Query layer — six primitives

Everything the UI renders comes through six read functions. Kind pages never
touch Mongo. This seam is what lets `span`/`event` route to ClickHouse later
(schema §8) without touching a component.

| primitive | reads | serves |
|---|---|---|
| `records(filter, sort, cursor)` | raw envelope | tables, lists, detail drawers |
| `series(match, measure, interval)` | raw + `$dateTrunc`/`$group` | time-series at query time |
| `distribution(match, measure)` | raw + `$percentile` | latency/size histograms (keep-all makes this exact, schema §5.3) |
| `rollups(as, dims?, on?, range?)` | rollup families | issues, spend, activity, funnels |
| `trace(traceId)` / `journey(subjectRef, range)` | correlation indexes | the two join views (§6) |
| `distinctCount(as, range, interval?)` | bucketed subject families | DAU/WAU/MAU, exact |
| `funnel(stages, cohort, interval?)` | lifetime milestone families | cohort funnels, conversion, median time-to-step |

The sixth arrived with the cohort math (cohort-math.md). Two notes that are
contract, not implementation:

- **`distinctCount` needs no sketch.** A family declared `by: ['subject']` with
  a bucket already writes exactly one doc per (subject, bucket), so distinct
  subjects per bucket IS the doc count and distinct-over-a-range is a `$group`
  on `dims`. Exact, no write-path change, no new storage. It **throws** when the
  named family has no subject dim or no bucket — that is a registry mistake, and
  a silently-wrong number is the failure mode this package exists to prevent.
- **`funnel` ships the math once.** Stage ordering, the cohort window, and the
  median time-to-step aggregation are what every host rewrites. The funnel is
  LITERAL (a later stage may exceed an earlier one, and `pctOfPrevious` may
  exceed 100%); medians average the two middles; `pctOfPrevious` is `null`, never
  0 or Infinity, when the previous stage is empty. `notReached` (reached k−1, not
  k) and `stalledAt` (reached k, not k+1) are two quantities with two names,
  and `stalledAt` is `null` on the terminal stage.

**Interval convention.** Every range in the read layer is half-open
(`$gte`/`$lt`). The one documented exception is the funnel's cohort window,
which takes an explicit `endInclusive` (default `false`) because maxed's is
closed on both ends — and it is translated to a half-open bound inside
`funnel.ts`, so no `$lte` reaches the rest of the query layer.

**No silent caps.** `rollups`, `distinctCount`, and `funnel` all return
`truncated: boolean`. A response that was cut off by a cap says so; the caps
themselves are `QueryLimits` config.

Every primitive takes a **scope** as its first argument, never a raw filter that
could omit one. A scope is a tenantId — or `'*'` (`PLATFORM_SCOPE`), the
cross-tenant read. Exposed two ways, both from the server entry:

- **an express sub-router** (`/api/*`) the dashboard SPA calls, and
- **a headless client** for hosts that want to build embedded views — per
  house-style, that is the sanctioned path for in-host UI; React components are
  never exported into the host tree.

Access control is a named inbound adapter, same shape as ingest's
`contextAdapter`: `viewerAdapter.resolveViewer(req) → { tenantId, role } | null`.
The dashboard refuses to mount without it — an unauthenticated telemetry
dashboard is a data leak with charts.

### 2.1 The platform scope (decided 2026-08-12)

A host running a support console or a platform-wide cost dashboard needs a
cross-tenant read. Before this, the only way to get one was to bypass `scoped()`
and hit the model directly — so the escape hatch existed anyway, it just lived
outside any boundary the package could reason about. Making it expressible is
strictly safer than pretending it does not exist.

`Viewer.tenantId === '*'` is that scope. Three rules make it safe:

1. **The package never decides who is a platform admin.** `'*'` reaches the
   query layer only because the host's own `viewerAdapter` put it on a `Viewer`
   — an authorization decision that has already been made, by the only party
   that can make it. No role name, header, or config flag infers it.
2. **`'*'` is reserved on the write side.** Otherwise a tenant literally named
   `*` silently becomes a cross-tenant read: privilege escalation via a string.
   `emit()` quarantines it, `forget()` and fixed-mode `createKey()` throw, and
   ingest refuses the batch after tenant resolution — covering the claimed,
   session, and fixed paths in one place, because all three mint a tenantId from
   outside the package. No stored row can carry `'*'`.
3. **`scoped()` was deliberately NOT taught about it.** It is the host-facing
   isolation primitive and its guarantee is worth more unconditional: whatever
   string goes in, only rows carrying it come out. `scoped('*')` therefore
   matches the literal `'*'`, which is to say nothing. The escape hatch belongs
   one layer up, behind the viewer adapter, where an authorization decision
   actually happened.

Consequences worth stating rather than discovering:

- `records`/`rollups`/`trace`/`journey` return each row's `tenantId`, and the UI
  renders it as a column under `'*'` — a cross-tenant number that cannot say
  which tenant it came from is unusable. The shell carries an "all tenants"
  badge so the scope is read before the numbers are.
- `series` and `distribution` aggregate **across** tenants under `'*'`: one
  bucket per interval, every tenant summed into it. That is the platform-wide
  chart, not a bug. A per-tenant breakdown is a different question — ask it with
  `rollups()`, or scope to a tenant.
- A subject ref and a traceId are unique only *within* a tenant, so a `'*'`
  journey or trace can legitimately braid two tenants together. The per-row
  `tenantId` is what keeps that readable.

---

## 3. The shell

Chrome that exists because the *envelope* guarantees the field — works
identically for all five kinds:

- **time range + bucket picker** — bucket options are exactly the rollup units
  (`hour | day | week | month`); custom ranges fall back to `series()`
- **env / service / release** selectors (every record carries them, hook-filled)
- **kind / name** picker fed from the registry
- **subject scope** — pin the whole dashboard to `user:u_1` / `org:o_9` /
  `session:ses_x`; every primitive accepts the same `subjectKeys` term
- **severity** filter
- **filter bar, registry-generated:** `indexedAttrs` → equality chips (fast),
  `indexedMetrics` → range inputs (fast), other declared attrs → chips with a
  "scan" badge (bounded by `{tenantId, name, occurredAt}` — fine at this scale,
  labeled so nobody wonders), `data` → not filterable, by design
- **URL state** — every screen state is a shareable link; views (below) are
  named URLs

### Views — one shape, three producers

A view is nothing but named query state:

```ts
interface ViewSpec {
  name: string
  icon?: string
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview'
  query: {
    range?: string                      // '24h' | '7d' | '30d' | explicit
    filters?: Record<string, unknown>   // same terms the filter bar emits
    groupBy?: string
    sort?: string
    display?: 'table' | 'series' | 'breakdown' | 'stream'
  }
}
```

Three producers of the same shape — this is the DRY line: no producer gets its
own format, renderer, or storage semantics.

1. **Derived** — generated from the registry at load, zero config: one per
   event name (pre-filtered Events view), one per rollup family
   (RollupExplorer preset), one per service. They exist because the registry
   already knows enough to write them.
2. **Configured** — the host passes `views: ViewSpec[]` to `createDashboard()`.
   Versioned in code, shipped with the app — "Checkout errors", "LLM spend by
   feature".
3. **Saved** — any current URL state plus a name, stored in `telemetry_views`:
   `{ _id, tenantId, ownerRef, shared, spec, createdAt }`. Private to the
   viewer by default; `shared: true` publishes it to the tenant.

Views scope on the viewer's scope string **literally**, `'*'` included — they do
NOT fan out under the platform scope the way the query primitives do. `'*'` is
an escape hatch for reading telemetry, not a master key to other people's saved
state, so a platform viewer's views live in their own namespace: invisible to
every tenant, every tenant's invisible to them, and neither can delete the
other's (the delete/ownership lookup matches the scope literally too, and a
platform viewer's `role: 'admin'` is admin *of* the platform scope). Both
directions fall out of one literal match.

> **Stated bound.** `forget(tenantId, ref)` is tenant-scoped and `'*'` is not a
> tenant, so a person's platform-scoped saved views are not erased by a
> `forget()` against their home tenant. Widening `forget()` to reach `'*'` rows
> would give a tenant-scoped call cross-tenant write reach — the trade we
> refused. Erase them by their scope, or not at all.

Quick-select renders as a sidebar section (mailery's `.sidebar-section`
pattern): saved + configured on top, derived grouped by kind below — all plain
links, because a view *is* a URL. Name collisions resolve saved → configured →
derived, so a user can shadow a default without editing anything.

Erasure note: `ownerRef` is a person. `forget()` deletes that viewer's private
views and redacts `ownerRef` on shared ones — same delete-vs-redact rule as
schema §4.7.

---

## 4. Atoms

Ten components, kind-blind by law: an atom takes data + column/series specs and
never knows an event name.

| atom | job |
|---|---|
| `StatTile` | one number + delta vs previous window (mailery `.kpi`) |
| `TimeSeries` | line/bar over buckets |
| `BreakdownTable` | group by dim → count/sum/avg, sortable — the "top N" workhorse |
| `DistributionChart` | histogram + p50/p95/p99 markers |
| `RecordTable` | envelope columns + kind extension columns, cursor-paged |
| `RecordDetail` | drawer: envelope section, payload section, kind panel slot |
| `StreamList` | chronological timeline, kind-iconed |
| `FunnelSteps` | ordered steps + conversion between them — renders `funnel()`'s rows verbatim, including the nulls |
| `Waterfall` | span tree on a time axis |
| `TransitionMatrix` | from→to grid with counts + avg dwell |

**Formatting is convention, not configuration:** `*_usd` → currency,
`*_ms` / `duration*` → duration, `tokens_*` / counts → compact notation,
timestamps → relative under 24h. A registry `ui` hint exists only for the case
conventions can't infer — resist populating it.

---

## 5. Kind pages — one bespoke component each, maximum

| kind | primary view (atom composition) | bespoke |
|---|---|---|
| `error` | issue list = `rollups('issue')` → BreakdownTable; issue detail = header (first/last/count/first-release from the rollup) + recent raw events + RecordDetail | **StackTrace** (frames, `inApp` collapse, source-map slot) |
| `span` | recent/slow RecordTable; DistributionChart by indexed attr | **Waterfall** |
| `state` | TransitionMatrix; per-subject StreamList; stall table = BreakdownTable of avg `previousSinceMs` | **TransitionMatrix** |
| `event` | TimeSeries + BreakdownTable + RecordTable | **none** |
| `usage` | StatTiles + TimeSeries by meter + BreakdownTable by `billedTo`/attrs; reversal rows rendered as linked pairs | **none** |

A kind page wanting a second bespoke component means an atom is missing its
abstraction. Stop and find it.

---

## 6. The two join views — the actual product

The unified envelope's payoff is precisely the two views no per-kind vendor
can render:

- **Trace** — `trace(traceId)`: request span, LLM calls, the error, the event,
  the usage row, one time axis. Waterfall + StreamList for non-span kinds +
  RecordDetail.
- **Journey** — `journey('user:u_1')`: every kind interleaved chronologically,
  milestone rollups as chapter markers, state transitions as section breaks.

Both are one indexed query (schema §2.5, §3). They get top-level nav slots, not
per-kind tabs — they are why this dashboard exists instead of five vendor tabs.

---

## 7. RollupExplorer — free dashboards

Rollup families are self-describing (`as`, `by`, `bucket`, `sum`), so one
explorer renders every family: dims → group/filter controls, `sum` keys →
series, `bucket` → granularity floor, lifetime families → first/last/count
tables. `llm_cost`, `activity`, `issue`, milestones — same component. A new
`rollups` block in the registry is a new dashboard, no code, no deploy beyond
the registry change itself.

---

## 8. Pages

| page | contents |
|---|---|
| **Overview** | cross-kind StatTiles (errors today, spend MTD, DAU via `distinctCount`, p95), recent issues, recent traces |
| **Errors** | issue list → issue detail |
| **Traces** | recent/slow → Waterfall |
| **Events** | explore: series + breakdown + table |
| **Journeys** | cohort funnel (`funnel()`), retention, activity (RollupExplorer) + subject lookup → Journey view |
| **Usage** | spend tiles, per-meter series, `billedTo` breakdown |
| **System** | quarantine browser, `telemetryCounters` (rejected/capped/sampled/rollupSkipped/deduped/truncated), index budget vs 64-cap, key list + revoke. This page is where "never drop silently" becomes visible — it is not optional |

---

## 9. Design language — adopted from mailery

Token system lifted **verbatim** from `mailery/src/client/styles.css` — same
custom-property names, same light/dark structure via `[data-theme="dark"]`,
same type stack (Inter + JetBrains Mono, 14px base, `tabular-nums` for every
number), same shell dimensions (`--sidebar-w: 232px`, `--topbar-h: 56px`,
`--content-max: 1240px`), same radii/shadow scales.

**One swap: the accent family.** Mailery is warm orange; telemetry takes
violet (`--accent: #7c3aed` light / `#a78bfa` dark, soft/press/border derived
the same way). Everything else in the brand block is untouched, so the two
dashboards read as siblings, not clones.

Reused component patterns, as-is: `.card`, `.table` (sunken headers, hover
rows), `.pill` + `.tag`, `.kpi`, `.filter-chip`, `.tabs` + `.seg`, `.split-*`
two-pane layouts, `.status-dot`, `.empty`, `pre.code`, sidebar/topbar shell.

**Semantic mapping — telemetry's one addition to the vocabulary:**

| token | severity | kind |
|---|---|---|
| `--red` | error / fatal | `error` |
| `--amber` | warn | `state` |
| `--blue` | info | `event` |
| `--violet` | — | `span` (accent-adjacent: traces are the brand) |
| `--green` | — | `usage` (money = green, universally) |
| `--fg-subtle` | debug | — |

Charts use the semantic set plus `--border` gridlines and `--fg-subtle` axis
text, exactly as mailery's `.chart-axis`/`.chart-grid` already define. Charts
are hand-rolled SVG like mailery's sparklines — no chart library until an atom
proves it needs one.

---

## 10. House-practice conformance

Checked against `standards/`:

- **Express router the host mounts, never an app** — dashboard = one router
  serving `/api/*` + built SPA with hashed assets and SPA fallback
  (house-style UI rule, template `build:ui` path).
- **React even though hosts are Vue** — the SPA-at-mount-path pattern makes the
  host framework irrelevant. No `.vue` shipping problem.
- **No component exports into the host tree.** Embedded needs = headless query
  client + host-built views (the house corollary). If a genuine embedded
  widget emerges later, the sanctioned answer is a web component and it needs
  a real argument first.
- **Adapters named, both directions** — inbound `viewerAdapter.resolveViewer`
  (who may look) alongside ingest's `contextAdapter`; outbound stays
  `forget()`.
- **Tests** — query primitives get vitest + `mongodb-memory-server` +
  `supertest` against the mounted router: real HTTP, real Mongo, no mocks.
- **Docs** — VitePress pages: one per atom, one per adapter concept, one per
  kind page.
- **Cross-package deps as optional peers** — if another foundry package wants
  `telemetry.track`, it takes a callback with a no-op default; nothing here
  hard-depends on a sibling.

---

## 11. Laws (anti-over-fit)

1. Atoms are kind-blind — data + specs in, pixels out.
2. Pages speak only the six query primitives.
3. One bespoke component per kind, budgeted; `event` and `usage` prove zero is
   achievable.
4. The registry drives filters, charts, and explorers — a new event or rollup
   family never means UI code.
5. Tokens over styles: a component that hardcodes a color is wrong even when
   the color is right.
6. A view is a named URL. If a view needs state a URL cannot hold, the query
   layer is missing a parameter — fix that, not the view format.

---

## 12. Open items

- [ ] **Live tail** — a polling `records()` view is cheap and probably enough;
      websockets are not justified at this scale until proven otherwise.
- [ ] **Issue workflow state** (status/assignee/snooze) — deliberately not
      telemetry (schema §10); if built, it is a sibling collection the Errors
      page joins in, and the dashboard treats it as host data.
- [ ] **Retention curves view** — the `activity` family supports week-N curves
      (schema §5.4); needs its own FunnelSteps-adjacent rendering decision.
- [ ] **Chart accessibility** — series must remain distinguishable without
      color (dash patterns / markers) before shipping, not after.
- [ ] **Viewer authorization granularity** — `resolveViewer` returns a role;
      whether System (keys, quarantine) needs a stricter role than Overview is
      a host decision the adapter should be able to express.
