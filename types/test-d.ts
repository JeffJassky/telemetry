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
