# Testing

Testing a host that uses this package means testing against **a real Mongo**.
`mongodb-memory-server` boots one per suite in a second or two, and the
alternative — mocking the model layer — proves nothing here. Almost every
guarantee in this package is a property of a Mongo write: a deterministic rollup
`_id`, a unique partial index, an update-pipeline upsert, a TTL. A mock asserts
that you called the mock.

The package's own suite is the reference implementation of this, and
[`test/helpers.ts`](https://github.com/JeffJassky/telemetry/blob/main/test/helpers.ts)
is the file to copy from.

## The harness

```ts
// test/helpers.ts
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTelemetry } from '@jeffjassky/telemetry';
import { registry } from '../src/telemetry/registry.js';

let mongod: MongoMemoryServer;

export async function startDb() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'app-test' });
  // Force one real round-trip HERE. connect() resolving is not the same as the
  // connection being usable: mongoose buffers operations while it settles, and
  // that buffering lands on whichever test happens to run first — a timeout
  // failure with nothing to do with the code under test.
  await mongoose.connection.db!.admin().ping();
}

export async function stopDb() {
  await mongoose.disconnect();
  await mongod?.stop();
}

let n = 0;

export function buildTelemetry(overrides: Record<string, unknown> = {}) {
  const id = `t${Date.now().toString(36)}${(n++).toString(36)}`;
  return createTelemetry({
    registry,
    connection: mongoose,
    // Distinct names per suite. Mongoose keeps compiled models in a
    // per-connection registry, and a reused name silently reuses the FIRST
    // instance's registry and counters.
    modelName: `Telemetry_${id}`,
    collection: `telemetry_${id}`,
    pepper: 'test-pepper',
    ...overrides,
  });
}
```

```ts
// any suite
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTelemetry, startDb, stopDb } from './helpers.js';

describe('signup instrumentation', () => {
  beforeAll(startDb);
  afterAll(stopDb);
  // …
});
```

Three details in there are load-bearing, and each one cost somebody an afternoon:

**The ping.** `mongoose.connect()` resolving does not mean the connection is
usable. Put the round trip in the hook, where there is a real time budget for it,
rather than letting it land on an arbitrary test.

**A distinct `modelName` and `collection` per instance.** Mongoose's model
registry is global per connection. Reusing a name does not throw — it silently
hands back the first model, still closed over the *first* instance's registry and
counters, and your assertions start describing another suite's telemetry.

**A `pepper`.** [`forget()`](/guide/erasure) throws without one rather than
falling back to a default, so any suite touching erasure needs it set here or in
`TELEMETRY_PEPPER`.

## `await t.syncIndexes()` before the first write

```ts
const t = buildTelemetry();
await t.syncIndexes();
```

Cold-database writes racing asynchronous index builds duplicate silently. The
unique partial indexes on `usage.idempotencyKey` and `{ tenantId, dedupeKey }` are
what make [idempotent emit](/guide/emit) work at all — without them, a webhook
redelivery writes a second row *and* a second rollup increment, and the test that
was supposed to catch that passes.

Skip it and any assertion about dedupe, or about the index budget, is testing
nothing. It is cheap; call it in the suite's setup.

## `await t.flush()` before asserting on fire-and-forget writes

A default `emit()` returns `queued`: validated, aggregated, save in flight.
`flush()` drains everything still in flight for that instance.

```ts
await t.emit('report.shared', {
  tenantId: 'tn_1',
  subjects: [{ type: 'user', id: 'u_1' }],
  attrs: { format: 'pdf' },
});
await t.flush();

expect(await t.scoped('tn_1').find({ name: 'report.shared' })).toHaveLength(1);
```

Without the flush the assertion is a race that passes on a fast machine and fails
in CI, which is the worst version of a failing test.

### When you do not need it

When `emit()` returned `written`, the **row** is already on disk:

```ts
const r = await t.emit('ledger.charge', { /* … */ durable: true });
expect(r.outcome).toBe('written');
// no flush — that is the whole point of durable
expect(await t.models.telemetry.countDocuments({ name: 'ledger.charge' })).toBe(1);
```

That covers `durable` writes and every insert-gated write — `kind: 'usage'` and
anything carrying a `dedupeKey` — because gating aggregation on the insert
requires awaiting it.

**On a `durable` emit, `written` covers the rollups too.** A `durable` write
awaits both planes, so an assertion about a [rollup](/guide/rollups) — a
milestone, a spend total, a funnel — needs no flush either:

```ts
const r = await t.emit('billing.ai_tokens', { /* … */ });  // usage: durable by kind
expect(r.outcome).toBe('written');
// no flush — 'written' means the row and its aggregates
const [spend] = await t.models.rollups.find({ as: 'spend' }).lean();
expect(spend.sums.cost_usd).toBeCloseTo(0.42);
```

Two asymmetries are worth keeping straight, because they are the whole rule:

- A **`queued`** emit has *started* its rollup writes without awaiting them. Its
  aggregates are correct in intent but not yet on disk, so an assertion about
  either plane still needs the flush.
- A **`dedupeKey` write on a non-durable spec** is insert-gated, so it awaits its
  row and reports `written` — but not its rollups. Assert on the row freely;
  flush before asserting on the aggregate, or mark the spec `durable`.

Call `flush()` in your SIGTERM handler for the same reason you call it here.

## Assert on `t.counters`

The drops are the interesting part. A crash gets fixed in ten minutes; a payload
that quietly fails validation ships for a year, and the chart it feeds looks
plausible the whole time.

```ts
it('emits a valid record on every path through checkout', async () => {
  const t = buildTelemetry();
  await runCheckout(t, fixture);
  await t.flush();

  // the assertion that makes a schema drift fail the build rather than the dashboard
  expect(t.counters.rejected).toBe(0);
  expect(t.counters.rollupSkipped).toBe(0);
  expect(t.counters.defaulted).toBe(0);
});
```

`rejected` catches an unregistered name, a failed zod check, an undeclared `data`
payload silently dropped. `rollupSkipped` catches a dimension resolving empty with
no `dimDefault` — the record wrote a row and moved no aggregate. `defaulted`
catches `service` / `release` missing and stamped `unknown`, which is how a
release-over-release comparison ends up empty six months later.

When you *expect* a drop, assert the count moved, and read the quarantine to check
the reason:

```ts
const r = await t.emit('never.registered' as any, { tenantId: 'tn_1' });
expect(r.outcome).toBe('rejected');
expect(t.counters.rejected).toBe(1);

const [quarantined] = await t.collections.rejects().find({}).toArray();
expect(quarantined.reason).toBe('unregistered event');
```

Counters are per instance and never reset, so build a fresh instance per test
rather than trying to zero them.

## Testing the routers

Mount them the way production does and drive them over HTTP with `supertest`.
Both routers are Express routers the host mounts — never an app, never a server —
so the test can hold the mount path constant with the real one.

```ts
import express from 'express';
import request from 'supertest';
import { createDashboard } from '@jeffjassky/telemetry';

const state = { viewer: { tenantId: 'tn_1', role: 'member', viewerRef: 'user:u_1' } };
const app = express().use('/telemetry', createDashboard({
  telemetry: t,
  mountPath: '/telemetry',
  viewerAdapter: { resolveViewer: () => state.viewer },
}));

const res = await request(app).get('/telemetry/api/records?from=…&to=…');
```

A mutable `state.viewer` lets one app instance play every role — including
`null` for the unauthenticated case and `'*'` for a platform viewer.

## The tests only you can write

The package refuses to construct a dashboard without a
[`viewerAdapter`](/guide/adapters), but it cannot check that yours is *correct* —
what a tenant is, who is staff, and what `role: 'admin'` should mean are all
host facts. Once you hand over a `resolveViewer`, whatever it returns **is** the
access decision. Your adapter is the entire boundary, and a test in your repo is
the only thing that catches a refactor quietly widening it.

The package ships `examples/admin-guard.test.js` for exactly this. **Copy it into
your suite**, adjust the mount path, session helper and role names — and do not
adjust what it asserts.

Worth pinning, in your suite, not ours:

- an unauthenticated request gets `401` and no data
- a member of tenant A cannot read tenant B — assert on the **response body**, not
  just the status
- your adapter returns `'*'` for exactly the people you think it does, and for
  nobody else
- a non-admin viewer gets `403` from `POST /api/system/keys/:id/revoke`
- deleting a user calls `t.forget()` — the assertion being that the account
  deletion path invokes it at all
- your ingest keys' `allowedNames` / `allowedKinds` still exclude the
  server-origin milestones you never want a browser asserting

## Name tests after the failure

```
✗  it('handles rollups')
✓  it('a sampled-away record still reaches its rollup — aggregate before you drop')
```

Six months later the second one tells a reader what invariant they just broke.
The package's own suite is written this way throughout; if a guarantee here is
ever unclear, the test name is usually the clearest sentence anyone has written
about it.

## Where to go next

- [Emitting records](/guide/emit) — outcomes, and which ones need a flush
- [Erasure](/guide/erasure) — asserting delete-vs-redact
- [Adapters](/guide/adapters) — the seams your tests have to cover
