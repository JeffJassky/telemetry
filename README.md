# @jeffjassky/telemetry

Unified telemetry — product events, errors, traces, state transitions, and
billable usage in **one Mongo envelope**, with typed SDKs and a mountable
dashboard.

Five kinds, one collection, discriminated on `kind`, driven by a registry your
application owns. This package ships no event names.

```bash
npm install @jeffjassky/telemetry
```

Full docs: **https://jeffjassky.github.io/telemetry/**

## Quick start

```js
import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  createDashboard, createIngest, createTelemetry, defineRegistry,
} from '@jeffjassky/telemetry';

// 1. The registry is the contract: validation, types, rollups, indexes.
const REGISTRY = defineRegistry({
  'account.signed_up': {
    kind: 'event', origin: 'server', subjects: ['account'],
    attrs: z.object({ source: z.string().max(64) }),
    indexedAttrs: ['source'],
    rollups: [{ by: ['subject'], subjects: ['account'], capture: ['attr:source'] }],
    description: 'Account created',
  },
  'llm.completion': {
    kind: 'span', origin: 'server', subjects: ['org'],
    attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string().max(64) }),
    metrics: z.object({ tokens_in: z.number().int(), tokens_out: z.number().int(), cost_usd: z.number() }),
    rollups: [{
      as: 'llm_cost', by: ['attr:gen_ai_request_model'],
      bucket: 'day', sum: ['cost_usd'], retentionDays: null,
    }],
    description: 'Single model call',
  },
});

await mongoose.connect(process.env.MONGO_URL);

// 2. One instance. Validates the registry at construction.
const t = createTelemetry({ registry: REGISTRY, connection: mongoose });
await t.syncIndexes();          // ← await before the first write. See below.

// 3. emit() is the only write, and it is typed against the registry.
await t.emit('account.signed_up', {
  tenantId: 'acc_9',
  subjects: [{ type: 'account', id: 'acct_1' }],
  actor: 'user:u_1',
  attrs: { source: 'ads' },
});

// 4. Two routers you mount wherever you like.
const app = express();
app.use('/telemetry/ingest', createIngest({ telemetry: t }));
app.use('/telemetry', createDashboard({
  telemetry: t,
  viewerAdapter: {
    resolveViewer: (req) =>
      req.user ? { tenantId: req.user.orgId, role: req.user.role } : null,
  },
  mountPath: '/telemetry',
}));
```

Then `open http://localhost:3000/telemetry`.

## The three things to get right

**1. `await t.syncIndexes()` before the first write.** Mongoose builds indexes
asynchronously; on a cold database, writes issued during the build race it. The
unique index on `usage.idempotencyKey` is what makes a retried billing write a
no-op — with the build still in flight, both copies land, and you find out when
a customer is billed twice.

**2. `viewerAdapter` is the entire access boundary.** `createDashboard()`
refuses to construct without it, because an unauthenticated telemetry dashboard
is a data leak with charts. The package never authenticates anyone — it asks who
is calling and trusts your answer. Returning `{ tenantId: '*' }` grants a
cross-tenant read; that is *your* authorization decision, and the package will
never infer it from a role or a header.

**3. Set a distinct `modelName` if two instances share one connection.** Mongoose
keeps compiled models per connection, so the second instance silently reuses the
first one's model — and therefore the first one's registry. Your events become
unregistered and get quarantined.

## What it is not

Not an APM, not a log aggregator, not a warehouse. No profiling, no ops time
series, no free-form log stream, no ad-hoc N-step funnels over raw events. It
answers the questions you declared in advance, exactly, from aggregates it
maintained on write. Sized for small SaaS — thousands of users, not billions of
events.

## Requirements

Node 20+. `mongoose` (7/8/9) and `express` (4.18+/5) are **optional peer
dependencies** — the server entry needs them, the client entries do not, so a
browser bundle never pulls the server stack in. All three Mongoose majors run
the full suite in CI. `react` and `vue` are optional peers for their client
entries.

Entry points: `.` (server), `/core`, `/web`, `/react`, `/vue`, `/electron`,
`/cli`.

## Try it

```bash
npm run build
node examples/express/server.js     # in-memory Mongo, seeded data, both routers
open http://localhost:3000/telemetry
```

## Development

```bash
npm install
npm run check-tracked   # run this FIRST — a global gitignore can eat source files
npm run typecheck
npm run build           # server, then the UI bundle into dist/ui
npm test                # after build: the UI tests assert against the bundle
```

## License

MIT © Jeff Jassky
