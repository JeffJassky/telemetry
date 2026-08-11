# Configuration

Every option has a working default except the connection.

```js
createTelemetry({
  connection: mongoose,
  resolveUser,
});
```

## Database

| Option | Default | |
|---|---|---|
| `connection` | the global `mongoose` | Mongoose instance or connection |
| `modelName` | `TelemetryEvent` | **Set this when a collision is plausible** — see below |
| `collection` | derived from `modelName` | Explicit collection name |
| `userRef` | `User` | The model your stored user ids point at |
| `model` | — | A compiled model, bypassing the factory entirely |

### Why `modelName` matters

Mongoose keeps compiled models in a registry on the connection, and claiming a
name twice throws `OverwriteModelError`. A library cannot own a global name
unconditionally, so telemetry **reuses an already-compiled model** when the name
is taken.

The tradeoff is the whole reason this option exists: if that existing model
isn't ours, queries fail confusingly rather than loudly. If your app already has
a model called `TelemetryEvent`, set `modelName` and stop thinking about it.

## Limits

| Option | Default | |
|---|---|---|
| `listLimit` | `200` | Hard cap on public list reads |
| `adminListLimit` | `500` | Hard cap on admin list reads |

These are **caps, not defaults you can exceed**. A caller asking for more gets
the cap, and the response reports the `limit` actually applied. An unbounded
read against a collection whose size your customers control is an outage.

## Adapters

| Option | Default | |
|---|---|---|
| `resolveUser` | reads `req.authUserId` / `req.user` | [User adapter](/guide/user-adapter), shorthand form |
| `userAdapter` | — | Same, object form. Passing both throws. |
| `logger` | no-op | `{ debug, info, warn, error }` — all optional |
| `track` | no-op | Optional analytics seam |

### `track` is an optional peer, not a dependency

If you run our telemetry package, wire it in:

```js
createTelemetry({ track: telemetry.track });
```

If you don't, leave it out and nothing is recorded. Installing this package must
never drag in an analytics engine and a second Mongo collection — that is the
rule for every cross-package seam here.
