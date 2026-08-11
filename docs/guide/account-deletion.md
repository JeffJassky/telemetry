# Account deletion

```js
await pkg.purgeUser(userId);
```

One call, in your account-deletion path. This is the **outbound** direction of
the [user adapter](/guide/user-adapter) — the host telling telemetry about a
lifecycle event it has no other way to learn about.

## Why this is your job

telemetry stores references into a user system it does not own: an id per
document, sometimes a copied email or display name. It never queries your user
collection, so it will never notice a row vanish. Nothing else in your stack
will clean those references up either.

## What it does

- Removes documents owned by that user
- Repairs every derived value the removal touches

## It is idempotent

Call it twice and the second call removes nothing and reports zero. That is
deliberate: deletion paths get retried, and a purge that double-counts or throws
on the second attempt turns a routine GDPR request into an incident.

```js
const { removed } = await pkg.purgeUser(userId);
```

## Test it

```js
expect((await pkg.purgeUser(id)).removed).toBe(1);
expect((await pkg.purgeUser(id)).removed).toBe(0);
```

Assert the second call, not just the first. The first call working proves
almost nothing.
