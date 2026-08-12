/**
 * Compile-only exercise of the public declarations. Never executed — `tsc
 * --noEmit` failing here means the .d.ts files drifted from the source.
 *
 * Hand-written types rot within a day. On featureboard this file immediately
 * caught that `types/` was missing FOUR features added the same afternoon.
 * Every exported symbol must appear below. See standards/traps.md #9.
 *
 * THE RULE THAT MATTERS: a value export must be exercised AS A VALUE — read a
 * property off it, call it, assign it to a typed binding. Naming a symbol in an
 * `import type` proves only that some declaration exists; it says nothing about
 * whether the declaration is a const the package ships or a bare type alias.
 * That gap is exactly how `TelemetryKind`, `LogLevel`, `Env`, `Origin`,
 * `KeyKind` and `TenantMode` shipped as runtime objects in `src/` and type-only
 * unions in `types/` — a host writing `TelemetryKind.Usage` got working code
 * that failed `tsc`, and this file compiled clean the whole time. Every entry
 * point's export list is walked below; if a symbol is exported and not here, it
 * is drift waiting to happen.
 */
import { z } from 'zod';
import type {
  AttrsOf,
  Checkpoint,
  ClientContext,
  CreateTelemetryConfig,
  DimSource,
  EmitBase,
  EmitInput,
  EmitResult,
  EntityRef,
  EventSpec,
  ForgetResult,
  Logger,
  MetricsOf,
  Registry,
  RollupSpec,
  Scoped,
  SubjectInput,
  Telemetry,
  TelemetryCounters,
} from './index.js';
// VALUE imports — the vocabulary ships as `const` objects, so importing these
// with `import type` would have hidden the very drift this file exists to catch
import {
  boundedMeta,
  createTelemetry,
  defineRegistry,
  newId,
  plain,
  resolveDim,
  traceKeep,
  truncate,
  validateRegistry,
  isPlatformScope,
  BODY_MAX_CHARS,
  Env,
  INDEX_BUDGET,
  LogLevel,
  Origin,
  PLATFORM_SCOPE,
  RETENTION_DAYS,
  SAMPLE_RATE,
  SCHEMA_VERSION,
  TelemetryKind,
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
  globalSubjectRefs: true, // refs name one party in every tenant — forget() reaches '*' views
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
/** the rollup dimension resolver, exported so burst keys and host state agree */
const resolved: unknown = resolveDim('attr:source', { attrs: new Map([['source', 'ads']]) });
const noSubjectDim: unknown = resolveDim('subject', {});
void resolved, noSubjectDim;
validateRegistry(registry);
const budget: number = INDEX_BUDGET;
const bodyCap: number = BODY_MAX_CHARS;
const spanDays: number | null = RETENTION_DAYS.span;
const rate: number = SAMPLE_RATE.usage;
const v: number = SCHEMA_VERSION;

// ── the vocabulary, in BOTH positions ──
// Each of these ships as a `const` object AND a type. A host writing
// `TelemetryKind.Usage` must compile; so must `const k: TelemetryKind`. Reading
// the member off the object is what proves the value exists — an `import type`
// of the same name proves nothing, which is how these six drifted.
const usageKind: TelemetryKind = TelemetryKind.Usage;
const everyKind: TelemetryKind[] = [
  TelemetryKind.Event, TelemetryKind.Error, TelemetryKind.Span,
  TelemetryKind.State, TelemetryKind.Usage,
];
const fatal: LogLevel = LogLevel.Fatal;
const everyLevel: LogLevel[] = [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error, LogLevel.Fatal];
const prod: Env = Env.Prod;
const everyEnv: Env[] = [Env.Prod, Env.Staging, Env.Dev];
const server: Origin = Origin.Server;
const everyOrigin: Origin[] = [Origin.Server, Origin.Client];
// the literal form keeps working — the const is an addition, never a narrowing
const literalKind: TelemetryKind = 'span';
const literalLevel: LogLevel = 'warn';
const literalEnv: Env = 'dev';
const literalOrigin: Origin = 'client';
// and the objects index the Records the package exports
const kindRetention: number | null = RETENTION_DAYS[TelemetryKind.Usage];
const kindRate: number = SAMPLE_RATE[TelemetryKind.Error];
void usageKind, everyKind, fatal, everyLevel, prod, everyEnv, server, everyOrigin;
void literalKind, literalLevel, literalEnv, literalOrigin, kindRetention, kindRate;

// the envelope base and its parts, standalone
const subject: SubjectInput = { type: 'user', id: 'u_1', role: 'sender' };
const base: EmitBase = {
  tenantId: 'acc_9',
  subjects: [subject],
  actor: 'user:u_1',
  onBehalfOf: 'system:cron',
  occurredAt: new Date(),
  severity: LogLevel.Warn,
  service: 'api',
  release: 'app@1.0.0',
  env: Env.Staging,
  origin: Origin.Server,
  traceId: 'tr_1', spanId: 's_1', parentId: 'p_1', durationMs: 12,
  data: { note: 'x' },
  body: 'prose',
  forceKeep: true,
  dedupeKey: 'stripe:evt_1',
  durable: true,
  error: { type: 'TypeError', message: 'x', handled: false, fingerprint: 'fp', frames: [{ fn: 'f', inApp: true }] },
  state: { key: 'lifecycle', from: 'trial', to: 'active', previousSinceMs: 10 },
  usage: {
    meter: 'tokens', quantity: 1, unit: 'token', amount: '0.04', currency: 'USD',
    idempotencyKey: 'tr_1:s_1', billedTo: 'org:o_9', billable: true,
    priceVersion: 'v1', reverses: 'rec_1',
  },
};
void base;

// the per-event payload projections the typed emit is built from
const signupAttrs: AttrsOf<typeof registry, 'user.signed_up'> = { source: 'ads', plan: 'pro' };
const llmMetrics: MetricsOf<typeof registry, 'llm.completion'> = { tokens_in: 1, tokens_out: 1, cost_usd: 0.04 };
void signupAttrs, llmMetrics;

// ── keys + ingest surface ──
import type {
  ContextAdapter,
  CreateIngestOptions,
  CreateKeyInput,
  IngestContext,
  ParsedKey,
} from './index.js';
import {
  createIngest, createKey, hashSecret, parseKeyString, verifySecret, KeyKind, TenantMode,
} from './index.js';

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
  // both positions again — const object AND union, for the two key enums too
  const publishable: KeyKind = KeyKind.Publishable;
  const secret: KeyKind = KeyKind.Secret;
  const tm: TenantMode = 'claimed';
  const modes: TenantMode[] = [TenantMode.Fixed, TenantMode.Session, TenantMode.Claimed];
  const ok: boolean = verifySecret('s', hashSecret('s'));
  await createKey(t.models.keys, {
    kind: KeyKind.Secret, tenantMode: TenantMode.Claimed, service: 'api', env: 'prod',
    label: 'live', origins: [], allowedKinds: ['usage'], allowedNames: ['llm.completion'],
    maxPerMinute: 600,
  } satisfies CreateKeyInput);
  void kk, publishable, secret, tm, modes, ok;
}

