/**
 * Example host — the complete wiring in one file, on a throwaway in-memory
 * Mongo, with seeded demo data so the dashboard has something to show:
 *
 *   node examples/express/server.js
 *   open http://localhost:3000/telemetry
 *
 * A real host swaps MongoMemoryServer for its own connection, the stub
 * viewerAdapter for its auth, and the seed block for real emit() call sites.
 */
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
// The BUILT package — run `npm run build` first. Consuming dist keeps this
// example honest about what npm installs actually get.
import {
  boundedMeta, createDashboard, createIngest, createTelemetry, defineRegistry,
} from '../../dist/index.js';

// ── the host-owned registry (maxed's paper-test vocabulary, condensed) ──
const REGISTRY = defineRegistry({
  'page.view': {
    kind: 'event', origin: 'client', subjects: ['user', 'account', 'session'],
    data: boundedMeta(),
    description: 'Navigation telemetry',
  },
  'account.signed_up': {
    kind: 'event', origin: 'server', subjects: ['account'],
    attrs: z.object({ source: z.string().max(64) }),
    indexedAttrs: ['source'],
    rollups: [
      { by: ['subject'], subjects: ['account'], actors: ['user', 'system'], capture: ['attr:source'] },
      { as: 'activity', by: ['subject'], subjects: ['account'], actors: ['user', 'system'], bucket: 'day', retentionDays: 730 },
    ],
    description: 'Account created',
  },
  'data.first_viewed': {
    kind: 'event', origin: 'client', subjects: ['account'],
    rollups: [
      { by: ['subject'], subjects: ['account'], actors: ['user', 'system'] },
      { as: 'activity', by: ['subject'], subjects: ['account'], actors: ['user', 'system'], bucket: 'day', retentionDays: 730 },
    ],
    description: 'Dashboard rendered real numbers',
  },
  'account.converted': {
    kind: 'event', origin: 'server', subjects: ['account'],
    rollups: [{ by: ['subject'], subjects: ['account'], actors: ['user', 'system'] }],
    description: 'Paid subscription active',
  },
  'account.lifecycle': {
    kind: 'state', origin: 'server', subjects: ['account'],
    description: 'trial → active → churned',
  },
  'error.unhandled': {
    kind: 'error', origin: 'any', subjects: [],
    attrs: z.object({ route: z.string().max(200).optional() }),
    burst: { key: 'field:error.fingerprint', maxPerMinute: 60 },
    rollups: [{
      as: 'issue', by: ['field:error.fingerprint'],
      capture: ['field:release', 'field:error.type', 'attr:route'],
      retentionDays: null,
    }],
    description: 'Uncaught exception',
  },
  'llm.completion': {
    kind: 'span', origin: 'server', subjects: ['org'],
    attrs: z.object({ gen_ai_system: z.string(), gen_ai_request_model: z.string(), feature: z.string().max(64) }),
    metrics: z.object({ tokens_in: z.number().int(), tokens_out: z.number().int(), cost_usd: z.number() }),
    indexedAttrs: ['gen_ai_request_model', 'feature'],
    indexedMetrics: ['cost_usd'],
    retentionDays: 400,
    rollups: [{
      as: 'llm_cost', by: ['attr:gen_ai_request_model', 'attr:feature'],
      bucket: 'day', sum: ['cost_usd', 'tokens_in', 'tokens_out'], retentionDays: null,
    }],
    description: 'Single model call',
  },
  'billing.ai_tokens': {
    kind: 'usage', origin: 'server', subjects: ['org'],
    attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string().max(64) }),
    metrics: z.object({ cost_usd: z.number() }),
    rollups: [{ as: 'spend', by: ['attr:gen_ai_request_model'], bucket: 'day', sum: ['cost_usd'] }],
    description: 'Billable tokens',
  },
});

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'telemetry-example' });

const t = createTelemetry({ registry: REGISTRY, connection: mongoose, pepper: 'example' });
await t.syncIndexes();

// ── seed: three weeks of plausible traffic ──
const TENANT = 'demo';
const day = (n, h = 12) => new Date(Date.now() - n * 864e5 + h * 36e5 - 12 * 36e5);
const models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const features = ['chat', 'summarize', 'extract'];
const sources = ['organic', 'ads', 'shopify'];
const rand = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; })();

