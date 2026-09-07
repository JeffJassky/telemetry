# Admin HTTP API

Every route mounted by [`createDashboard`](/reference/routers#createdashboardoptions)
under `<mountPath>/api`. The SPA calls nothing else, which is the seam that lets
you replace the UI entirely.

## The gate

Every route below is preceded by one middleware that calls
`viewerAdapter.resolveViewer(req)`. A `null` viewer, or one without a
`tenantId`, ends the request:

```
401 { "error": "unauthenticated" }
```

JSON, never a list, never a redirect. The resolved `Viewer` supplies:

- **`tenantId`** — the read scope for every primitive. `'*'` (`PLATFORM_SCOPE`)
  drops the tenant term and nothing else. A viewer cannot widen its own scope
  through the query string: `?tenantId=*`, `?scope=*`, and friends are unknown
  filter terms, never a scope change.
- **`role`** — `'admin'` unlocks key listing, key revocation, and deleting
  another person's saved view. Within this scope.
- **`viewerRef`** — owns saved views.

Request bodies are `express.json({ limit: '64kb' })`.

## Errors

Every failure is JSON, never an HTML stack page.

| | |
|---|---|
| `4xx` | `{ "error": "<the thrown message, verbatim>" }` — the cohort primitives use this to surface registry mistakes with the fix in the text |
| `5xx` | `{ "error": "internal_error" }`, with the real error logged server-side |

## Shared query parameters

**Time range** — required in spirit, defaulted in practice, and validated always.

| | |
|---|---|
| `to` | ISO date. Default: now. |
| `from` | ISO date. Default: `to − 7 days`. |

The range is **half-open** everywhere: `occurredAt ≥ from`, `< to`. An unparseable
date, or `from >= to`, is `400 { "error": "invalid time range" }`. This is what
makes an unbounded read unreachable rather than merely discouraged.

**Filters** — accepted by `/records`, `/series`, `/breakdown`, and `/distribution`.

| Param | |
|---|---|
| `kind` `severity` `env` `service` `release` `traceId` | exact equality |
| `name` | exact equality, or a **set**: `name=a,b` reads both in one `$in`. Event names never contain a comma, so the split is unambiguous, and a single name behaves exactly as before. |
| `subject` | pin to one subject ref, e.g. `user:u_1` |
| `attrs` | `attrs=format:pdf,route:/reports` — equality per key. Values may contain `:`; the first one splits. |
| `metrics` | `metrics=cost_usd>0.5,tokens_in<100` — `>` becomes `$gte`, `<` becomes `$lte`. Only `[\w.]+` keys and numeric values parse; anything else is silently ignored. |
| `excludeActors` | `excludeActors=admin,system` — the customer toggle. Excludes those actor **types**. A record with *no* actor is a customer fact and always survives. |

---

## Registry

### `GET /api/registry`

The SPA's one boot call. It learns its own scope here, because a cross-tenant
number that cannot say which tenant it came from is unusable.

```jsonc
{
  "registry": {
    "llm.completion": {
      "kind": "span", "origin": "server", "subjects": ["org"],
      "description": "Single model call",
      "attrKeys": ["gen_ai_request_model", "feature"],
      "metricKeys": ["tokens_in", "tokens_out", "cost_usd"],
      "indexedAttrs": [], "indexedMetrics": ["cost_usd"],
      "rollups": [{ "as": "llm_cost", "by": ["attr:gen_ai_request_model"], "bucket": "day", "sum": ["cost_usd"], "subjects": [] }]
    }
  },
  "catalog":  { "events": {}, "families": {}, "namespaces": {}, "envelope": [], "subjectTypes": [] },
  "kinds":    ["event", "error", "span", "state", "usage"],
  "role":     "admin",
  "scope":    "acc_9",
  "platform": false
}
```

A **projection**, not the registry: names and shapes only. Zod objects are
reduced to key lists, so no validator internals ever reach the wire.

`200`. No parameters.

#### The `catalog` key

`registry` answers "what did the host declare?". `catalog` answers "what can I
ask?" — the same registry, derived once at boot into the shape a page or an
agent actually needs, so that nothing has to be written twice. It is
[`deriveCatalog()`](/reference/types#catalog-types) verbatim, and the rule it exists to
enforce is that a page may not name a metric, an attr, or a family: it asks.

```jsonc
{
  "events": {
    "llm.completion": {
      "kind": "span", "origin": "server", "namespace": "llm",
      // every declared attr, typed, with its closed domain when it has one, and
      // `indexed` marking the ones a real index answers rather than a scan
      "dims": [{ "key": "attr:feature", "label": "feature", "type": "string", "optional": false, "indexed": true }],
      // 'count', then sum:/avg:/p50:/p95:/p99: per metric. `exactVia` names the
      // rollup families that can answer this sum without touching a raw row.
      "measures": [{ "key": "sum:cost_usd", "metric": "cost_usd", "exactVia": ["llm_cost"] }],
      "families": ["llm_cost"],
      "retentionDays": 400          // EFFECTIVE — the override, else the per-kind default
    }
  },
  "families": {
    "llm_cost": {
      "as": "llm_cost",
      "by": ["attr:gen_ai_request_model", "attr:feature"],
      "labels": ["gen_ai_request_model", "feature"],   // the `x=` prefixes stored in `dims`
      "bucket": "day", "lifetime": false,
      "subjectTypes": [], "sums": ["cost_usd"], "capture": [],
      "feeders": ["llm.completion"], "retentionDays": null
    }
  },
  // the prefix before the first '.', so `billing.*` is one page
  "namespaces": { "llm": ["llm.completion"] },
  // dims EVERY record carries, in the same `field:`/pseudo-dim form a rollup
  // `by` uses, so a groupBy built from one matches what rollups.ts writes
  "envelope": [{ "key": "field:kind", "label": "kind", "type": "enum", "values": ["event"], "optional": false, "indexed": true }],
  "subjectTypes": ["user", "account", "session", "org"]
}
```

`subjectType` and `actorType` are the two pseudo-dims: they carry no `field:`
prefix because they are derived at query time from `subjectKeys` and `actor`.
`field:client.platform` reports this instance's platform enum, host additions
included.

---

## Read primitives

### `GET /api/records`

Cursor-paged raw envelopes — tables, lists, detail drawers.

Params: the time range, every filter, plus `limit` and `cursor`.

```json
{ "items": [ /* envelope documents */ ], "nextCursor": "eyJ…", "dataSource": "raw" }
```

Sorted `occurredAt` desc, `_id` desc. `limit` is clamped to `queryLimits.records`
(default 200) — the ask is a preference, the cap is the contract. Paging is
**keyset** on `(occurredAt, _id)`, never `$skip`; pass `nextCursor` back verbatim.
`nextCursor` is `null` on the last page.

Every item carries its stored `tenantId`. Under `'*'` that is what keeps a
cross-tenant row attributable, so do not project it away.

`200`, or `400` on a bad range.

### `GET /api/series`

Time series computed at query time.

Params: the time range, every filter, plus:

| | Default | |
|---|---|---|
| `interval` | `day` | `hour` \| `day` \| `week` \| `month`. Weeks start Monday, UTC. |
| `measure` | `count` | `count`, `sum:<metric>`, or `avg:<metric>`. |

```json
{ "buckets": [{ "at": "2026-07-01T00:00:00.000Z", "value": 5 }], "dataSource": "raw" }
```

`count` extrapolates by `1/sampleRate` — exact while every rate sits at 1, still
honest the day one drops. Capped at `queryLimits.series` (default 744, a month of
hourly buckets).

**Under `'*'` this aggregates ACROSS tenants** into one bucket per interval. That
is the platform-wide chart, by design.

`200`, or `400` on a bad range.

### `GET /api/distribution`

Percentiles and a histogram off raw rows. Mongo 7+.

Params: the time range, every filter, plus `measure` (default `durationMs`; any
other value reads `metrics.<measure>`).

```json
{ "p50": 120, "p90": 900, "p95": 1200, "p99": 1400,
  "min": 12, "max": 1400, "avg": 310, "n": 42,
  "histogram": [{ "min": 12, "max": 90, "n": 7 }],
  "truncated": false, "dataSource": "raw" }
```

With no matching rows the response is
`{ "n": 0, "truncated": false, "dataSource": "raw" }` — the percentile keys are
**absent**, not zero, because a p95 of zero is a claim and "no data" is not.
`truncated` is the exception: it is present on every response, because a flag you
have to check for is a flag you end up inferring.

Scan ceiling: `queryLimits.distribution` (default 100 000). `truncated` says when
it was actually hit, and when it is true every number is computed over the first
`n` matches rather than all of them. The percentiles are `$percentile` with
`method: 'approximate'` regardless — see
[Queries](/guide/queries#distribution).

**Under `'*'` this aggregates across tenants**, same as `series`.

`200`, or `400` on a bad range.

### `GET /api/breakdown`

Top groups of a measure by one or two dimensions — "which models cost the most",
"errors by release", "events by platform per week".

Params: the time range, every filter, plus:

| | Default | |
|---|---|---|
| `groupBy` | **required** | one or two dims, comma-separated — `groupBy=attr:model,field:client.platform`. Zero or three-plus is a `400`. |
| `measure` | `count` | `count`, `sum:<metric>`, or `avg:<metric>` — the same grammar `series` speaks. |
| `interval` | — | `hour` \| `day` \| `week` \| `month`. When set, each row also carries `at`. Anything else is a `400`. |
| `limit` | 50 | **groups** returned, clamped to `queryLimits.breakdown`. |

A dim is `attr:<key>`, `field:<path>`, `subjectType` (the type prefix of the
first subject ref) or `actorType`. `field:` paths are an **allowlist** — `kind`,
`name`, `severity`, `env`, `service`, `release`, `origin`, `client.platform`,
`client.appVersion`, `usage.meter`, `usage.billedTo`, `usage.unit`, `state.key`,
`state.to`, `error.type`, `error.handled` — and anything else, `data.*` included,
is a `400` naming what is allowed. A `$group` over unindexed free-form content
is an unbounded scan of user payloads, not a filter.

```json
{ "rows": [{ "dims": ["opus", "web"], "value": 412.5 }],
  "groups": 1, "truncated": false, "bucketsTruncated": false, "dataSource": "raw" }
```

With an `interval`, each row is `{ "dims": [...], "at": "2026-07-01T00:00:00.000Z", "value": 12 }`
and rows are ordered by `at`. A record missing the dimension groups under `null`
rather than being dropped.

Cap: `queryLimits.breakdown` (default 50) bounds the **groups returned, never the
rows scanned** — the scan is bounded by the range and the indexes exactly as
`series` is. `truncated` therefore means "more groups existed", and the ones you
were given are the top by measure over the whole range. `groups` is how many came
back.

With an `interval` there is a second ceiling and a second flag:
`bucketsTruncated` says the per-bucket pass hit `queryLimits.series` buckets per
returned group, so a group you were given is missing periods. The two cut
different axes — one drops groups, the other drops buckets of a group that IS
shown — and `bucketsTruncated` is always `false` without an `interval`.

**Under `'*'` this aggregates across tenants**, same as `series`: one set of
groups with every tenant summed into them.

`200`, `400` on a bad range, an unknown dim, an ungroupable path, a bad interval,
or the wrong number of dims — with the primitive's own message.

### `GET /api/rollups`

Reads one rollup family — issues, spend, activity, milestones.

| Param | | |
|---|---|---|
| `as` | **required** | the family name. Missing ⇒ `400 rollup family required`. |
| `dims` | | one dimension value, or **several** as repeated params — `?dims=user:u_1&dims=user:u_2` — which becomes an `$in`. At most 100; more, or a non-string value, is a `400`. |
| `subjectType` | | narrow to one subject type. |
| `on` | | `firstAt` \| `lastAt` \| `bucketAt` — which field `from`/`to` filter. Anything else is a `400`. |
| `from` / `to` | | applied to `on`, which defaults to `bucketAt` for bucketed families and `lastAt` otherwise. Only parsed when at least one is present. |
| `sort` | | `count` \| `lastAt` \| `firstAt` \| `bucketAt`. Default: `bucketAt` ascending when bucketed, `count` descending otherwise. |
| `limit` | | clamped to `queryLimits.rollups` (default 500). |

```json
{ "rows": [ /* rollup documents */ ], "bucketed": true, "truncated": false, "dataSource": "rollups" }
```

A rollup document:

```jsonc
{
  "_id": "acc_9|llm_cost|attr:gen_ai_request_model=opus|2026-07-03T00:00:00.000Z",
  "tenantId": "acc_9", "as": "llm_cost",
  "dims": ["gen_ai_request_model=opus", "feature=chat"],  // subject dims keep `type:id`
  "subjectType": "user",          // only when a subject dim is present
  "bucketAt": "2026-07-03T00:00:00.000Z",   // absent on lifetime families
  "firstAt": "…", "lastAt": "…", "count": 12,
  "sums": { "cost_usd": 0.24 },
  "firstCapture": { "attr:source": "ads" }, "firstTraceId": "…"
}
```

`truncated` is observed, not inferred: the read asks for `limit + 1`.

**Cohort selection wants `on=firstAt`.** The default filters `lastAt`, which is
the most recent occurrence — on a once-per-subject milestone the two are equal
only until something re-emits it, and after that a cohort read silently selects
the wrong subjects. Repeated `dims` exists for the same reason: N subjects in one
read, rather than N reads or an unfiltered family scan that the cap truncates
into a plausible wrong answer.

```
GET /rollups?as=account.signed_up&on=firstAt&from=…&to=…
GET /rollups?as=activity&dims=user%3Au_1&dims=user%3Au_2
```

`200`, or `400` on a missing `as`, an unrecognised `on`, an over-long or
non-string `dims`, or a bad range.

### `GET /api/trace/:traceId`

One trace, every kind, one time axis — the first join view.

```json
{ "items": [ /* envelopes, occurredAt ascending */ ], "dataSource": "raw" }
```

Capped at `queryLimits.trace` (default 500). No time range. A trace id is only
unique within a tenant, so under `'*'` this legitimately returns several tenants'
spans — each carrying its own `tenantId`.

`200`.

### `GET /api/journey/:ref`

One subject's whole story. `:ref` is a URL-encoded subject ref, e.g.
`account%3Aa0`.

Params: the time range, plus `limit` (clamped to `queryLimits.journey`,
default 500).

```json
{ "records": [ /* envelopes, occurredAt descending */ ],
  "milestones": [ /* lifetime rollup docs, firstAt ascending, max 100 */ ],
  "dataSource": "raw+rollups" }
```

Only **lifetime** families appear as milestones — bucketed activity rows would
drown the markers.

`200`, or `400` on a bad range.

### `GET /api/distinct`

Distinct subjects per bucket and over the range — DAU/WAU/MAU, exact, no sketch.

| Param | | |
|---|---|---|
| `as` | **required** | a rollup family. Missing ⇒ `400 rollup family required`. |
| `from` / `to` | | the range, applied to `bucketAt`. |
| `subjectType` | | narrow to one subject type. |
| `interval` | | `hour` \| `day` \| `week` \| `month`. Default: the family's own bucket. |

```json
{ "buckets": [{ "at": "…", "value": 120 }], "distinct": 480,
  "interval": "day", "truncated": false, "dataSource": "rollups" }
```

`distinct` is the count over the **whole range** — never the sum of the buckets.

`interval` may be **coarser** than the family's bucket (daily rows → monthly MAU);
re-truncating bucket starts cannot split a bucket across two periods, so the
roll-up stays exact. Asking for finer than the family writes returns the family's
own grain.

**`400` when the family cannot answer the question**, with a message naming the
family and the fix — no subject dim, no bucket, or extra dims that would split one
subject across several docs per period. A registry mistake here would otherwise
produce a number that looks like DAU and is not, which is the failure mode this
package exists to prevent. Scan ceiling: `queryLimits.distinct` (default
100 000), and `truncated` says when it was hit.

### `GET /api/funnel`

Cohort funnel over lifetime milestone families.

| Param | | |
|---|---|---|
| `stages` | **required** | comma-separated family names: `?stages=signed_up,activated,converted`. Empty ⇒ `400`. |
| `exits` | | comma-separated families — counted, never staged. |
| `anchor` | | the family that assigns cohort membership and anchors time-to-step. Default: the first stage. |
| `from` / `to` | | the cohort window, applied to the anchor's `firstAt`. |
| `endInclusive` | | `true` includes `to` itself. Default half-open, like everything else. |
| `subjectType` | | narrow the cohort. |
| `interval` | | `day` \| `week` \| `month` — also slice the cohort by anchor date. |
| `limit` | | cohort cap, clamped to `queryLimits.funnel` (default 5000). |

Stages arrive as a comma-separated list rather than a POST body on purpose: a
view is a named URL, and a funnel that needed a body could not be one.

Response: [`FunnelResult`](/reference/types#cohort-math). Stage counts are
**literal, not monotonic** — the funnel is never backfilled, so a stage can
legitimately exceed the one before it.

**`400` when a named family is not a lifetime milestone family keyed by exactly
one subject dim**, with the validator's message verbatim. A registry mistake is
the caller's to fix, not a 500 that hides it.

`truncated: true` means the cohort read hit its cap and every number is an
undercount.

### `GET /api/values`

What values a dimension actually takes. This is the endpoint that turns a
free-text filter box into a picker, and it needs nothing declared by the host.

| Param | | |
|---|---|---|
| `dim` | **required** | a dimension key: `attr:<key>`, `field:<path>`, `subjectType`, `actorType` — or the literal `subject` to ask a family for its subject refs. Missing ⇒ `400 dim required`. |
| `names` | | comma-separated event names — the report's source events. Decides the raw step and narrows the other two. |
| `from` / `to` | | **optional here**, unlike every other raw-reading route. Needed only by the raw step. |
| `limit` | | values cap, clamped to `queryLimits.values` (default 200). |

```json
{ "values": ["opus", "sonnet"], "counts": [412, 96],
  "source": "rollups", "via": "llm_cost", "truncated": false, "dataSource": "rollups" }
```

Four sources are tried in order and the response says which one answered:

1. **`catalog`** — the dimension has a closed domain in the registry (a
   `z.enum`, an envelope enum). Returned verbatim in schema order, with **no
   read at all** and **no `counts`**.
2. **`rollups`** — a family is keyed by this dimension, so every value that ever
   hit an aggregate comes back with its summed `count` in one indexed read.
   `via` names the family; the fewest-dims family wins, and `names` restricts to
   families those events actually feed. The `label=` prefix rollups.ts writes is
   stripped — subject dims keep their native `type:id`.
3. **`raw`** — an indexed attr, or an envelope/pseudo dimension, grouped over
   the range. Records with no value are **not** a group: "no value" is not
   something a filter can name.
4. **`none`** — nothing can answer it cheaply. Offer free-text equality with a
   *scan* badge, as the FilterBar already does.

**`none` is a `200`, never a `400`** — including when the dimension would need a
range and none was given. A caller that has to catch an error to learn "you'll
have to type it" renders an error page over a working text box.

The cap is on values **returned**, never on rows scanned: the `$limit` sits
after the `$group`, exactly as `/breakdown`'s does, so truncation keeps the top
values by count. Memoized like `/series`.

### `GET /api/subjects/describe`

| Param | |
|---|---|
| `refs` | comma-separated subject refs. Truncated to 100. |

```json
{ "refs": { "user:u_1": { "label": "ada@example.com", "href": "/admin/users/u_1" } } }
```

With no `subjectAdapter` configured this returns `{ "refs": {} }` and the UI
renders raw refs — the documented fallback, not a degraded mode.

`200`, or `500 internal_error` if your adapter throws.

---

## Reports

### `GET /api/report`

One route behind every chart. A **Report** says what is being counted, over what
range, by what dimensions; the planner picks which primitive answers it —
preferring an exact rollup read over a raw scan — and this route runs it. See
[Reports](/guide/reports).

A Report **is** this URL. Nothing is nested, nothing is a JSON blob, and
`parseReportQuery`/`reportToQuery` are inverses, so a shared link and a saved
view are the same thing.

| Param | | |
|---|---|---|
| `source` | **required** | `event:<name>` \| `namespace:<ns>` \| `kind:<kind>` \| `family:<as>` |
| `range` | | a shorthand: `1h`, `24h`, `7d`, `30d`, `90d`, or the generic `<n>h`/`<n>d` |
| `from` `to` | | an explicit half-open ISO pair — use these *or* `range`; `range` wins if both are present |
| `interval` | — | `hour` \| `day` \| `week` \| `month` |
| `measure` | `count` | `count`, `sum:<metric>`, `avg:<metric>`, `p50\|p90\|p95\|p99:<metric>`, `distinct:<subjectType>`, `funnel` |
| `groupBy` | — | one or two dims, comma-separated: `groupBy=attr:model,field:client.platform` |
| `filter` | — | `<dim>:<op>:<value>`, **repeatable**. Op is `eq` \| `in` \| `gte` \| `lte` |
| `excludeActors` | — | `admin,system` — the customer toggle |
| `sort` | — | `value` \| `label` \| `time` (a rendering hint, carried through) |
| `limit` | — | positive integer, clamped to the primitive's own cap |
| `compare` | — | `previous` — also run the window immediately before, same length |
| `stages` `anchor` `exits` `subjectType` | — | funnel only (`measure=funnel`); `stages`/`exits` are comma-separated family names |

The dim in a `filter` may itself contain a colon (`attr:model`) and so may the
value (`field:subject:eq:user:u_1`), so the **first** `eq`/`in`/`gte`/`lte`
token is what ends the dim and begins the value. An `in` value is a comma list;
`gte`/`lte` values are numbers, and only a declared metric can carry one.
Unknown params are ignored — a URL may carry a page's own state alongside a
Report.

```
GET /api/report?source=event:llm.completion&range=7d&interval=day
  &measure=sum:cost_usd&groupBy=attr:gen_ai_request_model
  &filter=attr:feature:eq:chat&compare=previous
```

```json
{ "report": { "source": { "event": "llm.completion" }, "range": "7d", "…": "…" },
  "plan": { "primitive": "rollups", "exactness": "exact", "via": "llm_cost",
            "why": "family \"llm_cost\" is keyed by … maintained on write, so this is one indexed rollup read …" },
  "result": { "rows": [{ "dims": ["opus"], "at": "2026-07-01T00:00:00.000Z", "value": 4.25 }],
              "groups": 2, "truncated": false, "dataSource": "rollups" },
  "previous": { "…": "…" },
  "dataSource": "rollups" }
```

`result` is the primitive's own result — `buckets` from `series`, `items` from
`records`, `rows` from `breakdown`, `stages` from `funnel`. The one exception is
a `rollups` plan, which is **folded into the same row shape `breakdown` returns**,
so a renderer never learns which store answered. `previous` is present only
under `compare=previous`. Records are **not** redacted here: the dashboard
viewer is already inside the tenant, and `/records` would have served the same
rows. (The `run_report` MCP tool passes its own redactor.)

`200`. `400` on a malformed param (with the param named), an invalid range, or
a Report the planner **refuses** — the message is the refusal's `why`, which
names the offending key and the registry change that would answer it.

### `GET /api/report/plan`

The dry run: the same URL, no read. Answers the `Plan` the executor would run —
`primitive`, positional `args`, `exactness` (`exact` / `raw` / `scan`), `via`,
and a human `why` — or `{ "unavailable": true, "why": "…" }`.

```json
{ "primitive": "breakdown", "args": ["…"], "exactness": "scan",
  "why": "raw count by attr:route over the range — \"attr:route\" has no index behind it, so this is a collection scan bounded only by the range; add \"route\" to `indexedAttrs` to make it a lookup" }
```

**A refusal here is a `200`, not a `400`.** It is an answer: the UI greys the
option and shows the `why` instead of offering a query that would fail. On
`/api/report` the same refusal is a `400`, because by then the caller asked for
data. A malformed URL is a `400` on both.

---

## Views

One shape, three producers. See [The dashboard](/guide/dashboard#views-one-shape-three-producers).

### `GET /api/views`

```json
{ "views": [
  { "name": "error.unhandled", "page": "errors", "origin": "derived",
    "query": { "source": { "event": "error.unhandled" }, "range": "7d", "interval": "day" } },
  { "name": "Checkout errors", "page": "errors", "origin": "saved",
    "id": "0192…", "ownerRef": "user:u_1", "shared": false, "query": { } }
] }
```

Derived views come from the registry (one per event name, one
`rollup: <family>` per rollup family). Configured views come from
`createDashboard({ views })`. Saved views are read from `<collection>_views`
matching the viewer's scope **literally** and `{ shared: true } OR { ownerRef: viewerRef }`,
oldest first, capped at 200.

**Name collisions resolve saved → configured → derived.** Exactly one view per
name is returned, with its `origin` on it.

Saved views scope on the viewer string literally, `'*'` included — a platform
viewer's views are invisible to every tenant and vice versa, including shared
ones. `'*'` reads telemetry across tenants; it is not a master key to other
people's saved state.

`200`.

### `POST /api/views`

```json
{ "spec": { "name": "Checkout errors", "page": "errors",
            "query": { "source": { "kind": "error" }, "range": "24h" } },
  "shared": false }
```

`page` is one of `errors` `traces` `events` `journeys` `usage` `overview`
`system` `explore`.

```json
{ "id": "0192…" }
```

- `400 view spec required` — missing `spec.name`, `spec.page`, or a non-object
  `spec.query`.
- `400 private views need a viewer identity` — `shared` is false and the viewer
  has no `viewerRef`. There is no owner to attach it to.

Saved with `tenantId` = the viewer's scope and `ownerRef` = `viewerRef`.

`200`.

### `DELETE /api/views/:id`

```json
{ "removed": 1 }
```

Ownership rules, in order:

1. The view is looked up by `{ _id, tenantId: <viewer scope> }` — a **literal**
   scope match. A view outside the caller's scope reports **`{ "removed": 0 }`,
   not 403**: whether that id exists elsewhere is not this viewer's business
   either.
2. Your own view (`ownerRef === viewerRef`) deletes.
3. Someone else's deletes only with `role: 'admin'` — and that is admin *of this
   scope*. Otherwise `403 { "error": "forbidden" }`.

---

## System

Where "never drop silently" becomes visible. Not optional.

### `GET /api/system`

```jsonc
{
  "counters": {
    "rejected": 41, "defaulted": 0, "sampled": 0, "capped": 0,
    "rollupSkipped": 12, "deduped": 0, "truncated": 0,
    // the same two drops, attributed
    "rollupSkippedBy": { "screens_viewed|name": 12 },
    "undeclaredAttrs": { "import.started|codec": 41 }
  },
  "quarantine": [{ "at": "…", "name": "app.ping", "reason": "unregistered event", "raw": { } }],
  "indexCount": 14,
  "indexBudget": 24,
  "keys": [ /* admin only */ ],
  "role": "admin",
  "suggestions": [
    {
      "kind": "undeclared_attr",
      "target": "import.started",
      "key": "codec",
      "count": 41,
      "message": "`import.started` has been sent with attr `codec` 41 times — not declared",
      "fix": "codec: z.string().max(64),"
    },
    {
      "kind": "missing_dim_default",
      "target": "screens_viewed",
      "key": "name",
      "count": 12,
      "message": "`screens_viewed` skipped 12 records with no `name` — declare `dimDefault`",
      "fix": "// on the `screens_viewed` rollup of `screen.viewed`\ndimDefault: 'unknown',"
    }
  ]
}
```

- `counters` and `quarantine` (latest 50, newest first) are served to **any**
  viewer. Every quarantine row is a write someone attempted.
- `counters.rollupSkippedBy` (`` `${family}|${dimLabel}` ``) and
  `counters.undeclaredAttrs` (`` `${name}|${attrKey}` ``) attribute two of the
  scalars above. Both hold at most **1000 distinct keys**; past that new keys
  fold into a single `(other)|(other)` bucket, because both are keyed on
  client-controlled strings. The seven scalar counters are unchanged in name
  and meaning.
- `suggestions` is the loop closed the other way: the registry edits those
  counters and the quarantine are asking for, **loudest first, capped at 50**.
  Each carries a `message` for a human and a `fix` that is pasteable registry
  code — the zod line (or the whole `attrs: z.object({ … })` block when the spec
  declares none), a `dimDefault` line commented with every spec that feeds the
  family, or a minimal stub for an unregistered name. Nothing is written; see
  [`deriveSuggestions`](/reference/types#suggestions), which is pure, exported,
  and derived from data already on this response.
- `indexCount` is the live index count on the telemetry collection;
  `indexBudget` is `INDEX_BUDGET` (24).
- `keys` is `[]` unless `role === 'admin'`. When present it is the 100 newest key
  documents with **`secretHash` projected away** — the hash never leaves the
  database.

A failure reading the quarantine or the index list degrades to an empty array
rather than failing the page.

`200`.

### `POST /api/system/keys/:id/revoke`

```json
{ "revoked": 1 }
```

`revoked` is `0` when the key does not exist or was already revoked — the update
matches `{ _id, revokedAt: null }`.

`403 { "error": "forbidden" }` unless `role === 'admin'`. The check is **ours**,
not inherited from whatever middleware guards the mount, because the host's guard
may be coarser than this one.

Revocation takes effect within the ingest router's `keyCacheMs` (60s by default).

## Verified against

Checked against the source on **2026-09-07**: every route below is one
`api.get` / `api.post` / `api.delete` in `src/server/dashboard.ts` (19 of them),
with parameter parsing read from `src/server/query.ts` (`RecordFilter`,
`QueryLimits`, `breakdown`), `src/server/report.ts` (`parseReportQuery`,
`resolveReport`), `src/server/execute.ts` (`executeReport`),
`src/server/values.ts` (`createValues`), `src/server/views.ts`
(`resolveViews`, `saveView`), `src/server/catalog.ts` (`deriveCatalog`,
`projectRegistry`), and `src/server/suggest.ts` (`deriveSuggestions`).

`test/dashboard.test.ts` and `test/tenancy.test.ts` pin `200`, `400`, `401`,
`403`, `500`, and the SPA shell's `200`/`503` on these routes, including the
`internal_error` body, the `removed: 0` cross-scope delete, and the admin gates
on `keys` and `revoke`.
