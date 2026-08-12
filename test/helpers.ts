import mongoose from 'mongoose';
import { z } from 'zod';
import { boundedMeta, createTelemetry, defineRegistry } from '../src/server/index.js';

// The mongod itself is booted once for the whole run by test/global-setup.ts
// (12 suites booting their own mongod, serialized by singleFork, was paying a
// boot tax on every file — see that file for why). Each suite just connects
// mongoose to the shared instance.
export async function startDb() {
  const uri = process.env.TELEMETRY_TEST_MONGO_URI;
  if (!uri) throw new Error('TELEMETRY_TEST_MONGO_URI not set — global-setup did not run');
  await mongoose.connect(uri, { dbName: 'telemetry-test' });
  // Force one real round-trip HERE, in the hook. connect() resolving is not the
  // same as the connection being usable: mongoose buffers operations while it
  // settles, and across a sequential run that buffering landed on whichever
  // test ran first — a 30s testTimeout failure with nothing to do with the
  // code under test. The hook has a 60s budget; this is where the wait belongs.
  await mongoose.connection.db!.admin().ping();
}

export async function stopDb() {
  await mongoose.disconnect();
}

/**
 * The paper-test registry (build-plan §0): maxed's real vocabulary as config,
 * plus the schema §4.2 error/span/usage entries so every kind is exercised,
 * plus two shapes the forget/sampling suites need. Tests ARE a host — this is
 * host code.
 */
export const CUSTOMER_ACTORS = ['user', 'system'] as const;

