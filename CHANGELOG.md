# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A **peer range widening** is a minor. A peer range *narrowing* is a major — it
breaks installs for people who were relying on the claim, and the claim is only
real if CI runs the matrix. See standards/traps.md #10.

## [0.4.0]

### Added
- **`deriveCatalog(registry)` — the registry, inferred into what a reader can
  actually ask.** Every dimension typed off its zod schema, with its closed
  value domain when it has one and an `indexed` flag distinguishing a lookup
  from a scan; the measures each event supports; and, per `sum:`, the rollup
  families that answer it exactly (`exactVia`). `/api/registry` and
  `describe_telemetry` both serve it under a new `catalog` key — the `registry`
  key is byte-for-byte what it was, so no shipped client notices. Pure and
  boot-time, like `validateRegistry`. The point is that nothing is written
  twice: a page that names `cost_usd` is restating a fact the registry already
  carries, so `projectRegistry()` is now the only projection in the package
  instead of two copies drifting in dashboard.ts and mcp.ts.
- **The `Report`, and `resolveReport()` — the pure planner over the nine
  primitives.** A Report says what is being counted (`source`), over what range,
  by what dims and with what measure; the resolver picks the primitive that
  answers it — the cheapest EXACT one first (a rollup family whose docs already
  are the answer), then raw, then a refusal that names the offending key and the
  registry change that would fix it. `Plan.args` is positional and spreads
  straight into the primitive it names, so `q[plan.primitive](scope,
  ...plan.args)` is the whole executor, and every plan carries `exactness`
  (`exact` / `raw` / `scan`) to be rendered rather than guessed at. Pure and
  deterministic given `now`, like `deriveCatalog`. `rangeOf()` and
  `intervalForRange()` ship beside it — the range shorthands the UI has always
  used, now resolvable on the server, and an unknown one throws instead of
  quietly answering about seven days.
- **`executeReport()` — the Report, run. `GET /api/report` and
  `GET /api/report/plan`; `run_report` takes an inline Report; new
  `plan_report`.** The resolver picks a primitive, this dispatches it, and the
  answer carries the plan it ran — `exactness`, the family it went `via`, and a
  `why` — so a number can always say how it was got. One executor, three doors:
  the HTTP route, the dry run, and the MCP tools cannot answer the same Report
  differently.

  A `rollups` plan is **folded** into the same row shape `breakdown()` returns
  (`foldRollups`, pure and unit-tested without Mongo): a family's docs already
  ARE the requested groups, so `count`/`sum:`/`avg:` over them is arithmetic
  rather than a second query, and a renderer never learns which store answered.
  The suite asserts the folded numbers equal a `breakdown()` over the same
  records, row for row — which is what makes "prefer the exact plan" free.

  **A Report is a URL.** `parseReportQuery`/`reportToQuery` are inverses and are
  the only encoding: `source=event:<name>|namespace:<ns>|kind:<kind>|family:<as>`,
  `range=7d` or `from`+`to`, comma-separated `groupBy`, and a repeatable
  `filter=<dim>:<op>:<value>` whose dim may itself contain a colon, so the term
  splits at the first operator token. Unknown params are ignored; a malformed
  one is a `400` naming the param. A refusal is a **`200`** on `/api/report/plan`
  and a **`400`** on `/api/report` — a greyed option with a reason beats a query
  that 400s, but by the time someone asked for data it is an error.
- **`breakdown()` — the ninth read primitive**, with `GET /api/breakdown` and
  the `event_breakdown` MCP tool. Top groups of a measure by one or two
  dimensions (`attr:<key>`, an allowlisted `field:<path>`, `subjectType`,
  `actorType`), optionally split by interval. It replaces the Events page's
  fifty-row client-side grouping, which answered "this page" while reading as
  if it answered the range. **The cap is on groups returned, never on rows
  scanned**: the `$limit` sits after the `$group`, so truncation keeps the TOP
  groups by measure rather than an arbitrary prefix, and a record missing the
  dimension is a `null` group rather than a dropped row.
- **`createValues()` — the observed domain of a dimension**, with
  `GET /api/values` and the `dimension_values` MCP tool. "What values does this
  dimension actually take" is the question standing between a report builder and
  every filter it offers, and it is answered from whichever of four sources is
  cheapest, with the response SAYING which: the registry's own `z.enum`
  (`catalog`, no read at all), a rollup family keyed by that dimension
  (`rollups`, one indexed `$group`, with counts and the family named in `via`),
  an indexed attr or envelope dim over a range (`raw`), or nothing (`none`).
  `none` is an ANSWER, never a throw — including for a dimension that would need
  a range and was given none: the caller's fallback is a free-text box with a
  *scan* badge, and an exception there would render an error page over a working
  control. It is deliberately NOT a tenth primitive — it reads the catalog,
  which the primitives do not — so it is its own factory beside `createQueries`.