const adapter: ContextAdapter = {
  resolveContext: () => ({ tenantId: 'acc_9', subjects: [{ type: 'user', id: 'u_1' }], actor: 'user:u_1' } satisfies IngestContext),
};
const ingestOpts: CreateIngestOptions = { telemetry: t, contextAdapter: adapter, maxRecords: 50 };
const ingestRouter = createIngest(ingestOpts);

// ── client core (types/core.d.ts) ──
import type {
  ClientContextInput,
  CreateClientOptions,
  ClientStorage,
  DimSource as CoreDimSource,
  EventSpec as CoreEventSpec,
  Registry as CoreRegistry,
  RollupSpec as CoreRollupSpec,
  Span as CoreSpan,
  TelemetryClient as CoreClient,
  TrackOptions,
  Transport,
  TransportResult,
  WireRecord,
} from './core.js';
import {
  createClient as createCoreClient,
  newId as coreNewId,
  defineRegistry as coreDefineRegistry,
  boundedMeta as coreBoundedMeta,
} from './core.js';

// /core re-exports the isomorphic registry surface so a host's registry module
// imports from here and stays mongoose-free
const coreReg: CoreRegistry = coreDefineRegistry({
  'a.b': {
    kind: TelemetryKind.Event,
    origin: Origin.Client,
    subjects: [],
    data: coreBoundedMeta(),
    description: 'x',
  } satisfies CoreEventSpec,
});
const coreRoll: CoreRollupSpec = { by: ['attr:source' satisfies CoreDimSource], bucket: 'day' };
const coreId: string = coreNewId();
void coreReg, coreRoll, coreId;

