/**
 * Compile-only exercise of the public declarations. Never executed — `tsc
 * --noEmit` failing here means the .d.ts files drifted from the source.
 *
 * Hand-written types rot within a day. On featureboard this file immediately
 * caught that `types/` was missing FOUR features added the same afternoon.
 * Every exported symbol must appear below. See standards/traps.md #9.
 */
import { z } from 'zod';
import type {
  Checkpoint,
  CreateTelemetryConfig,
  DimSource,
  EmitInput,
  EntityRef,
  EventSpec,
  ForgetResult,
  Logger,
  Registry,
  RollupSpec,
  Scoped,
  Telemetry,
  TelemetryCounters,
  TelemetryKind,
} from './index.js';
import {
  boundedMeta,
  createTelemetry,
  defineRegistry,
  newId,
  plain,
  traceKeep,
  truncate,
  validateRegistry,
  INDEX_BUDGET,
  RETENTION_DAYS,
  SAMPLE_RATE,
  SCHEMA_VERSION,
} from './index.js';

// ── the registry keeps literal shapes through defineRegistry ──
const registry = defineRegistry({
  'user.signed_up': {
    kind: 'event',
    origin: 'server',
    subjects: ['user', 'org'],
    attrs: z.object({ source: z.string().max(64), plan: z.enum(['free', 'pro']) }),
    indexedAttrs: ['source'],
    rollups: [
      { by: ['subject'], subjects: ['user'], actors: ['user', 'system'], capture: ['attr:source'] },
      { as: 'activity', by: ['subject'], subjects: ['user'], bucket: 'day', retentionDays: 730 },
    ],
    description: 'Account created',
  },
  'llm.completion': {
    kind: 'span',
    origin: 'server',
    subjects: ['org'],
    attrs: z.object({ gen_ai_request_model: z.string(), feature: z.string() }),
    metrics: z.object({ tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number() }),
    data: boundedMeta(),
    indexedMetrics: ['cost_usd'],
    retentionDays: 400,
    rollups: [{ as: 'llm_cost', by: ['attr:gen_ai_request_model', 'attr:feature'], bucket: 'day', sum: ['cost_usd'] }],
    description: 'Single model call',
  },
});

declare const mongooseish: CreateTelemetryConfig['connection'];

const t = createTelemetry({ registry, connection: mongooseish, pepper: 'p' });

// ── emit is typed against the registry ──
async function writes() {
  await t.emit('user.signed_up', {
    tenantId: 'acc_9',
    subjects: [{ type: 'user', id: 'u_1' }, { type: 'org', id: 'o_9' }],
    actor: 'user:u_1',
    attrs: { source: 'ads', plan: 'pro' },
  });

  await t.emit('llm.completion', {
    tenantId: 'acc_9',
    subjects: [{ type: 'org', id: 'o_9' }],
    traceId: 'tr_1', spanId: 's_1', durationMs: 1900,
    attrs: { gen_ai_request_model: 'claude-opus-5', feature: 'chat' },
    metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.04 },
  });

  // @ts-expect-error — unknown event name is a compile error, not a silent drop
  await t.emit('user.typo', { tenantId: 'acc_9' });

  await t.emit('user.signed_up', {
    tenantId: 'acc_9',
    // @ts-expect-error — attrs are typed per event; `plan: 'gold'` is not in the enum
    attrs: { source: 'ads', plan: 'gold' },
  });
}

// ── the rest of the surface ──
async function reads() {
  const s: Scoped = t.scoped('acc_9');
  s.find({ subjectKeys: 'user:u_1' });
  s.aggregate([{ $match: { kind: 'span' } }]);
  s.rollups({ as: 'llm_cost' });
  s.rollupAggregate([{ $group: { _id: '$dims' } }]);

  const gone: ForgetResult = await t.forget('acc_9', 'user:u_1');
  void (gone.deleted + gone.redacted + gone.rollups + gone.aliases);

  const cp: Checkpoint = t.checkpoint('mailery-bridge');
  const mark: Date | null = await cp.get();
  await cp.advance(mark ?? new Date());

  await t.syncIndexes();
  await t.flush();

  const c: TelemetryCounters = t.counters;
  void (c.rejected + c.defaulted + c.sampled + c.capped + c.rollupSkipped);

  t.models.telemetry.find();
  t.models.byKind.usage.countDocuments();
  t.models.rollups.aggregate([]);
  t.models.checkpoints.findOne();
  t.collections.rejects().countDocuments();
  t.collections.aliases().deleteMany({});
}

