# Client SDKs

Six subpath exports. The split is on **trust**, not on features:
`@jeffjassky/telemetry` is the server package — it imports mongoose and express
and holds the database. Everything under a subpath ships to an untrusted
environment, carries no secrets, and imports neither.

| Subpath | Adds |
|---|---|
| `@jeffjassky/telemetry/core` | the isomorphic client — queue, batching, tracing, identity |
| `@jeffjassky/telemetry/web` | browser context capture, global error hooks, DNT/GPC, `sendBeacon` |
| `@jeffjassky/telemetry/react` | provider, hook, error boundary |
| `@jeffjassky/telemetry/vue` | Vue 3 plugin, `provide`/`inject` accessor |
| `@jeffjassky/telemetry/electron` | main-process client + renderer→main IPC transport |
| `@jeffjassky/telemetry/cli` | disk queue, persistent anon id, `DO_NOT_TRACK` |

Every subpath re-exports `createClient` and the `TelemetryClient` type, so a
platform entry is never a fork — it is wiring over the same core.

The registry crosses the boundary too: `/core` re-exports `defineRegistry`,
`boundedMeta`, and the registry types, so a host's registry module can be
imported by the server at runtime *and* by clients as `import type` only — zod
never reaches a bundle.

```ts
import type { REGISTRY } from './telemetry-registry.js';
import { createWebTelemetry } from '@jeffjassky/telemetry/web';

const telemetry = createWebTelemetry<typeof REGISTRY>({
  key: import.meta.env.VITE_TELEMETRY_KEY,   // pk_…
  url: 'https://app.example.com/telemetry/ingest',
  release: __APP_VERSION__,
});
```

---

## `/core`

```ts
function createClient<R extends Registry = Registry>(options: CreateClientOptions): TelemetryClient<R>;
```

~80% of every client by value. Zero heavy dependencies, no `window`, no `fs`.

### Options

| Option | Type | Default | |
|---|---|---|---|
| `key` | `string` | — | **Required.** `pk_` for anything shipped to users; `sk_` only in trusted processes. |
| `url` | `string` | — | **Required.** The mounted ingest endpoint. |
| `release` | `string` | — | Injected at build. Becomes `clientContext.appVersion` and the batch `release`. The key supplies `service`/`env` — the client is never asked. |
| `flushIntervalMs` | `number` | `5000` | `0` disables the timer; call `flush()` yourself. The interval timer is `unref`'d so it never holds a Node process open. |
| `maxBatchSize` | `number` | `50` | Records per POST. |
| `maxQueueSize` | `number` | `1000` | Ring buffer cap — see below. |
| `maxRetries` | `number` | `5` | Consecutive failed flushes before a batch is abandoned. |
| `transport` | `Transport` | `fetch` with `keepalive: true` | `(url, body, headers) => Promise<{ ok, status? }>`. |
| `storage` | `ClientStorage` | in-memory `Map` | `{ get(k), set(k, v) }`. Persists the anon id. |
| `clientContext` | `ClientContextInput` | `{ platform, appVersion }` | Merged over the adapter's capture. |
| `consent` | `() => boolean` | `() => true` | `false` ⇒ drop instead of send. |
| `errorName` | `string` | `'error.unhandled'` | Registry name used by `captureError`. |
| `onError` | `(e) => void` | no-op | SDK-internal failures. **Never thrown at the app.** |

### Methods

```ts
track<N extends keyof R & string>(name: N, opts?: TrackOptions): void
```
Typed against the registry when constructed as `createClient<typeof REGISTRY>`.
`opts` takes `attrs`, `metrics`, `data`, `occurredAt`, `subjects`, `severity`.
Inside an open span, the record inherits `traceId` and `parentId` automatically.
Synchronous — it enqueues and returns.

```ts
captureError(err: unknown, ctx?: { handled?, name?, attrs? }): void
```
Coerces non-`Error` values, parses up to 20 stack frames
(`fn`, `filename`, `lineno`, `colno`), computes a stable fingerprint from
`type | message-with-digits-normalized | top frame filename`, and enqueues with
`severity: 'error'`. Same crash, same group. Server-side fingerprinting can
refine it later; this one is cheap and deterministic.

```ts
startSpan(name: string, opts?: { attrs? }): Span     // { traceId, spanId, end(extra?) }
```
Spans nest via a stack: a child inherits the parent's `traceId` and records the
parent's `spanId` as `parentId`. `end()` enqueues the record with `durationMs`,
and is idempotent — a second call does nothing. `occurredAt` is the span's
*start*.

