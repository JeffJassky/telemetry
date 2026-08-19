# Telemetry MCP Tools

A suite of MCP-style tool descriptors over [dashboards.md](./dashboards.md)'s
six query primitives, so a host with an existing MCP server can give an agent
read access to its telemetry — errors, journeys, usage — by wiring a few tool
descriptors, not by writing query code. Normative for the tool surface, the
auth contract, and the descriptor shape.

---

## 1. Design position

**Not a server.** No transport, no `@modelcontextprotocol/sdk` runtime
dependency, no stdio/HTTP. The package exports a *factory that returns tool
descriptors* — `{ name, description, inputSchema, handler }` — and the host maps
those onto whatever MCP server it already runs. The one seam to the official SDK
is an optional adapter (§5), the same way `createDashboard` is the seam to
Express without the package *being* a web framework.

**One auth boundary, reused.** The dashboard already refuses to mount without a
`viewerAdapter` — *"an unauthenticated telemetry dashboard is a data leak with
charts"* ([dashboard.ts](../src/server/dashboard.ts)). An agent is the harder
case: a confused deputy that will read whatever scope it is handed. So the MCP
tools take the **same `viewerAdapter` contract**, and scope is resolved **per
tool call** from the agent's session context — never a tool argument, never
frozen at wiring time. The tenant term is not something the LLM gets to pick.

**Derived, not per-tool.** As with the dashboard, the tools derive their power
from the registry. `describe_telemetry` hands the agent the vocabulary
(event names, `indexedAttrs`, `metrics`, rollup families); every other tool
speaks that vocabulary. No tool is written per event name — that is the
over-fit alarm here too.

---

## 2. Public API

New subpath export: `@jeffjassky/telemetry/mcp`.

```ts
import { createTelemetryMcp } from '@jeffjassky/telemetry/mcp'

const tools = createTelemetryMcp({
  telemetry,        // the createTelemetry() handle — models + registry, nothing new built
  viewerAdapter,    // { resolveViewer(ctx) -> { tenantId } | Promise<...> }  — same shape as the dashboard's
  subjectAdapter?,  // optional; labels subjects in journey/error tools (mirrors dashboard's subjectAdapter)
  configured?,      // ViewSpec[] — host-configured reports, forwarded to resolveViews (mirrors dashboard)
  limits?,          // Partial<QueryLimits> — forwarded to createQueries
  redact?,          // (record) => record — default strips declared `data` payloads from raw reads (§4)
})
// -> ToolDescriptor[]
```

- Builds `createQueries({ TelemetryModel, RollupModel, registry, limits })`
  **once**, internally — the queries object is wrapped, but built here so it
  sits *behind* the auth boundary, exactly as `createDashboard` does it.
- Returns an array. Each descriptor's `handler(args, ctx)` calls
  `viewerAdapter.resolveViewer(ctx)` → scope → the matching query primitive.
- `ctx` is opaque and host-supplied: the host passes whatever its MCP server
  hands the tool (session, auth claims, request). The package never inspects it
  beyond forwarding to `resolveViewer`.

### ToolDescriptor

```ts
interface ToolDescriptor<A = unknown> {
  name: string
  title: string
  description: string          // written for an LLM: what it answers, when to reach for it
  inputSchema: ZodType<A>      // zod (already a dep) — args only; NEVER a scope/tenant field
  handler: (args: A, ctx: unknown) => Promise<ToolResult>
}
```