export function paperRegistry() {
  return defineRegistry({
    // ── observations — repeat freely ──
    'page.view': {
      kind: 'event', origin: 'client', subjects: ['user', 'account', 'session'],
      data: boundedMeta(),
      description: 'Navigation telemetry — carries no funnel weight',
    },
    'billing.plan_selected': {
      kind: 'event', origin: 'client', subjects: ['user', 'account'],
      attrs: z.object({ plan: z.string().max(64) }),
      indexedAttrs: ['plan'],
      description: 'Picked a plan or started checkout',
    },

    // ── milestones = lifetime subject rollups; firstAt IS the milestone ──
    'account.signed_up': {
      kind: 'event', origin: 'server', subjects: ['account'],
      attrs: z.object({ source: z.string().max(64) }),
      rollups: [
        { by: ['subject'], subjects: ['account'], actors: [...CUSTOMER_ACTORS], capture: ['attr:source'] },
        { as: 'activity', by: ['subject'], subjects: ['account'], actors: [...CUSTOMER_ACTORS], bucket: 'day', retentionDays: 730 },
      ],
      description: 'Account created',
    },
    'data.first_viewed': {
      kind: 'event', origin: 'client', subjects: ['account'],
      rollups: [
        { by: ['subject'], subjects: ['account'], actors: [...CUSTOMER_ACTORS] },
        { as: 'activity', by: ['subject'], subjects: ['account'], actors: [...CUSTOMER_ACTORS], bucket: 'day', retentionDays: 730 },
      ],
      description: 'The dashboard rendered real measured numbers on screen',
    },
    'account.converted': {
      kind: 'event', origin: 'server', subjects: ['account'],
      rollups: [{ by: ['subject'], subjects: ['account'], actors: [...CUSTOMER_ACTORS] }],
      description: 'Paid subscription active — server-only',
    },

    // ── funnel exits, upgraded to what they are: state transitions ──
    'account.lifecycle': {
      kind: 'state', origin: 'server', subjects: ['account'],
      description: 'Lifecycle transition — trial → active → churned',
    },

    // ── the error tracker ──
    'error.unhandled': {
      kind: 'error', origin: 'any', subjects: [],
      attrs: z.object({ route: z.string().max(200).optional() }),
      burst: { key: 'field:error.fingerprint', maxPerMinute: 60 },
      rollups: [{
        as: 'issue',
        by: ['field:error.fingerprint'],
        capture: ['field:release', 'field:error.type', 'attr:route'],
        retentionDays: null,
      }],
      description: 'Uncaught exception',
    },

    // ── the LLM cost tracker ──
    'llm.completion': {
      kind: 'span', origin: 'server', subjects: ['org'],
      attrs: z.object({
        gen_ai_system: z.string(),
        gen_ai_request_model: z.string(),
        feature: z.string().max(64),
      }),
      metrics: z.object({
        tokens_in: z.number().int(), tokens_out: z.number().int(), cost_usd: z.number(),
      }),
      data: z.object({
        temperature: z.number().optional(),
        top_p: z.number().optional(),
        max_tokens: z.number().int().optional(),
      }).partial(),
      indexedAttrs: ['gen_ai_request_model', 'feature'],
      indexedMetrics: ['cost_usd'],
      retentionDays: 400,
      rollups: [{
        as: 'llm_cost',
        by: ['attr:gen_ai_request_model', 'attr:feature'],
        bucket: 'day',
        sum: ['cost_usd', 'tokens_in', 'tokens_out'],
        retentionDays: null,
      }],
      description: 'Single model call',
    },

    // ── billable usage ──
    'billing.ai_tokens': {
      kind: 'usage', origin: 'server', subjects: ['org'],
      attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string().max(64) }),
      metrics: z.object({ cost_usd: z.number() }),
      rollups: [{ as: 'spend', by: ['attr:gen_ai_request_model'], bucket: 'day', sum: ['cost_usd'] }],
      description: 'Billable token consumption',
    },

    // ── shapes the forget/sampling suites need ──
    'report.shared': {
      kind: 'event', origin: 'server', subjects: ['user'],
      attrs: z.object({ format: z.string().max(16).optional() }),
      rollups: [{ by: ['subject'], subjects: ['user'], actors: [...CUSTOMER_ACTORS] }],
      description: 'Multi-party event for erasure tests',
    },
    'sampled.event': {
      kind: 'event', origin: 'server', subjects: [],
      sampleRate: 0.5,
      rollups: [{ as: 'sampled_family', by: ['field:tenantId'] }],
      description: 'Deterministic sampling probe — traceId tail decides',
    },
    'dim.probe': {
      kind: 'event', origin: 'server', subjects: [],
      attrs: z.object({ group: z.string().optional() }),
      rollups: [{ as: 'dim_probe', by: ['attr:group'] }],
      description: 'Optional-dim probe — a missing dim must skip, never null-bucket',
    },
    'dim.defaulted': {
      kind: 'event', origin: 'server', subjects: [],
      attrs: z.object({ group: z.string().optional() }),
      rollups: [{ as: 'dim_defaulted', by: ['attr:group'], dimDefault: 'none' }],
      description: 'The same probe with an explicit null bucket declared',
    },

    // ── the host whose cost ledger is a span (build-plan B2) ──
    'ledger.charge': {
      kind: 'span', origin: 'server', subjects: ['org'],
      metrics: z.object({ amount_usd: z.number() }),
      durable: true,
      description: 'Declared durable — the caller awaits this row, not every in-flight write',
    },
    'app.ping': {
      kind: 'event', origin: 'client', subjects: [],
      attrs: z.object({ n: z.string().optional() }),
      description: 'Subject-free client event — the wire suite\'s generic probe',
    },
    'ui.mode': {
      kind: 'state', origin: 'client', subjects: [],
      description: 'Client-assertable state — exists to prove the key allowlist works',
    },
  });
}

let n = 0;

/**
 * A fresh telemetry instance per suite: unique model + collection names keep
 * parallel suites out of mongoose's global registry (traps #2) and out of each
 * other's collections.
 */
export function buildTelemetry(overrides: Record<string, unknown> = {}) {
  const id = `t${Date.now().toString(36)}${(n++).toString(36)}`;
  return createTelemetry({
    registry: paperRegistry(),
    connection: mongoose,
    modelName: `Telemetry_${id}`,
    collection: `telemetry_${id}`,
    pepper: 'test-pepper',
    ...overrides,
  });
}

export const CLIENT = { platform: 'web', appVersion: '1.0.0' } as const;

export const at = (iso: string) => new Date(iso);

/** traceIds with a chosen low-32-bit tail — the deterministic sampling probe */
export const KEEP_TRACE = 'tr_feedfeed00000000'; // tail 0 → kept at any rate > 0
export const DROP_TRACE = 'tr_feedfeedffffffff'; // tail max → dropped at any rate < 1