// ── helpers keep their contracts ──
const id: string = newId();
const kept: boolean = traceKeep('tr_00ff', 0.5);
const day: Date | undefined = truncate(new Date(), 'day');
const obj: unknown = plain(new Map());
validateRegistry(registry);
const budget: number = INDEX_BUDGET;
const spanDays: number | null = RETENTION_DAYS.span;
const rate: number = SAMPLE_RATE.usage;
const v: number = SCHEMA_VERSION;

// ── keys + ingest surface ──
import type {
  ContextAdapter,
  CreateIngestOptions,
  CreateKeyInput,
  IngestContext,
  KeyKind,
  ParsedKey,
  TenantMode,
} from './index.js';
import { createIngest, createKey, hashSecret, parseKeyString, verifySecret } from './index.js';

async function keys() {
  const minted = await t.createKey({
    kind: 'publishable',
    tenantMode: 'fixed',
    tenantId: 'acc_9',
    service: 'web',
    env: 'prod',
    origins: ['https://app.example.com'],
  });
  const full: string = minted.key;
  const parsed: ParsedKey | null = parseKeyString(full);
  const kk: KeyKind = parsed!.kind;
  const tm: TenantMode = 'claimed';
  const ok: boolean = verifySecret('s', hashSecret('s'));
  await createKey(t.models.keys, { kind: 'secret', tenantMode: 'claimed', service: 'api', env: 'prod' } satisfies CreateKeyInput);
  void kk, tm, ok;
}

const adapter: ContextAdapter = {
  resolveContext: () => ({ tenantId: 'acc_9', subjects: [{ type: 'user', id: 'u_1' }], actor: 'user:u_1' } satisfies IngestContext),
};
const ingestOpts: CreateIngestOptions = { telemetry: t, contextAdapter: adapter, maxRecords: 50 };
const ingestRouter = createIngest(ingestOpts);

// ── client core (types/core.d.ts) ──
import type { TelemetryClient as CoreClient, Transport, WireRecord } from './core.js';
import { createClient as createCoreClient } from './core.js';

const transport: Transport = async () => ({ ok: true });
const c: CoreClient<typeof registry> = createCoreClient<typeof registry>({
  key: 'pk_live_tk_000000000000000000000000',
  url: 'https://app.example.com/telemetry/ingest',
  release: 'app@1.0.0',
  transport,
});
c.track('user.signed_up', { attrs: { source: 'ads', plan: 'pro' } });
// @ts-expect-error — typo'd names are compile errors in clients too
c.track('user.typo');
c.identify({ user: 'u_1', org: 'o_9' });
c.captureError(new Error('x'), { handled: false });
const span = c.startSpan('pdf.render');
span.end({ metrics: { bytes: 100 } });
c.state('account.lifecycle', { key: 'lifecycle', to: 'active' });
const rec: WireRecord = { _id: 'x'.repeat(16), name: 'a', occurredAt: new Date().toISOString() };
async function drain() {
  await c.flush();
  await c.shutdown();
}

// ── shapes are exported and usable standalone ──
const dim: DimSource = 'attr:source';
const roll: RollupSpec = { by: [dim], bucket: 'week', actors: ['user'] };
const spec: EventSpec = { kind: 'event', origin: 'any', subjects: [], description: 'x' };
const reg: Registry = { 'a.b': spec };
const ref: EntityRef = 'user:u_1';
const kind: TelemetryKind = 'usage';
const log: Logger = { info() {}, warn() {}, error() {} };
declare const generic: Telemetry;
const input: EmitInput<typeof registry, 'user.signed_up'> = {
  tenantId: 'a',
  attrs: { source: 's', plan: 'free' },
};
