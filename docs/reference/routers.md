# Routers

Two factories, two Express routers. **Never an app, never a server** — the host
mounts them, guards them if it wants to, and owns the surrounding middleware.

Both take a [`Telemetry`](/reference/factory) instance. Neither builds its own
storage.

```js
app.use('/telemetry/ingest', createIngest({ telemetry: t }));
app.use('/telemetry',        createDashboard({ telemetry: t, viewerAdapter, mountPath: '/telemetry' }));
```

---

## `createIngest(options)`

```ts
function createIngest(opts: CreateIngestOptions): express.Router;
```

The untrusted write path. Batch-only, insert-gated rollups, `pk_` never 4xxes,
`sk_` gets honest errors. See [Ingest & keys](/guide/ingest) for the model and
[Public HTTP API](/reference/http-public) for the wire.

### Options

| Option | Type | Default | |
|---|---|---|---|
| `telemetry` | `Telemetry` | — | **Required.** |
| `contextAdapter` | `ContextAdapter` | none | `{ resolveContext(req): IngestContext \| null \| Promise<…> }`. Consulted **only** for `tenantMode: 'session'` keys. A session-mode key with no adapter configured logs a warning and answers 202 (`pk_`) or `500 no_context_adapter` (`sk_`). |
| `maxRecords` | `number` | `100` | Records per batch. Over it: `pk_` keeps the head and counts the tail; `sk_` gets `413`. |
| `bodyLimit` | `string` | `'512kb'` | Passed to `express.json()`. Over it: `pk_` gets 202; `sk_` gets `413`. |
| `keyCacheMs` | `number` | `60000` | Key document cache TTL. Unknown ids are negative-cached too. Also the lag between revoking a key and writers noticing. |

### What it mounts

| Method | Path | |
|---|---|---|
| `OPTIONS` | `/` | CORS preflight. Reflects the origin, `204`. Cannot be key-scoped — the browser has not sent `Authorization` yet. |
| `POST` | `/` | The batch endpoint. |

Plus an error middleware that catches body-parser failures (bad JSON, oversize)
and routes them to the right error surface — which is why **auth resolves before
`express.json()`**, and why you must not mount your own body parser in front of
this router.

The per-key rate limiter and the key cache are **per router instance**, in
memory. Two Node processes grant two buckets. It is a storm cap, not an SLA.

---

## `createDashboard(options)`

```ts
function createDashboard(opts: CreateDashboardOptions): express.Router;
```

The read surface: `/api/*` plus the built React SPA with hashed assets and an SPA
fallback. See [The dashboard](/guide/dashboard) and
[Admin HTTP API](/reference/http-admin).

### Options

| Option | Type | Default | |
|---|---|---|---|
| `telemetry` | `Telemetry` | — | **Required.** |
| `viewerAdapter` | `ViewerAdapter` | — | **Required — construction throws without it.** `{ resolveViewer(req): Viewer \| null \| Promise<…> }`. |
| `subjectAdapter` | `SubjectAdapter` | none | `{ describe(refs): Promise<Record<string, { label, href? }>> }`. Absent, `/api/subjects/describe` returns `{ refs: {} }` and the UI renders raw refs. |
| `views` | `ViewSpec[]` | `[]` | Configured views — versioned in host code. Shadowed by saved views of the same name; shadow derived ones. |
| `queryLimits` | `Partial<QueryLimits>` | [`DEFAULT_LIMITS`](/reference/types#query-and-view-types) | Per-primitive caps. |
| `onSlowQuery` | `(info: { op, ms, params }) => void` | none | Called when a read exceeds `slowMs`. |
| `slowMs` | `number` | `500` | The threshold `onSlowQuery` fires above. Forwarded to [`createQueries`](/reference/types#queries). |
| `cacheTtlMs` | `number` | `600000` | TTL of the in-process query cache. Ten minutes suits a dashboard someone is reading; a polling page wants it shorter. Forwarded. |
| `cacheSize` | `number` | `60` | Cached results kept before the oldest is evicted — the bound on what the cache costs. Forwarded. |
| `mountPath` | `string` | `'/telemetry'` | **Where the browser sees this router.** Injected as `<base href="…/">`. Behind a prefix-stripping proxy this is the *external* path. |
| `apiBase` | `string` | `mountPath` | Where the SPA calls `/api`. Injected as `window.__TELEMETRY__.apiBase = "<apiBase>/api"`. |
| `title` | `string` | `'Telemetry'` | Page title and sidebar brand. |
| `spaDir` | `string` | `defaultSpaDir()` | Override the built SPA directory. |

The query cache is **per router instance**, in memory, on the same terms as the
ingest router's key cache: two Node processes hold two caches. It covers the
four aggregating primitives — `series`, `distribution`, `rollups`,
`distinctCount` — so `cacheTtlMs` is also the lag between a write landing and a
chart moving. `records`, `trace`, `journey`, and `funnel` are never cached.

### Throws at construction

```
telemetry: createDashboard requires a viewerAdapter — an unauthenticated
telemetry dashboard is a data leak with charts
```

A permissive default here would be a footgun that fires in production and looks
fine in development. Failing at boot means it fires on your machine instead.

### What it mounts

| | |
|---|---|
| `/api/*` | The JSON API — see [Admin HTTP API](/reference/http-admin). `express.json({ limit: '64kb' })`, then the viewer gate, then the routes, then a JSON error handler. |
| `/_assets/*` | `express.static(spaDir/_assets)` with `maxAge: 1y, immutable, index: false`. |
| `GET /.*` | The SPA shell. Reads `spaDir/index.html`, replaces the `<!--telemetry-config-->` marker with `<base href="<mountPath>/">` and a `window.__TELEMETRY__` config blob, and sends it with `Cache-Control: no-store`. |

The injected JSON has `<` escaped to `<` — a `</script>` inside it would
close the tag early.

The shell answers **503** (`text/plain`) when `spaDir/index.html` does not exist,
with a line telling you to run `npm run build`. `dist/` is not committed, so that
is the normal state of a fresh clone.

The shell must never cache while `_assets` cache hard: a heuristically-cached
`index.html` keeps referencing dead hashed assets across deploys, and the assets
have content hashes in their names, so caching *those* forever is free.

---

## `defaultSpaDir()`

```ts
function defaultSpaDir(): string;
```

Resolves the bundled SPA directory. Tries `./ui` (published builds run from
`dist/index.js`, so the bundle sits alongside at `dist/ui`) then `../../dist/ui`
(running from source), returning the first whose `index.html` exists. Falls back
to the last candidate so the 503 path can report a real, wrong-looking path
rather than an empty string.

Two candidates rather than a build-time flag because a flag gets one of the two
cases wrong, and the wrong one is the one you only hit after publishing.
