# MCP tools

`createTelemetryMcp()` returns a suite of read-only **tool descriptors** over the
same query primitives the dashboard serves — errors, journeys, usage, funnels,
health. It is **not** a server: there is no transport and no MCP SDK runtime
dependency. You map the descriptors onto whatever MCP server your app already
runs, and an agent can review your telemetry without you writing any query code.

```js
import { createTelemetryMcp } from '@jeffjassky/telemetry/mcp';

const tools = createTelemetryMcp({
  telemetry: t,
  viewerAdapter: {
    // runs on EVERY tool call — the scope is resolved per call, never trusted
    // from an argument. `ctx` is whatever your MCP server hands the tool.
    resolveViewer: (ctx) => ctx.session
      ? { tenantId: ctx.session.accountId, role: ctx.session.role, viewerRef: `user:${ctx.session.userId}` }
      : null,
  },
});
```

`tools` is an array of `{ name, title, description, inputSchema, handler }`. The
factory refuses to build without a `viewerAdapter` — an unauthenticated
telemetry tool is a data leak an agent will find.

## The tools

All seventeen, or none — there is no allowlist. Register the subset you want at
the server layer.

| tool | answers |
| --- | --- |
| `describe_telemetry` | the vocabulary — event names, attributes, metrics, rollup families, **and the derived catalog**. **Agents should call this first.** |
| `search_events` | raw records matching a filter, newest first, paged |
| `list_errors` | recent errors — "what is breaking?" |
| `event_trends` | a measure over time, bucketed |
| `event_breakdown` | top groups of a measure by one or two dimensions — "which models cost the most" |
| `metric_distribution` | percentiles + histogram — "what is p95 latency?" |
| `rollup_breakdown` | top rows of a rollup family — top issues, top spenders |
| `dimension_values` | the values a dimension actually takes — call it before filtering or grouping |
| `active_users` | exact DAU/WAU/MAU |
| `funnel_analysis` | cohort funnel, conversion, median time-to-step |
| `inspect_trace` | one request correlated across services |
| `user_journey` | one subject's timeline |
| `list_reports` | the menu of saved / configured / derived reports, each with the source it reads |
| `run_report` | execute a report — one from the menu, or an inline one you compose |
| `plan_report` | what a report WOULD cost, without doing the read |
| `list_tenants` | the tenant activity roster (platform operators) |
| `telemetry_health` | drop counters, quarantine, index budget — and the registry edits the data is asking for |

### What `describe_telemetry` returns

`{ registry, catalog, kinds }`. `registry` is the flat projection — key lists
per event name — and it is unchanged. `catalog` is the
[derived catalog](/reference/types#catalog-types), and it is the half an
agent should read: every dimension typed, with its closed value domain when it
has one and an `indexed` flag saying whether filtering on it is a lookup or a
scan; the measures each event can be aggregated by; and, per `sum:` measure,
the rollup families that answer it **exactly** rather than by reading raw rows.

That is what lets an agent pick a cheap, answerable query instead of guessing a
key name and finding out from a 400.

### `run_report` and `plan_report`

`run_report` takes either a `name` from `list_reports` **or** an inline `report`
— the same [Report](/guide/reports) shape the dashboard stores and
`GET /api/report` parses. The inline form is the
general "ask telemetry a question" door: say what is counted (`source`), over
what range, by which `groupBy` dims and with what `measure`, and the planner
picks the primitive.

```jsonc
{ "report": {
    "source": { "event": "llm.completion" },
    "range": "30d",
    "interval": "day",
    "measure": "sum:cost_usd",
    "groupBy": ["attr:gen_ai_request_model"],
    "filters": [{ "dim": "attr:feature", "op": "eq", "value": "chat" }],
    "compare": "previous" } }
```

The answer carries the `plan` it ran — `primitive`, `exactness`
(`exact` / `raw` / `scan`), the family it went `via`, and a `why` sentence — so
an agent can say which store answered and how exact the number is. Raw records
are redacted exactly as `search_events` redacts them. `from`/`to` override the
report's own range. A stored view written before Reports existed still runs: it
comes back marked `legacy: true` with its records, rather than failing.

`plan_report` takes the same input and returns that plan **without doing the
read** — ask before you spend it. When nothing can answer the report it returns
`{ unavailable: true, why }`, and the `why` names the offending key and the
registry change that would make it answerable. A refusal is an answer: read it
and ask a different question rather than retrying the same one.

### What `telemetry_health` returns

`{ counters, quarantine, indexCount, suggestions }`. `counters` now carries the
two attributed maps beside the seven scalars — `rollupSkippedBy`
(`` `${family}|${dimLabel}` ``) and `undeclaredAttrs` (`` `${name}|${attrKey}` ``)
— and `suggestions` is those plus the quarantine read back as registry lines:
each one a `message` and a pasteable `fix`. See
[Suggestions](/reference/types#suggestions).

An agent asked "why is this chart missing data?" can therefore answer with the
edit rather than the symptom. It still only reads: nothing here writes to the
registry.

## Wiring to the official SDK

The one seam to `@modelcontextprotocol/sdk` lives in a separate subpath, so the
core stays dependency-free. It is structural — the SDK is not imported; any
server exposing a compatible `registerTool` works.

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTelemetryMcp } from '@jeffjassky/telemetry/mcp';
import { registerTelemetryTools } from '@jeffjassky/telemetry/mcp/sdk';

const server = new McpServer({ name: 'my-app', version: '1.0.0' });
registerTelemetryTools(server, createTelemetryMcp({ telemetry: t, viewerAdapter }));
```

On any other framework, consume the descriptors directly — derive JSON Schema
from each with the re-exported helper:

```js
import { createTelemetryMcp, toJsonSchema } from '@jeffjassky/telemetry/mcp';

for (const tool of createTelemetryMcp({ telemetry: t, viewerAdapter })) {
  myServer.tool(tool.name, tool.description, toJsonSchema(tool), tool.handler);
}
```

## Scope, tenants, and safety

These tools hand a read surface to an agent, so the isolation rules are
stricter than the dashboard's, not looser.

- **Scope is never a widening argument.** No tool takes a `tenantId` or `scope`.
  The scope comes only from `resolveViewer`. An agent cannot ask to read a
  tenant it was not authorized for.
- **Platform operators may narrow.** When `resolveViewer` returns the platform
  scope (`'*'`), tools accept an optional `tenant` argument to drill into one
  tenant. Under any other scope, passing `tenant` is a hard error — narrowing
  inside a grant, never widening out of one. Grant `'*'` only to viewers you
  have authorized for a cross-tenant read.
- **Raw payloads are redacted by default.** `search_events`, `list_errors`,
  `inspect_trace`, and `user_journey` strip each record's `data` payload before
  it leaves the tool. Pass `redact` to customise, or `redact: false` to accept
  the exposure.
- **Read-only.** Nothing here emits, forgets, mints keys, or saves views.

## Labelling subjects

Pass a `subjectAdapter` — the same one the dashboard takes — and the journey and
error tools resolve subject refs (`user:u_1`) to human labels in their results.

```js
createTelemetryMcp({
  telemetry: t,
  viewerAdapter,
  subjectAdapter: { describe: async (refs) => lookupUsers(refs) },
});
```
