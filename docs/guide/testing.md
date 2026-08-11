# Testing

telemetry is tested with Vitest, `mongodb-memory-server`, and `supertest` — real
HTTP against a real Mongo, no mocks.

## The test you have to write

telemetry ships `examples/admin-guard.test.js`. **Copy it into your suite.**

The package cannot enforce admin access — `isAdmin` gates nothing, because
"admin" means something different in every host. Your middleware is the entire
boundary, and a test in your repo is the only thing that catches a refactor
quietly removing it.

```js
it('refuses a signed-in non-admin', async () => {
  const res = await request(app)
    .get('/api/telemetry/admin/summary')
    .set('cookie', await sessionFor({ isAdmin: false }));
  expect(res.status).toBe(403);
});
```

## Testing your integration

Mount the routers the way production does, then drive them over HTTP:

```js
import { createTelemetry } from '@jeffjassky/telemetry';

const pkg = createTelemetry({
  connection: mongoose,
  // A distinct model name per suite keeps mongoose's global registry from
  // colliding across parallel test files.
  modelName: `TelemetryEventTest${randomSuffix()}`,
  resolveUser: (req) => req.testUser ?? null,
});

await pkg.model.createIndexes();   // await it, don't race it
```

## What's worth asserting

Test the things that are **silently wrong**, not the ones that are loudly
broken. A crash gets fixed in ten minutes; a payload that quietly leaks an
internal id ships for a year.

- An unauthenticated request gets the right status **and no DB hit**
- A private field is `undefined` in the payload — not merely hidden by the UI
- A list read is capped: ask for 100,000, assert what you got back
- A thrown handler returns JSON, not HTML
- `purgeUser` called twice removes nothing the second time
- `<base href>` matches the mount path you passed

## Name tests after the failure

```
✗  it('handles /me')
✓  it('does not shadow /me with the /:id route')
```

Six months later the second one tells a reader why reordering a file broke CI.
