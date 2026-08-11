# `createTelemetry(config)`

The entry point. Returns routers and a model; never an app, never a server.

```js
import { createTelemetry } from '@jeffjassky/telemetry';

const pkg = createTelemetry({ connection: mongoose, resolveUser });
```

## Config

See [Configuration](/guide/configuration) for the full table and the reasoning.

## Returns

| | |
|---|---|
| `model` | The Mongoose model. `await model.createIndexes()` once at boot. |
| `routes` | Public JSON router — [Routers](/reference/routers) |
| `adminRoutes` | Admin JSON router. **You guard it.** |
| `ui(opts)` | Public SPA router — [UI routers](/reference/ui-routers) |
| `adminUi(opts)` | Admin SPA router |
| `purgeUser(id)` | Outbound adapter direction — [Account deletion](/guide/account-deletion) |

## Also exported

| | |
|---|---|
| `createUserAdapter(opts)` | Object form of the user adapter |
| `defaultResolveUser(req)` | The built-in inbound adapter |
| `createTelemetryEventModel(opts)` | [Model factory](/reference/model) |
| `buildTelemetryEventSchema(opts)` | The bare schema, uncompiled |
| `defaultSpaDir()` | Resolved path to the shipped SPA bundle |
| `HttpError` | `status` + stable `code`, answered as itself rather than a 500 |

## Throws

- Both `userAdapter` and `resolveUser` passed — it will not silently pick one
- `resolveUser` is not a function
- `track` is not a function
