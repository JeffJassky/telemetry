# Quickstart

Ten minutes from `npm install` to a dashboard with your own events in it. Every
snippet here is real code checked against the shipped types.

## 1. Install

```bash
npm install @jeffjassky/telemetry
```

Node 20+. `mongoose` (7/8/9) and `express` (4.18+/5) are **optional peer
dependencies** — the server entry needs them, the client entries do not, so a
browser bundle never drags the server stack in. Install whichever you already
have:

```bash
npm install mongoose express zod
```

`zod` is a direct dependency of the package, but you import it yourself to write
the registry, so keep it in your own `package.json` too.

## 2. Write a registry

This package ships no event names. This file is the contract — validation,
types, rollups and indexes all derive from it. Start with two entries; you can
add the other thirty later.

```ts
// telemetry/registry.ts
import { z } from 'zod';
import { defineRegistry } from '@jeffjassky/telemetry';

export const REGISTRY = defineRegistry({
  'account.signed_up': {
    kind: 'event',
    origin: 'server',
    subjects: ['account'],
    attrs: z.object({ source: z.string().max(64) }),
    indexedAttrs: ['source'],
    rollups: [
      // lifetime rollup per account — `firstAt` IS the milestone
      { by: ['subject'], subjects: ['account'], actors: ['user', 'system'], capture: ['attr:source'] },
    ],
    description: 'Account created',
  },
  'llm.completion': {
    kind: 'span',
    origin: 'server',
    subjects: ['org'],
    attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string().max(64) }),
    metrics: z.object({ tokens_in: z.number().int(), tokens_out: z.number().int(), cost_usd: z.number() }),
    indexedMetrics: ['cost_usd'],
    rollups: [{
      as: 'llm_cost',
      by: ['attr:gen_ai_request_model', 'attr:feature'],
      bucket: 'day',
      sum: ['cost_usd', 'tokens_in', 'tokens_out'],
      retentionDays: null,
    }],
    description: 'Single model call',
  },
});
```

`defineRegistry()` is an identity function with a `const` type parameter — it
returns exactly what you passed, keeping the literal shapes so `emit()` can be
typed against them. It does not validate; `createTelemetry()` does that.

Full field reference: [The registry](/guide/registry).

## 3. Create the instance

```ts
// telemetry/index.ts
import mongoose from 'mongoose';
import { createTelemetry } from '@jeffjassky/telemetry';
import { REGISTRY } from './registry.js';

await mongoose.connect(process.env.MONGO_URL!);

export const t = createTelemetry({
  registry: REGISTRY,
  connection: mongoose,          // a Connection, or the mongoose module itself
  pepper: process.env.TELEMETRY_PEPPER,
});

await t.syncIndexes();           // ← await this before the first write
```

### Why `syncIndexes()` must be awaited before the first write

`syncIndexes()` awaits `Model.init()` on every model, then builds the
registry-driven payload indexes. Mongoose builds indexes *asynchronously* by
default: on a cold database, writes issued before the build completes race it.

The failure is silent and it is the wrong kind of silent. The unique partial
index on `usage.idempotencyKey` and the one on `{tenantId, dedupeKey}` are what
make a retried write a no-op — with the index still building, both duplicates
land, and you find out when a customer is billed twice. Deterministic rollup
`_id`s depend on the same guarantee.

So: one `await t.syncIndexes()` at boot, before the process accepts traffic. It
is idempotent and cheap on a warm database.

## 4. Emit something

```ts
const result = await t.emit('account.signed_up', {
  tenantId: 'acc_9',
  subjects: [{ type: 'account', id: 'acct_1' }],
  actor: 'user:u_1',
  attrs: { source: 'ads' },
  service: 'api',
  release: 'app@2.1.0',
});

result.outcome; // 'queued' — validated and aggregated, the row save is in flight
result.id;      // the record _id, usable for correlation either way
```

`emit()` is the only write. It returns `{ id, outcome }` rather than
`Promise<void>`, because `Promise<void>` could not tell "durably in Mongo" from
"queued". The outcomes are `written`, `queued`, `deduped`, `sampled`, `capped`,
`rejected` — see [Emitting records](/guide/emit).

The types come from the registry, so this is a compile error:

```ts
// @ts-expect-error — 'account.signup' is not in the registry
await t.emit('account.signup', { tenantId: 'acc_9' });
```

