# Data model

One collection, in your database, under your connection. telemetry never creates
a second connection and never touches a collection you didn't give it.

## The document

| Field | Type | |
|---|---|---|
| `_id` | ObjectId | |
| `userId` | ObjectId → `userRef` | Indexed. A reference into a user system telemetry does not own. |
| `createdAt` | Date | Indexed |
| `updatedAt` | Date | |

## Indexes are yours to build

```js
await pkg.model.createIndexes();
```

Call it once at boot, and `await` it in test setup. Mongoose builds indexes in
the **background**, so a brand-new collection can serve a query before its index
exists — and some queries throw rather than return empty when it doesn't. The
symptom is "passes locally, fails in CI," which is a bad afternoon.

## References out, never joins

telemetry stores `userId` and never queries, joins against, or writes to your
user collection. That is what makes [`purgeUser`](/guide/account-deletion)
necessary rather than automatic — nothing in this package will ever notice a
user disappearing on its own.

## Using your own model

```js
createTelemetry({ model: MyCompiledModel });
```

Bypasses the factory entirely. You own the schema, the indexes, and any drift
from what the routes expect.