Trace ids are UUIDv7 like everything else, because the server samples on the
random hex tail.

```ts
state(name: string, st: { key, from?, to, previousSinceMs? }): void
```
A state transition. Note that most `state` names are server-origin; a `pk_` key
can only write one if the key explicitly allowlists the `state` kind.

```ts
identify(ids: Record<string, string | null | undefined>): void
```
Swaps subjects by type — `null` removes a type, anything else sets it. When a
`user` appears (or changes) it enqueues exactly one `$identify` control record
linking `anon:<anonId>` → `user:<id>`, and sets the batch `actor` to
`user:<id>`. The anon subject **stays** on the context; the alias is the durable
link and a stitching job downstream consumes it.

```ts
setActor(ref: string | undefined): void
```

```ts
flush(): Promise<void>
```
Drains the queue in `maxBatchSize` chunks. Concurrent calls coalesce onto the
same promise.

```ts
shutdown(): Promise<void>
```
Clears the interval timer, then flushes.

### The ring buffer

The queue is a ring capped at `maxQueueSize`, and it **drops the oldest**:

```
queue.push(rec); while (queue.length > maxQueueSize) { queue.shift(); dropped++; }
```

Fresh telemetry outranks stale. A tab left open for six hours on a flaky
connection should report what is happening now, not replay this morning. The
alternative — drop-newest — turns a queue that filled once into a queue that is
permanently useless.

### Retry and idempotency

A failed flush **leaves the records queued** and returns, backing off until the
next interval. The retry sends the **same `_id`s**, so the server's insert
dedupes them. Idempotency lives in the record, not in the connection.

After `maxRetries` consecutive failures the batch is dropped and the counter
advances — retrying forever is how a client with a bad URL becomes a
denial-of-service against itself.

### Consent

`consent() === false` **clears the queue** rather than holding it:

```
no consent = no send AND no hoard
```

Holding records against a future opt-in is the thing the opt-out was about. Note
that this is checked at flush time, so `track()` still enqueues; nothing is ever
sent or persisted.

---

## `/web`

```ts
function createWebTelemetry<R>(opts: WebTelemetryOptions): TelemetryClient<R>;
```

`WebTelemetryOptions` is `CreateClientOptions` minus `storage` and `consent`
(the adapter owns both), plus:

| Option | Default | |
|---|---|---|
| `consent` | `() => true` | Host consent — a cookie banner check. **ANDed** with the hard signals. |
| `captureGlobalErrors` | `true` | Wire `window.onerror` and `unhandledrejection`. |

**Context capture.** `platform: 'web'`, `appVersion` from `release`, plus
`userAgent`, `locale`, `timezone` (from `Intl`), `screenW/H`, `viewportW/H`,
`connection` (`effectiveType`), and `online`. Your `clientContext` merges over
all of it.

**Storage** is `localStorage`, wrapped so a `SecurityError` in a partitioned or
private context degrades to no persistence rather than throwing.

**Global errors** are captured with `handled: false` — the crash path.

**DNT and GPC are hard signals.** The effective consent is:

```js
consent: () => privacySignalsAllow() && hostConsent()
```

`navigator.doNotTrack === '1'`, `navigator.globalPrivacyControl === true`, or
`window.doNotTrack === '1'` and nothing is sent. The host callback is ANDed, so
it can only ever **narrow** further — a host cannot override a browser-level
opt-out by returning `true`, because that is not what an opt-out is.

**Unload flush.** On `pagehide` and on `visibilitychange → hidden`, up to 100
queued records go out via `navigator.sendBeacon`. Beacons cannot set headers, so
the `pk_` key rides the query string; the server accepts that for `pk_` only.
If the browser accepts the beacon the local queue is cleared — a retry would
resend the same `_id`s and the server dedupes them anyway.

---

## `/react`

```tsx
<TelemetryProvider client={telemetry}>…</TelemetryProvider>
const t = useTelemetry();            // throws with no provider above it
<TelemetryErrorBoundary fallback={…}>…</TelemetryErrorBoundary>
```

`useTelemetry()` throws rather than returning `null` — a silently non-recording
hook is worse than a crash in development.

