# Types & payloads

Hand-written declarations in `types/`, shipped in the published package and
checked by `tsc --noEmit` in CI.

```ts
import type { createTelemetryConfig, TelemetryInstance, PackageUser } from '@jeffjassky/telemetry';
import type { TelemetryClient, ClientOptions } from '@jeffjassky/telemetry/client';
```

## Why hand-written

The source is plain JS, so generated declarations would say `any` and mean it.
These are the actual contract.

They also rot instantly — which is why `types/test-d.ts` exercises every
exported symbol and runs in CI. On the package this template came from, that
file caught four features missing from `types/` on the afternoon they were
added. If you add an export, add it there in the same commit.

## Core

| Type | |
|---|---|
| `createTelemetryConfig` | Everything you can pass to the factory |
| `TelemetryInstance` | What it returns |
| `PackageUser` | `{ id, email, displayName?, isAdmin? }` |
| `ResolveUser` | `(req) => PackageUser \| null` |
| `UserAdapter` | `{ resolveUser }` |
| `StorageAdapter` | `{ put, get, delete, signUrl }` |
| `UiOptions` | Options for `ui()` / `adminUi()` |
| `Logger` | `{ debug?, info?, warn?, error? }` |
| `PurgeSummary` | `{ removed }` |
| `HttpError` | `status`, `code`, `details?` |

## Client

| Type | |
|---|---|
| `TelemetryClient` | `me`, `list`, `get`, `call` |
| `TelemetryAdminClient` | the above plus `summary` |
| `ClientOptions` | `{ baseUrl?, request?, onUnauthenticated? }` |
| `RequestFn` | `(method, url, body?) => Promise<any>` |
| `MeResponse` / `ListResponse<T>` / `ItemResponse<T>` | payload shapes |

## `id` is a string or an ObjectId

`PackageUser['id']` accepts both, so a host storing ids as strings doesn't have
to cast at every call site.
