---
layout: home

hero:
  name: telemetry
  text: Five kinds, one envelope
  tagline: Product events, errors, spans, state transitions and billable usage are one Mongo collection with a discriminated `kind` — driven by a registry your app owns, not a vocabulary this package ships.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: The registry
      link: /guide/registry
    - theme: alt
      text: View on GitHub
      link: https://github.com/JeffJassky/telemetry

features:
  - title: The registry is yours
    icon: 📇
    details: 'This package ships zero event names. You write a `defineRegistry({...})` block; it drives validation, TypeScript types on `emit()` and `track()`, derived rollups, and index creation. Misconfiguration throws at boot, not in a dashboard six weeks later.'
    link: /guide/registry
    linkText: Write a registry
  - title: Two planes, one write
    icon: ⚖️
    details: 'Every valid record updates aggregates unconditionally; the raw row is separately subject to sampling and burst caps. Dropping evidence never bends a number. Money and idempotent writes invert the order — the insert is the dedupe, so it must gate the rollup.'
    link: /guide/emit
    linkText: How emit works
  - title: Rollups maintained on write
    icon: 📈
    details: 'One primitive — group by a declared tuple, keep first/last/count/sums — is a milestone, an error-issue group, windowed spend, and a DAU stream. Late and backfilled records correct `firstAt` retroactively, because cohort math built on arrival order is wrong.'
    link: /guide/rollups
    linkText: Declare a rollup
  - title: Erasure is a guarantee
    icon: 🧹
    details: '`data` is dropped unless the registry declares a schema for it, so there is no untyped corner for identifiers to hide in. `forget(tenantId, ref)` deletes sole-party rows, redacts shared ones, rekeys rollups and drops aliases — and reports what it touched.'
    link: /guide/erasure
    linkText: Erase a subject
  - title: A dashboard you mount
    icon: 🎛️
    details: 'A React SPA plus six query primitives behind one express Router, served from your own domain at any mount path. No redirect to a vendor, no SSO handshake, no data leaving your database. Your `viewerAdapter` is the entire access boundary.'
    link: /guide/dashboard
    linkText: Mount the dashboard
  - title: Typed SDKs, everywhere
    icon: 🧩
    details: 'Entries for web, react, vue, electron and cli — batching, offline queueing, traces, `identify()`. `createClient<typeof REGISTRY>()` makes a typo in an event name a compile error in the browser too, and publishable keys never 4xx into a user''s console.'
    link: /reference/client
    linkText: Client SDKs
---

```js
import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  createDashboard, createIngest, createTelemetry, defineRegistry,
} from '@jeffjassky/telemetry';

// This package ships no event names. This block is the contract.
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

const t = createTelemetry({ registry: REGISTRY, connection: mongoose });
await t.syncIndexes();   // boot — await this before the first write

await t.emit('account.signed_up', {
  tenantId: 'acc_9',
  subjects: [{ type: 'account', id: 'acct_1' }],
  actor: 'user:u_1',
  attrs: { source: 'ads' },
});

const app = express();
app.use('/telemetry/ingest', createIngest({ telemetry: t }));
app.use('/telemetry', createDashboard({
  telemetry: t,
  viewerAdapter: { resolveViewer: (req) => req.user && { tenantId: req.user.orgId, role: req.user.role } },
  mountPath: '/telemetry',
}));
```
