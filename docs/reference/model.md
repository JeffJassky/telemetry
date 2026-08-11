# Model factory

```js
import { createTelemetryEventModel, buildTelemetryEventSchema } from '@jeffjassky/telemetry';
```

Usually you don't call these — `createTelemetry` does. Reach for them when you want
the model before the routers exist, or a second one on another connection.

## `createTelemetryEventModel(options)`

| Option | Default | |
|---|---|---|
| `connection` | global `mongoose` | Mongoose instance or connection |
| `modelName` | `TelemetryEvent` | |
| `collection` | derived | |
| `userRef` | `User` | Model the stored `userId` points at |

**Returns an already-compiled model if the name is taken.**

That is not a convenience, it is a requirement: `connection.model(name, schema)`
throws `OverwriteModelError` on a second call, and a library cannot claim a
process-global name unconditionally — the host may already have one, or the
package may be loaded twice through a hoisting mismatch.

The cost of that choice: if the existing model isn't ours, queries fail
confusingly rather than loudly. Set `modelName` whenever a collision is
plausible.

## `buildTelemetryEventSchema(options)`

The uncompiled schema. Extend it, then compile it yourself:

```js
const schema = buildTelemetryEventSchema({ userRef: 'Account' });
schema.add({ tenantId: { type: String, index: true } });

createTelemetry({ model: mongoose.model('TelemetryEvent', schema) });
```

You now own the schema and any drift from what the routes expect.

## Indexes

```js
await pkg.model.createIndexes();
```

Once at boot, and awaited in test setup. Mongoose builds indexes in the
background; a fresh collection can serve a query before its index exists, and
some throw rather than return empty.
