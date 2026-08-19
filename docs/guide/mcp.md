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

All fourteen, or none — there is no allowlist. Register the subset you want at
the server layer.

| tool | answers |
| --- | --- |
| `describe_telemetry` | the vocabulary — event names, attributes, metrics, rollup families. **Agents should call this first.** |
| `search_events` | raw records matching a filter, newest first, paged |
| `list_errors` | recent errors — "what is breaking?" |
| `event_trends` | a measure over time, bucketed |
| `metric_distribution` | percentiles + histogram — "what is p95 latency?" |
| `rollup_breakdown` | top rows of a rollup family — top issues, top spenders |
| `active_users` | exact DAU/WAU/MAU |
| `funnel_analysis` | cohort funnel, conversion, median time-to-step |
| `inspect_trace` | one request correlated across services |
| `user_journey` | one subject's timeline |
| `list_reports` | the menu of saved / configured / derived reports |
| `run_report` | execute one named report |
| `list_tenants` | the tenant activity roster (platform operators) |
| `telemetry_health` | drop counters, quarantine, index budget |

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