const transport: Transport = async () => ({ ok: true } satisfies TransportResult);
const storage: ClientStorage = { get: () => null, set: () => {} };
const ctxInput: ClientContextInput = { platform: 'web', appVersion: '1.0.0', online: true };
const clientOpts: CreateClientOptions = {
  key: 'pk_live_tk_000000000000000000000000',
  url: 'https://app.example.com/telemetry/ingest',
  release: 'app@1.0.0',
  flushIntervalMs: 5_000,
  maxBatchSize: 50,
  maxQueueSize: 1_000,
  maxRetries: 5,
  transport,
  storage,
  clientContext: ctxInput,
  consent: () => true,
  errorName: 'error.unhandled',
  onError: () => {},
};
const trackOpts: TrackOptions<{ source: string }, { n: number }> = {
  attrs: { source: 'ads' },
  metrics: { n: 1 },
  data: {},
  occurredAt: new Date(),
  subjects: [{ type: 'user', id: 'u_1' }],
  severity: LogLevel.Info,
};
void clientOpts, trackOpts;
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
const span: CoreSpan = c.startSpan('pdf.render');
const traced: string = span.traceId;
const spanned: string = span.spanId;
span.end({ metrics: { bytes: 100 } });
void traced, spanned;
c.state('account.lifecycle', { key: 'lifecycle', to: 'active' });
c.setActor('user:u_1');
c.setActor(undefined);
const rec: WireRecord = { _id: 'x'.repeat(16), name: 'a', occurredAt: new Date().toISOString() };
// `_internal` exists on every shipped client — the platform adapters use it —
// so the declaration says so, opaquely. Reading a field off it must be a cast,
// which is the whole point of typing it `unknown`.
const internals: unknown = c._internal;
// @ts-expect-error — opaque on purpose: no member of `_internal` is contract
void c._internal.queue;
void internals;
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
  // the sidebar renders this when present and falls back to the origin badge
  icon: '⚑',
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
  // the threshold the callback fires above, and the query cache — all three
  // forwarded to createQueries, none of them reachable before
  slowMs: 250,
  cacheTtlMs: 30_000,
  cacheSize: 200,
  mountPath: '/telemetry',
  apiBase: '/telemetry',
  title: 'Telemetry',
  spaDir: '/srv/ui',
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
    limits: { records: 100 },
    onSlowQuery: ({ op, ms, params }) => void `${op}:${ms}:${String(params)}`,
    slowMs: 250,
    // the in-process cache is tunable — a ten-minute TTL is a default, not a law
    cacheTtlMs: 30_000,
    cacheSize: 200,
  });
  const range: TimeRange = { from: new Date(0), to: new Date() };
  const f: RecordFilter = { kind: 'span', excludeActorTypes: ['admin'] };
  const page = await q.records('acc_9', range, f, { limit: 50 });
  const next: string | null = page.nextCursor;
  const ser = await q.series('acc_9', range, f, { measure: 'sum:cost_usd', interval: 'day' });
  void ser.buckets[0]?.value;
  // the sample is complete; the computation is capped, and says so
  const dist = await q.distribution('acc_9', range, f);
  const scanCut: boolean = dist.truncated;
  void scanCut;
  void caps.distribution;
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

// ── the platform entry points ──
// Six subpaths, six declaration files, and until now this file compiled none of
// them. Each entry's FULL export list is exercised below — every re-exported
// `createClient` under its own alias, every const as a value, every factory
// called. A subpath whose exports are not walked here is a subpath that can
// drift without the gate noticing.
import type * as React from 'react';