for (let a = 0; a < 12; a++) {
  const acc = [{ type: 'account', id: `acct_${a}` }];
  const signup = 20 - a; // staggered signups
  await t.emit('account.signed_up', {
    tenantId: TENANT, subjects: acc, occurredAt: day(signup),
    attrs: { source: sources[a % 3] }, actor: a % 4 === 3 ? 'system:shopify' : `user:u_${a}`,
    service: 'api', release: 'app@2.1.0',
  });
  await t.emit('account.lifecycle', {
    tenantId: TENANT, subjects: acc, occurredAt: day(signup, 13),
    state: { key: 'lifecycle', to: 'trial' }, actor: 'system:billing',
    service: 'api', release: 'app@2.1.0',
  });
  for (let d = signup - 1; d >= 0; d--) {
    if (rand() < 0.55) continue; // not active every day
    await t.emit('page.view', {
      tenantId: TENANT,
      subjects: [...acc, { type: 'user', id: `u_${a}` }, { type: 'session', id: `ses_${a}_${d}` }],
      client: { platform: 'web', appVersion: '2.1.0', browser: 'Chrome' },
      occurredAt: day(d, 9 + Math.floor(rand() * 8)),
      actor: `user:u_${a}`, service: 'webapp', release: 'app@2.1.0',
      data: { route: ['/dashboard', '/reports', '/settings'][Math.floor(rand() * 3)] },
    });
  }
  if (a < 9) {
    await t.emit('data.first_viewed', {
      tenantId: TENANT, subjects: acc, occurredAt: day(signup - 1, 15),
      client: { platform: 'web', appVersion: '2.1.0' }, actor: `user:u_${a}`,
      service: 'webapp', release: 'app@2.1.0',
    });
  }
  if (a < 5) {
    await t.emit('account.converted', {
      tenantId: TENANT, subjects: acc, occurredAt: day(signup - 3, 16),
      actor: 'system:stripe-webhook', service: 'api', release: 'app@2.1.0',
    });
    await t.emit('account.lifecycle', {
      tenantId: TENANT, subjects: acc, occurredAt: day(signup - 3, 16),
      state: { key: 'lifecycle', from: 'trial', to: 'active', previousSinceMs: 3 * 864e5 },
      actor: 'system:billing', service: 'api', release: 'app@2.1.0',
    });
  } else if (a >= 9) {
    await t.emit('account.lifecycle', {
      tenantId: TENANT, subjects: acc, occurredAt: day(signup - 14 > 0 ? signup - 14 : 0, 3),
      state: { key: 'lifecycle', from: 'trial', to: 'trial_expired', previousSinceMs: 14 * 864e5 },
      actor: 'system:nightly', service: 'api', release: 'app@2.1.0',
    });
  }
}

// llm spans + usage, spread over the window
for (let i = 0; i < 160; i++) {
  const d = Math.floor(rand() * 20);
  const model = models[Math.floor(rand() * 3)];
  const feature = features[Math.floor(rand() * 3)];
  const tokens = 400 + Math.floor(rand() * 4000);
  const cost = tokens * (model.includes('opus') ? 3e-5 : model.includes('sonnet') ? 1e-5 : 2e-6);
  const traceId = `tr_${i.toString(16).padStart(4, '0')}${Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0')}`;
  await t.emit('llm.completion', {
    tenantId: TENANT, subjects: [{ type: 'org', id: `acct_${Math.floor(rand() * 12)}` }],
    traceId, spanId: `s_${i}`, durationMs: 400 + Math.floor(rand() * 4000),
    occurredAt: day(d, 8 + Math.floor(rand() * 10)),
    attrs: { gen_ai_system: 'anthropic', gen_ai_request_model: model, feature },
    metrics: { tokens_in: Math.floor(tokens * 0.7), tokens_out: Math.floor(tokens * 0.3), cost_usd: cost },
    service: 'api', release: 'app@2.1.0',
  });
  if (rand() < 0.5) {
    await t.emit('billing.ai_tokens', {
      tenantId: TENANT, subjects: [{ type: 'org', id: `acct_${Math.floor(rand() * 12)}` }],
      traceId, occurredAt: day(d, 20),
      attrs: { gen_ai_request_model: model, feature }, metrics: { cost_usd: cost },
      usage: {
        meter: 'ai_tokens', quantity: tokens, unit: 'token',
        idempotencyKey: `${traceId}:usage`, billedTo: `org:acct_${Math.floor(rand() * 12)}`,
      },
      service: 'api', release: 'app@2.1.0',
    });
  }
  if (rand() < 0.12) {
    await t.emit('error.unhandled', {
      tenantId: TENANT, traceId, occurredAt: day(d, 14),
      attrs: { route: '/reports' },
      error: {
        type: rand() < 0.5 ? 'TypeError' : 'FetchError',
        message: rand() < 0.5 ? 'x is not a function' : 'socket hang up',
        handled: false,
        fingerprint: rand() < 0.5 ? 'fp_type_x' : 'fp_socket',
        frames: [
          { filename: 'src/reports/export.ts', fn: 'exportPdf', lineno: 88, colno: 12, inApp: true },
          { filename: 'node_modules/pdfkit/lib/document.js', fn: 'flush', lineno: 412, colno: 9 },
        ],
      },
      service: 'api', release: 'app@2.1.0',
    });
  }
}
await t.flush();
console.log(`[example] seeded — counters ${JSON.stringify(t.counters)}`);

// ── the host app ──
const app = express();

// stub auth: everyone is the demo tenant's admin. A real host resolves its session.
const viewerAdapter = {
  resolveViewer: () => ({ tenantId: TENANT, role: 'admin', viewerRef: 'user:demo' }),
};

const { key } = await t.createKey({
  kind: 'publishable', tenantMode: 'fixed', tenantId: TENANT,
  service: 'webapp', env: 'dev', origins: ['http://localhost:3000'],
});
console.log(`[example] pk for browser SDK: ${key}`);

app.use('/telemetry/ingest', createIngest({ telemetry: t }));
app.use('/telemetry', createDashboard({ telemetry: t, viewerAdapter, mountPath: '/telemetry' }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`[example] http://localhost:${port}/telemetry`));