A span carries its correlation fields, and they are required for `kind: 'span'`:

```ts
await t.emit('llm.completion', {
  tenantId: 'acc_9',
  subjects: [{ type: 'org', id: 'o_9' }],
  traceId, spanId, durationMs: 1900,
  attrs: { gen_ai_request_model: 'claude-opus-5', feature: 'chat' },
  metrics: { tokens_in: 1200, tokens_out: 400, cost_usd: 0.048 },
});
```

In tests and in a `SIGTERM` handler, `await t.flush()` drains the in-flight
fire-and-forget writes so everything emitted is queryable.

## 5. Mount the routers

Two routers, both plain express `Router`s that you mount wherever you like.

```ts
import express from 'express';
import { createDashboard, createIngest } from '@jeffjassky/telemetry';
import { t } from './telemetry/index.js';

const app = express();

// the wire endpoint for browser / CLI / desktop SDKs — batch-only, key-authed
app.use('/telemetry/ingest', createIngest({ telemetry: t }));

// the dashboard: /api/* plus the built React SPA
app.use('/telemetry', createDashboard({
  telemetry: t,
  viewerAdapter: {
    resolveViewer: (req) => {
      const u = (req as any).user;
      return u ? { tenantId: u.orgId, role: u.role, viewerRef: `user:${u.id}` } : null;
    },
  },
  mountPath: '/telemetry',   // MUST match where you mounted it
}));

app.listen(3000);
```

Two things that bite:

- **`viewerAdapter` is mandatory.** `createDashboard()` refuses to construct
  without it — an unauthenticated telemetry dashboard is a data leak with
  charts. Returning `null` denies the request. The adapter is the entire access
  boundary; the package never authenticates anyone.
- **`mountPath` must match the path you mounted at.** The SPA's asset URLs and
  API base are derived from it, so a mismatch serves a blank page with a working
  server behind it.

Do not add `express.json()` in front of the ingest router — it parses its own
body with the batch size limit as part of the wire contract.

## 6. Browser events (optional)

The ingest router authenticates with keys you mint from the instance. Publishable
(`pk_`) keys are safe to ship to users; secret (`sk_`) keys are for trusted
processes.

```ts
const { key } = await t.createKey({
  kind: 'publishable',
  tenantMode: 'fixed',            // this key carries its tenant
  tenantId: 'acc_9',
  service: 'webapp',
  env: 'prod',
  origins: ['https://app.example.com'],
});
// the full key string is returned ONCE — store it now, only its hash is kept
```

Then in the browser:

```ts
import { createWebTelemetry } from '@jeffjassky/telemetry/web';
import { REGISTRY } from './telemetry/registry.js';

const c = createWebTelemetry<typeof REGISTRY>({
  key: import.meta.env.VITE_TELEMETRY_KEY,
  url: 'https://app.example.com/telemetry/ingest',
  release: 'app@2.1.0',
});

c.track('account.signed_up', { attrs: { source: 'ads' } });   // typed
c.identify({ user: 'u_1', org: 'o_9' });
```

`track()` is typed against the same registry, so browser typos are compile
errors too. Entries also exist for `/react`, `/vue`, `/electron` and `/cli` —
see [Client SDKs](/reference/client) and [Ingest & keys](/guide/ingest).

## 7. Run the real thing

The repository ships a complete host in one file — an in-memory Mongo, the
registry above expanded to eight entries, three weeks of seeded traffic, both
routers, and a minted publishable key:

```bash
npm run build          # the example consumes dist/, to stay honest about what npm ships
node examples/express/server.js
open http://localhost:3000/telemetry
```

Read [`examples/express/server.js`](https://github.com/JeffJassky/telemetry/blob/main/examples/express/server.js)
next to this page — it is the same wiring with real data behind it.

## Where to go next

- [The registry](/guide/registry) — every `EventSpec` field, the index budget,
  and the boot-time validation rules.
- [Configuration](/guide/configuration) — every `createTelemetry()` key and when
  to change it.
- [Rollups](/guide/rollups) — turning declared dimensions into milestones,
  issues, spend and DAU.
- [Queries & funnels](/guide/queries) — the six read primitives.
- [Testing](/guide/testing) — `flush()`, counters, and the guard test you should
  copy into your own suite.