Descriptors carry **zod** schemas (schema-format decision below). Hosts on the
official SDK use the §5 adapter; everyone else calls `toJsonSchema(descriptor)`
(re-exported from zod v4's native converter) and wires the raw handler.

---

## 3. The tools

Every tool is a façade over a dashboard read surface that already exists and is
already tested ([dashboard.ts](../src/server/dashboard.ts)). No tool invents a
query. **All-or-none**: the factory emits the whole suite or the host wires
none — there is no per-tool allowlist. A host that wants fewer simply doesn't
register the ones it doesn't want at the SDK layer.

### Primitive façades — one query each (dashboards.md §2)

| tool | primitive | serves |
|---|---|---|
| `describe_telemetry` | `/registry` | the vocabulary: kinds, event names, `indexedAttrs`, `metrics`, rollup families. **Call first.** |
| `search_events` | `records` | filtered raw envelope reads — the general list/table/tail tool |
| `list_errors` | `records` (kind=error) | a focused, ergonomic error feed — the headline use case |
| `event_trends` | `series` | counts/sum/avg over time, bucketed hour/day/week/month |
| `metric_distribution` | `distribution` | percentiles + histogram — "what's p95 latency?", the Datadog question |
| `rollup_breakdown` | `rollups` | top-N by dims — top issues, top spenders, top pages, any declared family |
| `active_users` | `distinctCount` | DAU/WAU/MAU, exact |
| `inspect_trace` | `trace` | one correlated request across services |
| `user_journey` | `journey` | one subject's timeline over a range |
| `funnel_analysis` | `funnel` | cohort funnel, conversion, median time-to-step |

`rollup_breakdown` and `active_users` are deliberately two tools, not a fused
`usage_summary` — one primitive per tool is what lets a model pick the right
one from the description alone.

`list_errors` is `search_events` with `kind` pinned and a tighter schema —
kept separate because "show me recent errors" is the sentence this feature
exists for, and an agent should not have to know the `kind` taxonomy to ask it.

### Report / aggregate façades — the curated surfaces

These expose reports and health that the dashboard already assembles. Nothing
new is computed; the agent gets the same menu a dashboard user sees.

| tool | surface | serves |
|---|---|---|
| `list_reports` | `resolveViews` (`/views`) | the menu of available reports — saved (human-built), configured (host-wired), and registry-derived. Each is a named, runnable query. |
| `run_report` | a resolved view's stored `query` → the matching primitive | execute one named report and return its result. Read-only; the query is a stored filter/range/display, dispatched to the same primitive the dashboard would use. |
| `telemetry_health` | `/system` (`counters`, `quarantine`, `indexBudget`) | drop/default/cap counts and quarantined failed writes — answers "are we silently dropping events?", the question this package exists to make answerable. |
| `list_tenants` | new: `$group` on `tenantId` over rollups | the platform-operator roster — tenants with activity in a range, plus per-tenant row/count stats. Meaningful only under `'*'`; under a tenant scope it returns just that tenant. The **one** tool backed by a new query, ~20 lines, served by the existing `{tenantId, …}` index prefixes. |

**Subject labeling folds in, it is not its own tool.** When `subjectAdapter` is
present, `user_journey` and `list_errors` run their result subjects through
`subjectAdapter.describe()` so an agent sees `Ada (ada@x.com)`, not `user:u_1`.
The dashboard's `/subjects/describe` endpoint is an internal step of those
tools, not a separate agent-facing verb.

**`run_report` inherits the view's scope discipline.** A saved view is already
tenant-scoped in storage; `resolveViews` only ever returns views for the
resolved viewer's scope, so `run_report` cannot reach another tenant's saved
report — the isolation is the same one §4.1 requires, reached the same way.

---

## 4. Safety rules (normative)

1. **Scope is never an argument — but narrowing is.** Scope comes only from
   `resolveViewer(ctx)`; no argument can *widen* it. Tools do carry an optional
   `tenant` argument honored **only when the resolved scope is `'*'`** — a
   platform operator's agent asking "tenant X's errors" is narrowing inside a
   grant that already happened, not escalating. Under any other scope a
   supplied `tenant` is a hard error (not silently ignored — a mismatch between
   what the agent asked and what it got is the silent-wrong-number failure
   mode). This is the only scope-adjacent argument, and it can only shrink.
2. **Raw reads redact by default.** `search_events` / `list_errors` return
   envelopes, which may carry declared `data` payloads (PII, bodies). The
   default `redact` strips `data` and truncates long strings; a host opts back
   in explicitly. Reuse the existing `excludeActorTypes` so "customer-only"
   stays one flag.
3. **No writes.** This surface is read-only. `emit`, `forget`, `createKey`,
   `saveView` are not exposed and must not be — an agent does not erase users or
   mint ingest keys.
4. **Bounded, and it says so.** The primitives already cap and report
   `truncated` / `dataSource`; tool results pass those through so the agent
   knows when it is seeing a ceiling, not a total.
5. **Cross-tenant (`'*'`) is inherited, not special-cased.** The tools do not
   know about `PLATFORM_SCOPE`. If a viewer arrives scoped to `'*'`, they serve
   the platform-wide view exactly as the dashboard does — because the host's
   `viewerAdapter` made that authorization call. If the host never grants `'*'`,
   no tool can reach across tenants. There is no MCP-specific toggle.

---

## 5. The official-SDK adapter

Optional, tiny, isolated so the core stays runtime-free.

```ts
import { registerTelemetryTools } from '@jeffjassky/telemetry/mcp/sdk'
registerTelemetryTools(server, tools) // server: McpServer from @modelcontextprotocol/sdk
```

- `@modelcontextprotocol/sdk` is an **optional peer** — declared, not bundled,
  never imported by the core `/mcp` entry.
- The SDK takes zod schemas directly, so this is a thin loop: for each
  descriptor, `server.registerTool(name, { description, inputSchema: shape }, handler)`.
- The adapter owns exactly one thing: threading the SDK's `extra`/request into
  the `ctx` our handlers forward to `resolveViewer`.

---

## 6. Package / build impact

- New entries in `exports`: `./mcp` and `./mcp/sdk`. Two new tsup entrypoints,
  two `types/*.d.ts`, `check-exports` covers both.
- New optional peer: `@modelcontextprotocol/sdk` (`peerDependenciesMeta`
  optional) — used only by `/mcp/sdk`.
- No new runtime deps (zod present; JSON Schema via zod v4 native `toJSONSchema`).
- `test/`: per-tool handler tests against `mongodb-memory-server`, plus the
  security assertions — no descriptor exposes a scope field; a viewer pinned to
  tenant A cannot read tenant B through any tool.
- Docs: one VitePress page, `docs/mcp.md`, in the nav.

---

## 7. Non-goals

- Shipping a runnable MCP server or CLI. Host owns the server.
- Write/mutation tools (emit, forget, key minting, view saving).
- Natural-language-to-query planning inside a tool. Tools are typed and narrow;
  the *agent* composes them.
- Bundling any MCP SDK. The one supported SDK is an optional peer behind
  `/mcp/sdk`; every other framework consumes raw descriptors.

---

## 8. Size estimate

Small. `mcp/index.ts` (factory + 14 descriptors) ~400–500 lines, `mcp/sdk.ts`
~40, tests ~400, one docs page. One new query (`list_tenants`, ~20 lines);
otherwise no new query code and no new auth code — the whole feature is a
typed, LLM-legible façade over surfaces that already exist and are already
tested.