- **`deriveSuggestions()` — the data tells the registry.** Everywhere else in
  this package the registry says what the data may be; this reads it backwards.
  Three sources, each one registry line from being fixed: an attr key that keeps
  arriving undeclared, a rollup family that keeps losing a dimension, a name
  nobody registered. Each `Suggestion` carries a `message` a human reads and a
  `fix` that is **pasteable code** — the zod line (or the whole
  `attrs: z.object({ … })` block when the spec declares no attrs), a
  `dimDefault` line commented with every spec that feeds the family, or a
  minimal registry stub. Pure and testable without Mongo, like `deriveCatalog`
  and `resolveReport`; sorted loudest-first and capped at 50. Served on
  `GET /api/system` under a new `suggestions` key and by the `telemetry_health`
  MCP tool, derived from the counters and quarantine rows those handlers
  already fetch, so it costs no extra read. Nothing is written — the host still
  edits the registry by hand, the package just stops making it guess.
- **The SPA gains an Explore page — the report builder.** Source → measure →
  group by → interval → compare, every control populated from the catalog and
  every option pre-checked by `resolveReport`, so an unanswerable combination is
  greyed with its `why` rather than submitted. Its URL *is* the Report, which is
  what makes a shared link, a saved view and a sidebar entry the same object.
  Events, Usage and the Overview tiles are the same surface with the source
  fixed; a tile whose Report this registry cannot answer is not rendered at all,
  rather than filled from a wider read. `cost_usd` no longer appears in a `.jsx`
  file — the money measure is the first `*_usd` the catalog reports.
- **A funnel stage picker, with the default order inferred from data.** The
  lifetime single-subject families of the chosen `subjectType`, multi-select and
  reorderable, saved as a view; `exits` from the same list. Two orderings are
  offered — registry (the order the host typed) and observed (median `firstAt`,
  one capped rollup read per candidate family, a family nobody reached sorting
  last). Sort-by-count is deliberately **not** offered: a funnel that reads as
  monotonic because its stages were sorted by size hides exactly the anomaly
  worth seeing.
- **`ReportView`** renders any Report from its plan alone — funnel steps,
  distribution, records table, distinct-count tiles, N-series stacked charts,
  breakdown tables — with the `exactness` badge and truncation notes above every
  one. The `SuggestionList` and the two attributed counter tables render on the
  System page.
- **Three new MCP tools** — `event_breakdown`, `dimension_values` and
  `plan_report` — bringing the suite to seventeen.

### Changed
- **`ViewSpec.query` is a `Report`.** Every view saved before this parses
  unchanged: the type is `Report | LegacyQuery`, `spec` is a Mixed document, and
  `normalizeQuery()` lifts the old `{ range, filters, groupBy, sort }` shape —
  `filters.name` to an `{ event }` source, `filters.rollup` to a `{ family }`
  one, `filters.kind` to a `{ kind }` one, the rest to `{ dim, op: 'eq', value }`
  terms. It returns `null` when nothing names a source, because such a query is
  a page's default rather than a Report, and the caller's own fallback is the
  honest answer.
- **`deriveViews(registry, catalog?)` writes five shapes, not two.** Per event
  and per family as before, plus per **namespace**, per **usage meter** (its
  `*_usd` sum per day), and one **funnel per subject type**. Still zero config,
  still registry order so the sidebar does not reshuffle between requests. A
  namespace of one event and a subject type with fewer than two milestone
  families are skipped — both would be a second name for a view that already
  exists. The catalog argument is optional and derived on demand, so the
  one-argument call still works; `resolveViews()` takes the caller's boot-time
  catalog so a request does not build a second one.
- **`run_report` returns the executed Report and its plan** —
  `{ report, plan, result, previous?, dataSource }` — rather than a bare result.
  **Breaking for MCP consumers** that read the old top-level result keys; the
  package is 0.x and the plan is the half an agent most needs, because it says
  which store answered and how exact the number is. A stored view written before
  Reports still runs: it comes back marked `legacy: true` with its records.
  `list_reports` entries carry the Report's `source` in place of the `display`
  hint.
- **`RecordFilter.name` accepts a list** — `{ name: ['a', 'b'] }` becomes one
  `$in`, and `?name=a,b` on any filtered route splits on the comma (event names
  cannot contain one; a single name is unchanged, string in and string out).
  The reason is a wrong answer this removes: a namespace or a rollup family is
  several event names, and with no set term the widest honest read for one was
  "every record of that kind in the range". `resolveReport` now pins those
  sources by their exact name set and reports them as `raw` instead of `scan`.
- **`breakdown()` reports `bucketsTruncated`.** Its per-interval pass has always
  had a ceiling of its own — `limits.series` buckets per returned group — and it
  was the one cap in the package that could cut an answer without saying so. Now
  read as cap+1 like every other, and reported separately from `truncated`
  because the two cut different axes: one drops groups, the other drops periods
  of a group you were given. Always `false` with no `interval`.