`TelemetryErrorBoundary` takes `client` (falls back to the provider's), and
`fallback` as a node or `(error) => node`. It reports with **`handled: true`** —
the boundary *did* handle it; `handled: false` is reserved for the crash path —
and attaches the first line of the component stack as
`attrs.component_stack_head`.

Router integration stays userland: `page.view` semantics belong to the app.

---

## `/vue`

```js
import { createTelemetryPlugin, useTelemetry } from '@jeffjassky/telemetry/vue';
import { inject } from 'vue';

app.use(createTelemetryPlugin(telemetry));
const t = useTelemetry(inject);
```

The plugin installs `app.config.errorHandler`, reporting with `handled: false`
and `attrs.vue_info`, then **chains to any previous handler** — installing
telemetry must not silence the app's own error reporting. It also
`provide()`s the client under `TELEMETRY_KEY` (`'telemetry'`).

`useTelemetry` takes Vue's `inject` as an argument. That is deliberate: nothing
in this entry imports `vue` at runtime, so the plugin shape stays structural and
the package does not need Vue resolved to be loadable.

---

## `/electron`

The shape that matters: **records from the renderer route through main over
IPC.** The key never reaches the renderer, there is one queue, and offline
behaviour lives in one place.

```js
// main
import { createMainTelemetry } from '@jeffjassky/telemetry/electron';
import { ipcMain } from 'electron';

const telemetry = createMainTelemetry({ key: SK_OR_PK, url, release: app.getVersion(), ipcMain });
```

```js
// renderer (or preload)
import { createRendererTelemetry } from '@jeffjassky/telemetry/electron';
import { ipcRenderer } from 'electron';

const telemetry = createRendererTelemetry(ipcRenderer);
```

`createMainTelemetry(opts)` — `CreateClientOptions` plus:

| Option | Default | |
|---|---|---|
| `captureProcessErrors` | `true` | `process.on('uncaughtException' \| 'unhandledRejection')`, reported `handled: false`. |
| `ipcMain` | none | Pass electron's `ipcMain` to accept renderer batches. |

It registers a handler on `IPC_CHANNEL` (`'telemetry:batch'`) that enqueues
incoming wire records into the main queue after a shape check (`_id` and `name`
must be strings). `clientContext.platform` is `'electron'`.

`createRendererTelemetry(ipcRenderer, opts?)` takes
`Omit<CreateClientOptions, 'key' | 'url' | 'transport'>` — those three are
meaningless in a renderer, so they are not accepted rather than accepted and
ignored. Its transport parses its own batch and forwards only the `records` array
over IPC.

Electron itself is structural-typed: nothing here imports `'electron'` at
runtime, so the module loads in a test or a preload script without it.

---

## `/cli`

```js
import { createCliTelemetry } from '@jeffjassky/telemetry/cli';

const telemetry = createCliTelemetry({
  key: 'pk_live_tk_…',
  url: 'https://app.example.com/telemetry/ingest',
  release: pkg.version,
  configDir: `${os.homedir()}/.config/mytool`,
});
```

`CliTelemetryOptions` is `CreateClientOptions` minus `storage` (the adapter owns
it), plus:

| Option | Default | |
|---|---|---|
| `configDir` | — | **Required.** Where the anon id and offline queue live. |
| `argv` | `process.argv` | Scanned for `--no-telemetry`. |
| `maxQueueAgeMs` | 7 days | Age cap for replayed offline records. |

**Opt-out is hard and it is first.** `DO_NOT_TRACK=1`, `TELEMETRY_DISABLED=1`, or
`--no-telemetry` in argv, and you get **a working client that never sends or
stores anything** — the same client with `consent: () => false` and no flush
timer. Every method still exists and still works; nothing leaves the process and
nothing touches the disk, including `configDir`, which is not even created.

Returning a no-op client rather than `null` or a throw is the whole point: an
opt-out that makes the host write `if (telemetry)` around every call site is an
opt-out hosts route around.

**Disk queue.** CLI processes exit before a flush completes, so:

- On `process.on('exit')`, whatever is still queued is written synchronously to
  `<configDir>/telemetry-queue.json`. Exit handlers cannot await, and disk writes
  can be synchronous — that is the whole trick.
- On the next run, that file is read, **deleted**, and its records re-enqueued.
  Records older than `maxQueueAgeMs` are dropped: a machine that was offline for
  a month should not replay a month of stale telemetry into today's buckets.

**Anon id** persists in `<configDir>/telemetry_anon.txt` — machine-scoped, stable
across runs, and the thing an `$identify` later links a real user to.