import type { TelemetryClient as WebClient, WebTelemetryOptions } from './web.js';
import { createClient as createWebCoreClient, createWebTelemetry } from './web.js';

import type { TelemetryClient as ReactClient } from './react.js';
import {
  createClient as createReactCoreClient,
  TelemetryProvider,
  TelemetryErrorBoundary,
  useTelemetry as useReactTelemetry,
} from './react.js';

import type { TelemetryClient as VueClient } from './vue.js';
import {
  createClient as createVueCoreClient,
  createTelemetryPlugin,
  useTelemetry as useVueTelemetry,
  TELEMETRY_KEY,
} from './vue.js';

import type { MainTelemetryOptions, TelemetryClient as ElectronClient } from './electron.js';
import {
  createClient as createElectronCoreClient,
  createMainTelemetry,
  createRendererTelemetry,
  IPC_CHANNEL,
} from './electron.js';

import type { CliTelemetryOptions, TelemetryClient as CliClient } from './cli.js';
import { createClient as createCliCoreClient, createCliTelemetry } from './cli.js';

// every subpath re-exports the core factory — same shape, six import paths
const reexported: Array<typeof createCoreClient> = [
  createWebCoreClient, createReactCoreClient, createVueCoreClient,
  createElectronCoreClient, createCliCoreClient,
];
void reexported;

// /web — consent is re-added on top of the Omit, DNT/GPC still win
const webOpts: WebTelemetryOptions = {
  key: 'pk_live_tk_000000000000000000000000',
  url: '/telemetry/ingest',
  release: 'app@1.0.0',
  consent: () => true,
  captureGlobalErrors: true,
};
const web: WebClient<typeof registry> = createWebTelemetry<typeof registry>(webOpts);
web.track('user.signed_up', { attrs: { source: 'ads', plan: 'pro' } });

// /react — the provider, the hook, the boundary
const plainClient: ReactClient = createReactCoreClient({ key: 'pk_x', url: '/i', transport });
const providerEl: React.ReactElement = TelemetryProvider({ client: plainClient });
const boundary = new TelemetryErrorBoundary({
  client: plainClient,
  fallback: (e: Error) => e.message,
});
const hooked: ReactClient = useReactTelemetry();
void providerEl, boundary, hooked;

// /vue — the injection key is a value, and the plugin installs onto an app
const vueClient: VueClient = createVueCoreClient({ key: 'pk_x', url: '/i', transport });
const key: 'telemetry' = TELEMETRY_KEY;
const plugin = createTelemetryPlugin(vueClient);
plugin.install({ config: { errorHandler: () => {} }, provide: () => {} });
const injected: VueClient = useVueTelemetry(() => vueClient);
void key, injected;

// /electron — main owns the only real queue, the renderer rides IPC
const channel: 'telemetry:batch' = IPC_CHANNEL;
const mainOpts: MainTelemetryOptions = {
  key: 'sk_live_tk_000000000000000000000000',
  url: 'https://app.example.com/telemetry/ingest',
  captureProcessErrors: true,
  ipcMain: { handle: () => {} },
};
const main: ElectronClient = createMainTelemetry(mainOpts);
const renderer: ElectronClient = createRendererTelemetry(
  { invoke: async () => ({ ok: true }) },
  { release: 'app@1.0.0' },
);
// key/url/transport are Omitted on the renderer — they never leave main
// @ts-expect-error — the renderer must not be handed a key
createRendererTelemetry({ invoke: async () => ({}) }, { key: 'sk_leak' });
void channel, main, renderer;

// /cli — disk-backed queue, opt-out honoured hard
const cliOpts: CliTelemetryOptions = {
  key: 'sk_live_tk_000000000000000000000000',
  url: 'https://app.example.com/telemetry/ingest',
  configDir: '~/.config/mytool',
  argv: ['node', 'mytool', '--no-telemetry'],
  maxQueueAgeMs: 7 * 864e5,
};
const cli: CliClient = createCliTelemetry(cliOpts);
void cli;