- **`sum:durationMs` / `avg:durationMs` read the envelope.** A span's duration is
  not a declared metric, so resolving the measure to `metrics.durationMs` made
  `series()` and `breakdown()` aggregate a path no record carries and report a
  confident `0`. The branch lives in the one shared measure accumulator, so both
  primitives agree, and `resolveReport` can plan `avg:durationMs` instead of
  refusing it.
- `QueryLimits` gains `breakdown` (default 50 **groups**) and `values` (default
  200 **values**), and its doc comments now say which caps bound the output —
  `records`, `series`, `rollups`, `trace`, `journey`, `breakdown`, `values` —
  and which bound the scan: `distribution`, `distinct`, `funnel`. One word, two
  meanings, and only the second kind makes the numbers an undercount.
- **`TelemetryCounters` gains two attributed maps — `rollupSkippedBy`
  (`` `${family}|${dimLabel}` `` → count) and `undeclaredAttrs`
  (`` `${name}|${attrKey}` `` → count).** Additive: the seven scalars keep
  their names and their meanings, so anything scraping them onto a `/metrics`
  endpoint is untouched. They exist because a scalar says something went wrong
  without saying where — `rollupSkipped: 12` is not an instruction, while
  `{'screens_viewed|name': 12}` is a `dimDefault` you can go and declare. Both
  bound at 1000 distinct keys (`COUNTER_MAP_MAX`), after which new keys fold
  into `COUNTER_OVERFLOW_KEY` (`'(other)|(other)'`): the keys are
  client-controlled, so an unbounded map would be a way to grow the process
  heap from outside. Totals stay honest; only the attribution stops.

  `undeclaredAttrs` observes rather than changes: an undeclared attr key has
  always failed the strict parse and quarantined the whole record, on both the
  `emit()` and the ingest path. What is new is that forty identical failures now
  group into one sentence naming the key, instead of forty quarantine rows
  nobody reads.

### Removed
- **`ViewSpec.query.display`.** A dead field: the SPA passed it into the hash
  and no page read it. With a Report the renderer is decidable — `groupBy` +
  `interval` is a stacked series, `groupBy` alone a breakdown table, `interval`
  alone a series, neither a stat tile, `funnel` the funnel steps — so the hint
  had nothing left to hint at. A stored view still carrying the key keeps
  parsing (`spec` is Mixed) and the key is ignored. A chart/table toggle, if one
  is ever wanted, is a UI preference and not view state.

## [0.3.0]

### Added
- `beforeSend` on `CreateClientOptions` — the last gate before a record joins
  the queue, and the one place every kind passes through. Return the record to
  keep it, a modified copy to redact it, `null` to drop it. A throwing hook
  drops the record and reports via `onError` (fail-closed: a half-applied
  redaction that still ships is worse than a lost record).
- `/web`: `ignoreErrors` (strings match by substring, RegExp by `test`) and
  `BENIGN_BROWSER_ERRORS`, the browser-raised non-errors filtered by default.

### Changed
- **`/web` now drops `ResizeObserver loop completed with undelivered
  notifications` (and `loop limit exceeded`) by default.** Chrome raises these
  as uncaught errors when an observer callback dirties layout; nothing is
  broken and nothing is actionable, but they fire often enough to bury real
  errors — one production host saw 49 of its last 50 error records come from
  this one message. Hosts that were counting them will see the count go to
  zero; `captureBenignErrors: true` restores the old behavior.

  Filtering here rather than at the platform edge is the point: swallowing
  `window.onerror` before the SDK sees it means winning a listener-registration
  race, and it misses every `captureError()` the app calls directly.

## [0.1.0] — first release

### Added
- Server core: host-owned registry, discriminated envelope (event / error /
  span / state / usage) on one Mongo collection, the rollup primitive, `emit()`,
  `forget()`, checkpoints.
- Write contract: idempotent `emit()` via `dedupeKey`, declarable durability
  (`EventSpec.durable` / per-call override), `EmitResult` outcomes, a boot
  warning when a spec's `data` inherits a finite TTL it never chose, and a
  stated cap + truncation marker on `body`.
- Ingest router and isomorphic client core, with adapters for web, React, Vue,
  Electron, and CLI. `pk_`/`sk_` key model; a publishable key never returns 4xx.
- Dashboard: six query primitives (records, series, distribution, rollups,
  trace, journey, funnel) plus `distinctCount`, the `ViewSpec` system, and the
  full React SPA.
- Cohort funnels ported from a real production host and proven against it cell
  by cell, and exact distinct counts with no approximation.
- A platform scope (`Viewer.tenantId: '*'`) for cross-tenant reads, authorized
  entirely by the host's `viewerAdapter` — `'*'` is reserved on every write path.
- `scripts/check-exports.mjs`, which diffs the built bundle against the
  hand-written `types/` declarations so the published contract cannot drift
  from what the package actually ships.
- Full VitePress documentation.
