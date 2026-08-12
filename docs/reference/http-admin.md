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

**Filters** — accepted by `/records`, `/series`, and `/distribution`.

| Param | |
|---|---|
| `kind` `name` `severity` `env` `service` `release` `traceId` | exact equality |
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
  "kinds":    ["event", "error", "span", "state", "usage"],
  "role":     "admin",
  "scope":    "acc_9",
  "platform": false
}
```

A **projection**, not the registry: names and shapes only. Zod objects are
reduced to key lists, so no validator internals ever reach the wire.

`200`. No parameters.

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

## Views

One shape, three producers. See [The dashboard](/guide/dashboard#views-one-shape-three-producers).

### `GET /api/views`

```json
{ "views": [
  { "name": "error.unhandled", "page": "errors", "origin": "derived",
    "query": { "range": "7d", "filters": { "name": "error.unhandled" }, "display": "table" } },
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
            "query": { "range": "24h", "filters": { "severity": "error" }, "display": "table" } },
  "shared": false }
```

`page` is one of `errors` `traces` `events` `journeys` `usage` `overview`
`system`.

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
  "counters": { "rejected": 0, "defaulted": 0, "sampled": 0, "capped": 0,
                "rollupSkipped": 0, "deduped": 0, "truncated": 0 },
  "quarantine": [{ "at": "…", "name": "app.ping", "reason": "unregistered event", "raw": { } }],
  "indexCount": 14,
  "indexBudget": 24,
  "keys": [ /* admin only */ ],
  "role": "admin"
}
```

- `counters` and `quarantine` (latest 50, newest first) are served to **any**
  viewer. Every quarantine row is a write someone attempted.
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

`test/dashboard.test.ts` and `test/tenancy.test.ts` pin `200`, `400`, `401`,
`403`, `500`, and the SPA shell's `200`/`503` on these routes, including the
`internal_error` body, the `removed: 0` cross-scope delete, and the admin gates
on `keys` and `revoke`.
