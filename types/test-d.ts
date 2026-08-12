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
  ClientContext,
  CreateTelemetryConfig,
  DimSource,
  EmitInput,
  EmitResult,
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
  isPlatformScope,
  BODY_MAX_CHARS,
  INDEX_BUDGET,
  PLATFORM_SCOPE,
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
    durable: true,
    rollups: [{
      as: 'llm_cost',
      by: ['attr:gen_ai_request_model', 'attr:feature'],
      bucket: 'day',
      sum: ['cost_usd'],
      dimDefault: 'none',
    }],
    description: 'Single model call',
  },
});

declare const mongooseish: CreateTelemetryConfig['connection'];

const t = createTelemetry({
  registry,
  connection: mongooseish,
  pepper: 'p',
  platforms: ['watchos'], // EXTENDS the builtins; 'web' still validates
  bodyMax: 4096,
});

// ── emit is typed against the registry ──
async function writes() {
  await t.emit('user.signed_up', {
    tenantId: 'acc_9',
    subjects: [{ type: 'user', id: 'u_1' }, { type: 'org', id: 'o_9' }],
    actor: 'user:u_1',
    attrs: { source: 'ads', plan: 'pro' },
  });

  // the durability contract is in the return type — 'written' vs 'queued'
  const queued: EmitResult = await t.emit('llm.completion', {
    tenantId: 'acc_9',
    subjects: [{ type: 'org', id: 'o_9' }],
    traceId: 'tr_1', spanId: 's_1', durationMs: 1900,
    attrs: { gen_ai_request_model: 'claude-opus-5', feature: 'chat' },
    metrics: { tokens_in: 1, tokens_out: 1, cost_usd: 0.04 },
  });
  const correlationId: string = queued.id;
  if (queued.outcome === 'deduped') void correlationId;

  // idempotent + awaited, per call
  const { outcome } = await t.emit('user.signed_up', {
    tenantId: 'acc_9',
    subjects: [{ type: 'user', id: 'u_1' }, { type: 'org', id: 'o_9' }],
    attrs: { source: 'ads', plan: 'pro' },
    dedupeKey: 'stripe:evt_123',
    durable: true,
  });
  const outcomes: EmitResult['outcome'][] =
    ['written', 'queued', 'deduped', 'sampled', 'capped', 'rejected'];
  void outcomes.includes(outcome);

  // the platform union stays open — builtins autocomplete, host additions compile
  const client: ClientContext = { platform: 'watchos', appVersion: '1.0.0' };
  const builtin: ClientContext = { platform: 'web', appVersion: '1.0.0' };
  void client, builtin;

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

  // scoped() takes a tenantId and only a tenantId — PLATFORM_SCOPE is not
  // special here, it is just a string that matches no row
  const literal: Scoped = t.scoped(PLATFORM_SCOPE);
  literal.find();
  const platform: boolean = isPlatformScope(PLATFORM_SCOPE);
  const notPlatform: boolean = isPlatformScope('acc_9');
  void (platform && notPlatform);

  const gone: ForgetResult = await t.forget('acc_9', 'user:u_1');
  void (gone.deleted + gone.redacted + gone.rollups + gone.aliases);

  const cp: Checkpoint = t.checkpoint('mailery-bridge');
  const mark: Date | null = await cp.get();
  await cp.advance(mark ?? new Date());

  await t.syncIndexes();
  await t.flush();

  const c: TelemetryCounters = t.counters;
  void (c.rejected + c.defaulted + c.sampled + c.capped + c.rollupSkipped + c.deduped + c.truncated);

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
const bodyCap: number = BODY_MAX_CHARS;
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

// ── dashboard surface ──
import type {
  CohortSubject,
  CreateDashboardOptions,
  FunnelCohortWindow,
  FunnelExitResult,
  FunnelParams,
  FunnelResult,
  FunnelSlice,
  FunnelStageResult,
  FunnelStageSpec,
  Queries,
  QueryLimits,
  RecordFilter,
  ResolvedView,
  SubjectAdapter,
  TimeRange,
  Viewer,
  ViewerAdapter,
  ViewSpec,
} from './index.js';
import {
  createDashboard, createQueries, defaultSpaDir, deriveViews, findFamily,
  median, requireMilestoneFamily, summarizeStages, DEFAULT_LIMITS,
} from './index.js';

const viewer: Viewer = { tenantId: 'acc_9', role: 'admin', viewerRef: 'user:u_1' };
/** the platform viewer — the host authorized it, the package only expresses it */
const platformViewer: Viewer = { tenantId: PLATFORM_SCOPE, role: 'admin', viewerRef: 'user:u_ops' };
const viewerAdapter: ViewerAdapter = {
  resolveViewer: () => (isPlatformScope(viewer.tenantId) ? platformViewer : viewer),
};
const subjectAdapter: SubjectAdapter = {
  describe: async (refs) => Object.fromEntries(refs.map((r) => [r, { label: r }])),
};
const view: ViewSpec = {
  name: 'Checkout errors',
  page: 'errors',
  query: { range: '24h', filters: { severity: 'error' }, display: 'table' },
};
const dashOpts: CreateDashboardOptions = {
  telemetry: t,
  viewerAdapter,
  subjectAdapter,
  views: [view],
  queryLimits: { records: 100 },
  onSlowQuery: ({ op, ms }) => void `${op}:${ms}`,
  mountPath: '/telemetry',
};
const dashRouter = createDashboard(dashOpts);
const spa: string = defaultSpaDir();
const derived: ResolvedView[] = deriveViews(registry);
const caps: QueryLimits = DEFAULT_LIMITS;

async function primitives() {
  const q: Queries = createQueries({
    TelemetryModel: t.models.telemetry,
    RollupModel: t.models.rollups,
    registry,
  });
  const range: TimeRange = { from: new Date(0), to: new Date() };
  const f: RecordFilter = { kind: 'span', excludeActorTypes: ['admin'] };
  const page = await q.records('acc_9', range, f, { limit: 50 });
  const next: string | null = page.nextCursor;
  const ser = await q.series('acc_9', range, f, { measure: 'sum:cost_usd', interval: 'day' });
  void ser.buckets[0]?.value;
  await q.distribution('acc_9', range, f);
  const ro = await q.rollups('acc_9', { as: 'llm_cost', sort: 'bucketAt' });
  const src: 'rollups' = ro.dataSource;
  const short: boolean = ro.truncated;
  // the multi-subject read and the explicit cohort field, both new
  await q.rollups('acc_9', { as: 'user.signed_up', dims: ['user:u_1', 'user:u_2'], on: 'firstAt', range });
  await q.trace('acc_9', 'tr_1');
  await q.journey('acc_9', 'user:u_1', range);
  void short;

  // ── the two cohort primitives ──
  const dau = await q.distinctCount('acc_9', { as: 'activity', range, interval: 'day' });
  const distinct: number = dau.distinct;
  const grain: 'hour' | 'day' | 'week' | 'month' = dau.interval;
  const perBucket: number = dau.buckets[0]?.value ?? 0;
  void (distinct + perBucket), grain, dau.truncated;

  const funnelParams: FunnelParams = {
    stages: [{ as: 'user.signed_up' }, { as: 'activated', label: 'Activated' }],
    anchor: 'user.signed_up',
    // half-open by default; the closed form maxed uses is opt-in and named
    cohort: { from: range.from, to: range.to, endInclusive: true } satisfies FunnelCohortWindow,
    exits: [{ as: 'churned' }],
    subjectType: 'user',
    interval: 'week',
    limit: 1_000,
  };
  const fun: FunnelResult = await q.funnel('acc_9', funnelParams);
  const stage: FunnelStageResult = fun.stages[0]!;
  const pctPrev: number | null = stage.pctOfPrevious;
  const fromAnchor: number | null = stage.medianDaysFromAnchor;
  const missed: number = stage.notReached;
  const stalled: number | null = stage.stalledAt; // null on the terminal stage
  const exit: FunnelExitResult = fun.exits[0]!;
  const slice: FunnelSlice | undefined = fun.slices?.[0];
  void (fun.cohortSubjects + fun.first + exit.subjects + missed);
  void pctPrev, fromAnchor, stalled, slice?.at, fun.truncated, fun.cohort.anchor, fun.dataSource;

  // every primitive takes the platform scope in the same position a tenantId
  // goes — that IS the API: one argument, two meanings, no second entry point
  await q.records(PLATFORM_SCOPE, range, f);
  await q.series(PLATFORM_SCOPE, range, f);
  await q.distribution(PLATFORM_SCOPE, range, f);
  await q.rollups(PLATFORM_SCOPE, { as: 'llm_cost' });
  await q.trace(PLATFORM_SCOPE, 'tr_1');
  await q.journey(PLATFORM_SCOPE, 'user:u_1', range);
  await q.distinctCount(PLATFORM_SCOPE, { as: 'activity', range });
  await q.funnel(PLATFORM_SCOPE, { stages: [{ as: 'user.signed_up' }], cohort: range });
}

// ── the funnel math, usable without a database ──
const mid: number | null = median([3, 3, 4, 5]); // 3.5 — mean of the two middles
const empty: number | null = median([]); // null, never 0
const cohortIndex: CohortSubject[] = [
  { ref: 'user:u_1', anchorAt: new Date(), stages: { signed_up: new Date() }, exits: {} },
  { ref: 'user:u_2', anchorAt: null, stages: {}, exits: { churned: new Date() } },
];
const stageSpec: FunnelStageSpec = { as: 'user.signed_up', key: 'signed_up', label: 'Signed up' };
const table: FunnelStageResult[] = summarizeStages(cohortIndex, [
  { order: 1, key: stageSpec.key!, as: stageSpec.as, label: stageSpec.label! },
]);
const family = findFamily(registry, 'llm_cost');
const milestoneSpec: RollupSpec = requireMilestoneFamily(registry, 'user.signed_up', 'funnel()');
void mid, empty, table[0]?.subjects, family?.spec, family?.name, milestoneSpec.by;

// forget() now reports views too
async function forgetViews() {
  const gone = await t.forget('acc_9', 'user:u_1');
  const v: number = gone.views;
}

// ── shapes are exported and usable standalone ──
const dim: DimSource = 'attr:source';
const roll: RollupSpec = { by: [dim], bucket: 'week', actors: ['user'], dimDefault: 'unset' };
const spec: EventSpec = { kind: 'event', origin: 'any', subjects: [], durable: true, description: 'x' };
const reg: Registry = { 'a.b': spec };
const ref: EntityRef = 'user:u_1';
const kind: TelemetryKind = 'usage';
const log: Logger = { info() {}, warn() {}, error() {} };
declare const generic: Telemetry;
const input: EmitInput<typeof registry, 'user.signed_up'> = {
  tenantId: 'a',
  attrs: { source: 's', plan: 'free' },
};
