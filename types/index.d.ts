import type { Aggregate, Collection, Connection, Model, Mongoose, Query } from 'mongoose';
import type { z } from 'zod';

// ── vocabulary ──────────────────────────────────────────────────────────────

/**
 * The vocabulary ships as `const` objects, so each name is a VALUE as well as a
 * type: `TelemetryKind.Usage` in an expression, `TelemetryKind` in a type
 * position. Declaring only the union would deny a value the package exports —
 * working code that fails `tsc`.
 */
export declare const TelemetryKind: {
  readonly Event: 'event';
  readonly Error: 'error';
  readonly Span: 'span';
  readonly State: 'state';
  readonly Usage: 'usage';
};
export type TelemetryKind = (typeof TelemetryKind)[keyof typeof TelemetryKind];

export declare const LogLevel: {
  readonly Debug: 'debug';
  readonly Info: 'info';
  readonly Warn: 'warn';
  readonly Error: 'error';
  readonly Fatal: 'fatal';
};
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export declare const Env: {
  readonly Prod: 'prod';
  readonly Staging: 'staging';
  readonly Dev: 'dev';
};
export type Env = (typeof Env)[keyof typeof Env];

export declare const Origin: {
  readonly Server: 'server';
  readonly Client: 'client';
};
export type Origin = (typeof Origin)[keyof typeof Origin];

/** `type:id` — 'user:u_1', 'org:o_9', 'system:cron' */
export type EntityRef = `${string}:${string}`;

export declare const RETENTION_DAYS: Record<TelemetryKind, number | null>;
export declare const SAMPLE_RATE: Record<TelemetryKind, number>;
export declare const SCHEMA_VERSION: number;
export declare const INDEX_BUDGET: number;
/** `body` cap in characters (16384). Over it, the value is clipped and marked. */
export declare const BODY_MAX_CHARS: number;

/**
 * `'*'` — the dashboard's cross-tenant read scope. Set it as a `Viewer.tenantId`
 * (from your own `viewerAdapter`, for viewers you have already authorized) and
 * the query primitives drop the tenant term: a support console, a platform-wide
 * cost page. Every row shape still carries its `tenantId`, so a cross-tenant
 * number stays attributable.
 *
 * RESERVED on the write side, because a tenant literally named `'*'` would be a
 * privilege escalation via a string: `emit()` quarantines it, `forget()` and
 * `createKey()` (fixed mode) throw, and ingest refuses the batch whichever way
 * the tenant resolved. `scoped()` does NOT honour it — that primitive's
 * isolation guarantee is unconditional by design, so `scoped('*')` matches the
 * literal string, which is to say nothing.
 */
export declare const PLATFORM_SCOPE: '*';

/** true when a scope is PLATFORM_SCOPE rather than a tenantId */
export declare function isPlatformScope(tenantId: unknown): boolean;

/** UUIDv7 — sortable, insertion-local. Never substitute crypto.randomUUID (v4). */
export declare function newId(): string;

/** Consistent per-trace sampling verdict. Throws in dev on an unsampleable traceId. */
export declare function traceKeep(traceId: string | undefined, rate: number): boolean;

/** Deep-converts Mongoose Maps to plain objects — JSON.stringify(Map) is '{}'. */
export declare function plain(v: unknown): unknown;

export declare function truncate(d: Date, bucket?: 'hour' | 'day' | 'week' | 'month'): Date | undefined;

/**
 * Read one dimension source off a record — the same resolution rollups and
 * emit()'s burst cap use, exported so a host can key its own derived state the
 * way the package keys its aggregates. `'subject'` is handled by fan-out, not
 * here, so it resolves to `undefined`.
 */
export declare function resolveDim(src: DimSource, doc: any): unknown;

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ── registry ────────────────────────────────────────────────────────────────

/** A dimension source: `subject` fans out over subject refs; the others read one value. */
export type DimSource = 'subject' | `attr:${string}` | `field:${string}`;

export interface RollupSpec {
  /** rollup family — several event names may feed one. Default: the event name */
  as?: string;
  /** dimensions, in order. At most one `subject`. */
  by: readonly DimSource[];
  /** when `by` includes `subject`, restrict to these subject types (required then) */
  subjects?: readonly string[];
  /** actor TYPE allowlist — e.g. ['user','system'] keeps admin browsing out of customer aggregates */
  actors?: readonly string[];
  /** UTC time bucket. Omit for a lifetime rollup — the classic milestone. */
  bucket?: 'hour' | 'day' | 'week' | 'month';
  /** metric keys accumulated with $add */
  sum?: readonly string[];
  /** dimension sources snapshotted at FIRST occurrence — cohort dimensions */
  capture?: readonly DimSource[];
  /**
   * Bucket name for a non-subject dim that resolves null/empty. Absent = skip
   * the record and count it in `rollupSkipped`. May not contain `|` or `=`.
   * Never applies to the subject dim.
   */
  dimDefault?: string;
  /** rollup TTL. Omit or null = immortal. */
  retentionDays?: number | null;
}

export interface EventSpec {
  kind: TelemetryKind;
  origin: Origin | 'any';
  /** subject TYPES that must be present on every record */
  subjects: readonly string[];
  /** attrs are STRING values — use z.string()/z.enum()/z.coerce.* */
  attrs?: z.ZodObject<any>;
  metrics?: z.ZodObject<any>;
  /**
   * `data` is UNSTORED unless declared. Closes the erasure hole. Declare an
   * OBJECT schema or `boundedMeta()` — `EmitInput.data` is an object, so a
   * scalar schema is expressible here and unreachable through emit().
   */
  data?: z.ZodType<any>;
  indexedAttrs?: readonly string[];
  indexedMetrics?: readonly string[];
  rollups?: readonly RollupSpec[];
  /** overrides RETENTION_DAYS[kind]. null = immortal */
  retentionDays?: number | null;
  /** overrides SAMPLE_RATE[kind]. Dormant — everything ships at 1. */
  sampleRate?: number;
  /** cap RAW rows per resolved key per minute; rollups still see every record */
  burst?: { key?: DimSource; maxPerMinute: number };
  /** await the write with {w:'majority', j:true} and rethrow. usage is durable regardless. */
  durable?: boolean;
  description: string;
}

export type Registry = Record<string, EventSpec>;

/** Identity with a `const` type parameter — literal specs keep their shapes. */
export declare function defineRegistry<const R extends Registry>(specs: R): R;

/**
 * The maxed-shaped `data` escape hatch: scalars, ≤12 keys, ≤200-char strings,
 * one nesting level, ≤4KB. Out of bounds drops the WHOLE object — never truncates.
 */
export declare function boundedMeta(): z.ZodType<Record<string, unknown> | undefined>;

/** Boot-time contract checks — throws on misconfiguration. createTelemetry runs it. */
export declare function validateRegistry(registry: Registry): void;

// ── typed emit ──────────────────────────────────────────────────────────────

export type AttrsOf<R extends Registry, N extends keyof R> =
  R[N] extends { attrs: infer A extends z.ZodType<any> } ? z.infer<A> : Record<string, never>;
export type MetricsOf<R extends Registry, N extends keyof R> =
  R[N] extends { metrics: infer M extends z.ZodType<any> } ? z.infer<M> : Record<string, never>;

export interface SubjectInput {
  type: string;
  id: string;
  /** disambiguates same-type parties: sender | recipient | impersonated */
  role?: string;
}

export interface ClientContext {
  /** the builtins autocomplete; hosts extend the accepted set via CreateTelemetryConfig.platforms */
  platform: 'web' | 'electron' | 'ios' | 'android' | 'server' | 'cli' | (string & {});
  appVersion: string;
  userAgent?: string;
  os?: string;
  osVersion?: string;
  browser?: string;
  browserVersion?: string;
  deviceType?: string;
  locale?: string;
  timezone?: string;
  screenW?: number;
  screenH?: number;
  viewportW?: number;
  viewportH?: number;
  connection?: string;
  online?: boolean;
  /** client clock minus server clock, ms */
  clockSkewMs?: number;
}

export interface EmitBase {
  tenantId: string;
  subjects?: SubjectInput[];
  actor?: EntityRef;
  onBehalfOf?: EntityRef;
  occurredAt?: Date;
  severity?: LogLevel;
  service?: string;
  release?: string;
  env?: Env;
  origin?: Origin;
  client?: ClientContext;
  traceId?: string;
  spanId?: string;
  parentId?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  body?: string;
  /** keep despite sampling — set automatically for money/errors */
  forceKeep?: boolean;
  /**
   * Caller idempotency for event/state/span/error — trusted SERVER callers
   * only. Non-empty, ≤200 chars. Implies forceKeep (the record's aggregation is
   * gated on its own insert) and inverts the plane order: save first, roll up
   * only if the insert won.
   */
  dedupeKey?: string;
  /** await the write with {w:'majority', j:true} and rethrow — overrides EventSpec.durable */
  durable?: boolean;
  error?: {
    type: string;
    message: string;
    handled?: boolean;
    fingerprint: string;
    frames?: Array<{
      filename?: string; fn?: string; lineno?: number; colno?: number;
      inApp?: boolean; context?: string[];
    }>;
  };
  state?: { key: string; from?: string; to: string; previousSinceMs?: number };
  usage?: {
    meter: string;
    quantity: number;
    unit: string;
    /** authoritative money — pass a Decimal128-compatible value */
    amount?: unknown;
    currency?: string;
    /** at-least-once dedupe, deterministic — e.g. `${traceId}:${spanId}` */
    idempotencyKey: string;
    billedTo: EntityRef;
    billable?: boolean;
    priceVersion?: string;
    reverses?: string;
  };
}

export type EmitInput<R extends Registry, N extends keyof R> = EmitBase & {
  attrs?: AttrsOf<R, N>;
  metrics?: MetricsOf<R, N>;
};

// ── the factory ─────────────────────────────────────────────────────────────

export interface TelemetryCounters {
  rejected: number;
  defaulted: number;
  sampled: number;
  capped: number;
  rollupSkipped: number;
  /** insert-gated writes whose dedupeKey / usage.idempotencyKey already existed */
  deduped: number;
  /** `body` values clipped to the cap — the row survives, marked */
  truncated: number;
}

/** What emit() did. `Promise<void>` could not distinguish "written" from "queued". */
export interface EmitResult {
  /** the record _id — usable for correlation even when the row was not stored */
  id: string;
  /**
   * written  — BOTH planes are on disk and awaited: the row, and its rollups.
   *            Readable immediately, with no flush(). One meaning, on every
   *            path that returns it — durable specs, kind=usage, and
   *            insert-gated dedupeKey writes alike.
   *            A rollup that FAILS is quarantined and counted rather than
   *            thrown, as on every other path — awaiting an aggregate must not
   *            turn its failure into a report that the row does not exist.
   * queued   — validated and aggregated; the save is in flight, t.flush() awaits it
   * deduped  — dedupeKey already present: nothing written, nothing aggregated
   * sampled  — evidence plane declined; aggregates were still updated
   * capped   — burst cap declined; aggregates were still updated
   * rejected — unregistered or failed validation; quarantined in the rejects collection
   */
  outcome: 'written' | 'queued' | 'deduped' | 'sampled' | 'capped' | 'rejected';
}

export interface Checkpoint {
  /** null on the first ever run */
  get(): Promise<Date | null>;
  advance(at: Date): Promise<void>;
}

export interface ForgetResult {
  deleted: number;
  redacted: number;
  rollups: number;
  aliases: number;
  views: number;
}

export interface Scoped {
  find(q?: Record<string, unknown>): Query<any[], any>;
  aggregate(stages: Record<string, unknown>[]): Aggregate<any[]>;
  rollups(q?: Record<string, unknown>): Query<any[], any>;
  rollupAggregate(stages: Record<string, unknown>[]): Aggregate<any[]>;
}

export interface CreateTelemetryConfig<R extends Registry = Registry> {
  /** the host-owned event registry — see defineRegistry() */
  registry: R;
  /** a mongoose Connection, or the mongoose module itself */
  connection: Connection | Mongoose;
  /** base collection; six siblings derive: `<collection>_rollups`, `_rejects`,
   *  `_aliases`, `_checkpoints`, `_keys`, `_views` */
  collection?: string;
  /** set when two instances share one connection — traps #2 */
  modelName?: string;
  /** secret pepper for forget()'s rekeying. Falls back to TELEMETRY_PEPPER. */
  pepper?: string;
  /** EXTENDS the builtin `client.platform` list — never replaces it */
  platforms?: readonly string[];
  /** override BODY_MAX_CHARS for this instance */
  bodyMax?: number;
  /**
   * Declares that a subject ref (`type:id`) names the same party in EVERY
   * tenant. Only effect today: forget() also erases the person's
   * platform-scoped saved views, which a tenant-scoped call otherwise misses.
   * Leave it off when ids are minted per tenant — there, `user:u_1` is a
   * different person in each, and one tenant's erasure would reach another's.
   */
  globalSubjectRefs?: boolean;
  logger?: Logger;
}

export interface Telemetry<R extends Registry = Registry> {
  /** write — the only write. The result says what actually happened to the row. */
  emit<N extends keyof R & string>(name: N, doc: EmitInput<R, N>): Promise<EmitResult>;
  /**
   * Erasure: delete sole-party rows, redact shared ones, rekey rollups, drop
   * aliases. Tenant-scoped — rejects PLATFORM_SCOPE, so a platform-wide erasure
   * is N calls that each name their tenant. Reaches the person's
   * platform-scoped saved views only when `globalSubjectRefs` is set.
   */
  forget(tenantId: string, ref: EntityRef): Promise<ForgetResult>;
  /**
   * Tenant scope is not optional — every read goes through here. Unconditional
   * on purpose: it does not understand PLATFORM_SCOPE, so `scoped('*')` scopes
   * to the literal '*' and matches nothing. Cross-tenant reads live in the
   * dashboard query layer, behind `viewerAdapter`.
   */
  scoped(tenantId: string): Scoped;
  /** pull-importer watermark — advisory; downstream writers must be idempotent */
  checkpoint(key: string): Checkpoint;
  /** boot: declared + registry-driven indexes. Await before first write — traps #3. */
  syncIndexes(): Promise<void>;
  /** await in-flight fire-and-forget writes (tests, graceful shutdown) */
  flush(): Promise<void>;
  /** drop/default/cap counts — surface on /metrics so drops are never silent */
  counters: TelemetryCounters;
  /** the registry this instance validates against */
  registry: R;
  logger: Logger;
  /** mint an ingest key against this instance's key collection */
  createKey(input: CreateKeyInput): Promise<{ key: string; id: string }>;
  models: {
    telemetry: Model<any>;
    byKind: Record<TelemetryKind, Model<any>>;
    rollups: Model<any>;
    checkpoints: Model<any>;
    keys: Model<any>;
  };
  collections: {
    rejects(): Collection;
    aliases(): Collection;
  };
}

export declare function createTelemetry<const R extends Registry>(
  config: CreateTelemetryConfig<R>,
): Telemetry<R>;

// ── keys (instrumentation §2) ───────────────────────────────────────────────

/** `const` + type twin, like the vocabulary above — `KeyKind.Secret` is a value */
export declare const KeyKind: {
  readonly Publishable: 'publishable';
  readonly Secret: 'secret';
};
export type KeyKind = (typeof KeyKind)[keyof typeof KeyKind];

/** fixed: the key carries tenantId · session: the host resolves it · claimed: the payload asserts it (sk_ only) */
export declare const TenantMode: {
  readonly Fixed: 'fixed';
  readonly Session: 'session';
  readonly Claimed: 'claimed';
};
export type TenantMode = (typeof TenantMode)[keyof typeof TenantMode];

export interface ParsedKey {
  kind: KeyKind;
  label: string;
  id: string;
  secret?: string;
}
export declare function parseKeyString(raw: string | undefined): ParsedKey | null;
/** versioned scrypt — a param change bumps the prefix, old hashes keep verifying */
export declare function hashSecret(secret: string): string;
/** constant-time comparison */
export declare function verifySecret(secret: string, stored: string | undefined): boolean;

export interface CreateKeyInput {
  kind: KeyKind;
  tenantMode: TenantMode;
  tenantId?: string;
  service: string;
  env: string;
  label?: string;
  origins?: string[];
  allowedKinds?: string[];
  allowedNames?: string[];
  maxPerMinute?: number;
}

/** Mint a key. The full string is returned ONCE — only the secret's hash is stored. */
export declare function createKey(
  KeyModel: Model<any>,
  input: CreateKeyInput,
): Promise<{ key: string; id: string }>;

// ── ingest (instrumentation §3–4) ───────────────────────────────────────────

export interface IngestContext {
  tenantId: string;
  subjects?: Array<SubjectInput>;
  actor?: string;
}

export interface ContextAdapter {
  /** INBOUND: who is making this request? Only consulted for tenantMode=session. */
  resolveContext(req: unknown): IngestContext | null | Promise<IngestContext | null>;
}

export interface CreateIngestOptions {
  telemetry: Telemetry<any>;
  contextAdapter?: ContextAdapter;
  maxRecords?: number;
  bodyLimit?: string;
  keyCacheMs?: number;
}

/**
 * The wire endpoint — an express Router the host mounts. Batch-only,
 * insert-gated rollups, pk_ never 4xxes, sk_ gets honest errors.
 */
export declare function createIngest(opts: CreateIngestOptions): import('express').Router;

// ── dashboard (dashboards §2–§8) ────────────────────────────────────────────

export interface QueryLimits {
  records: number;
  series: number;
  rollups: number;
  trace: number;
  journey: number;
  /** raw docs distribution will scan before it reports an undercount */
  distribution: number;
  /** rollup docs distinctCount will scan before it reports an undercount */
  distinct: number;
  /** subjects in one funnel cohort */
  funnel: number;
}
export declare const DEFAULT_LIMITS: QueryLimits;

export interface TimeRange {
  from: Date;
  to: Date;
}

export interface RecordFilter {
  kind?: string;
  name?: string;
  severity?: string;
  env?: string;
  service?: string;
  release?: string;
  subject?: string;
  traceId?: string;
  attrs?: Record<string, string>;
  metrics?: Record<string, { gte?: number; lte?: number }>;
  /** the customer toggle: exclude these actor TYPES ('admin', 'system') */
  excludeActorTypes?: string[];
}

// ── cohort math (cohort-math §1) ────────────────────────────────────────────

export interface FunnelStageSpec {
  /** the lifetime rollup family whose doc marks this stage — `firstAt` IS the timestamp */
  as: string;
  /** stable identifier in the response. Default: `as` */
  key?: string;
  label?: string;
  description?: string;
}

export interface FunnelCohortWindow extends TimeRange {
  /**
   * Include `to` itself. Default FALSE — the package is half-open everywhere.
   * maxed's funnel is closed on both ends, so a host migrating off it sets this.
   */
  endInclusive?: boolean;
}

export interface FunnelParams {
  stages: readonly FunnelStageSpec[];
  /** the milestone that assigns cohort membership and anchors time-to-step. Default: `stages[0].as` */
  anchor?: string;
  cohort: FunnelCohortWindow;
  /** exit families — counted, never staged */
  exits?: readonly FunnelStageSpec[];
  subjectType?: string;
  /** also slice the cohort by anchor date. UTC, Monday-start weeks. */
  interval?: 'day' | 'week' | 'month';
  limit?: number;
}

export interface FunnelStageResult {
  order: number;
  key: string;
  as: string;
  label: string;
  description?: string;
  /** subjects with this stage present. NOT monotonic — the funnel is literal, never backfilled. */
  subjects: number;
  /** 0–100, unrounded. null when stage 1's count is 0. */
  pctOfFirst: number | null;
  /** null on stage 1 and whenever the previous count is 0 — never 0, never Infinity. */
  pctOfPrevious: number | null;
  /** fractional days, unrounded. null on an empty sample. */
  medianDaysFromAnchor: number | null;
  medianDaysFromPrevious: number | null;
  /** reached the PREVIOUS stage and not this one. 0 on stage 1. */
  notReached: number;
  /** reached this stage and not the NEXT. null on the terminal stage — there is nowhere to stall. */
  stalledAt: number | null;
}

export interface FunnelExitResult {
  key: string;
  as: string;
  label: string;
  subjects: number;
}

export interface FunnelSlice {
  /** the truncated anchor date — a UTC bucket start, not a '2026-W31' label */
  at: Date;
  subjects: number;
  stages: FunnelStageResult[];
}

export interface FunnelResult {
  cohortSubjects: number;
  /** |{ s : stage 1 present }| — the pctOfFirst denominator */
  first: number;
  stages: FunnelStageResult[];
  exits: FunnelExitResult[];
  /** present only when `interval` was asked for; ascending by `at` */
  slices: FunnelSlice[] | null;
  /** the cohort read hit its cap — every number is an UNDERCOUNT */
  truncated: boolean;
  cohort: { from: Date; to: Date; endInclusive: boolean; anchor: string };
  dataSource: 'rollups';
}

/** one subject's assembled milestone index — what summarizeStages reasons over */
export interface CohortSubject {
  ref: string;
  anchorAt: Date | null;
  /** stage key → first occurrence */
  stages: Record<string, Date>;
  exits: Record<string, Date>;
}

/** Mean of the two middles on even counts. Empty set is null, never 0. No rounding. */
export declare function median(values: readonly number[]): number | null;

/** the stage table, pure — same input, same output, no Mongo */
export declare function summarizeStages(
  subjects: readonly CohortSubject[],
  stages: readonly { order: number; key: string; as: string; label: string; description?: string }[],
): FunnelStageResult[];

/** the first declaration of a rollup family — validateRegistry pins the shape, so it speaks for all */
export declare function findFamily(
  registry: Registry,
  as: string,
): { name: string; spec: RollupSpec } | null;

/** throws unless `as` is a LIFETIME family keyed by exactly one subject dim */
export declare function requireMilestoneFamily(
  registry: Registry,
  as: string,
  primitive: string,
): RollupSpec;

/** the six read primitives — everything the UI renders comes through these */
export interface Queries {
  /**
   * `scope` is a tenantId, or PLATFORM_SCOPE ('*') for a cross-tenant read.
   * Under '*' the tenant term is dropped and nothing else changes: the time
   * range is still mandatory, the caps still apply, and every row still carries
   * its own `tenantId`. `series` and `distribution` aggregate ACROSS tenants
   * under '*' — the platform-wide chart, by design.
   */
  records(scope: string, range: TimeRange, filter?: RecordFilter, opts?: { limit?: number; cursor?: string }):
    Promise<{ items: any[]; nextCursor: string | null; dataSource: 'raw' }>;
  series(scope: string, range: TimeRange, filter: RecordFilter, opts?: { measure?: string; interval?: 'hour' | 'day' | 'week' | 'month' }):
    Promise<{ buckets: Array<{ at: Date; value: number }>; dataSource: 'raw' }>;
  /**
   * The sample is complete — nothing is sampled away between the match and the
   * math — but `$percentile` is `method: 'approximate'` and the scan stops at
   * `limits.distribution`. `truncated` says when that ceiling was reached; the
   * percentile keys are absent on an empty match, `truncated` never is.
   */
  distribution(scope: string, range: TimeRange, filter: RecordFilter, opts?: { measure?: string }):
    Promise<Record<string, unknown> & { n: number; truncated: boolean; dataSource: 'raw' }>;
  /**
   * `dims` accepts several values as an `$in` — one read for N subjects instead
   * of N reads. `on` picks the field `range` filters (default: bucketAt when
   * bucketed, lastAt otherwise); cohort selection wants `firstAt`. The range is
   * half-open either way, and `truncated` says when the cap was actually hit.
   */
  rollups(scope: string, params: { as: string; dims?: string | string[]; subjectType?: string; on?: 'firstAt' | 'lastAt' | 'bucketAt'; range?: TimeRange; sort?: 'count' | 'lastAt' | 'firstAt' | 'bucketAt'; limit?: number }):
    Promise<{ rows: any[]; bucketed: boolean; truncated: boolean; dataSource: 'rollups' }>;
  trace(scope: string, traceId: string): Promise<{ items: any[]; dataSource: 'raw' }>;
  journey(scope: string, subjectRef: string, range: TimeRange, opts?: { limit?: number }):
    Promise<{ records: any[]; milestones: any[]; dataSource: 'raw+rollups' }>;
  /**
   * Distinct subjects per bucket and over the range — DAU/MAU, exact, no sketch.
   * A family declared `by: ['subject']` with a bucket already writes one doc per
   * (subject, bucket), so the doc count IS the distinct count.
   *
   * THROWS when the named family has no subject dim or no bucket: that is a
   * registry mistake, and a plausible wrong number is the failure mode this
   * package exists to prevent.
   */
  distinctCount(scope: string, params: { as: string; subjectType?: string; range: TimeRange; interval?: 'hour' | 'day' | 'week' | 'month' }):
    Promise<{ buckets: Array<{ at: Date; value: number }>; distinct: number; interval: 'hour' | 'day' | 'week' | 'month'; truncated: boolean; dataSource: 'rollups' }>;
  /** cohort funnel over lifetime milestone families — counts, conversion, median time-to-step */
  funnel(scope: string, params: FunnelParams): Promise<FunnelResult>;
}

export declare function createQueries(ctx: {
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  registry: Registry;
  limits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  /** threshold onSlowQuery fires above, ms. Default 500. */
  slowMs?: number;
  /** in-process result cache TTL, ms. Default 600_000 — ten minutes. */
  cacheTtlMs?: number;
  /** cached entries kept before the oldest is evicted. Default 60. */
  cacheSize?: number;
}): Queries;

export interface ViewSpec {
  name: string;
  icon?: string;
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview' | 'system';
  query: {
    range?: string;
    filters?: Record<string, unknown>;
    groupBy?: string;
    sort?: string;
    display?: 'table' | 'series' | 'breakdown' | 'stream';
  };
}

export interface ResolvedView extends ViewSpec {
  origin: 'derived' | 'configured' | 'saved';
  id?: string;
  ownerRef?: string;
  shared?: boolean;
}

/** derived views — generated from the registry, zero config */
export declare function deriveViews(registry: Registry): ResolvedView[];

export interface Viewer {
  /**
   * The read scope: a tenantId, or PLATFORM_SCOPE (`'*'`) to read across every
   * tenant — a support console, a platform-wide cost page.
   *
   * Returning `'*'` IS the authorization decision, and it is yours: the package
   * never infers platform admin from a role, a header, or a config flag. It
   * only makes the escape hatch expressible, so a host that needs a
   * cross-tenant read declares it here instead of reaching around `scoped()`
   * with a raw model. `'*'` is reserved on the write side, so no stored row
   * carries it and no tenant can ever be named it.
   *
   * Saved views scope on this string LITERALLY, `'*'` included: a platform
   * viewer's views are invisible to every tenant and vice versa, and neither
   * can delete the other's. `'*'` reads telemetry across tenants; it is not a
   * master key to other people's saved state.
   */
  tenantId: string;
  /** 'admin' unlocks System writes (key revoke) — within this scope */
  role: string;
  /** owns saved views, e.g. 'user:u_1' */
  viewerRef?: string;
}

export interface ViewerAdapter {
  /** INBOUND: who may look, and how widely? Construction fails without this. */
  resolveViewer(req: unknown): Viewer | null | Promise<Viewer | null>;
}

export interface SubjectAdapter {
  /** pretty labels for subject refs; absent refs render raw */
  describe(refs: string[]): Promise<Record<string, { label: string; href?: string }>>;
}

export interface CreateDashboardOptions {
  telemetry: Telemetry<any>;
  viewerAdapter: ViewerAdapter;
  subjectAdapter?: SubjectAdapter;
  /** configured views — versioned in host code */
  views?: ViewSpec[];
  queryLimits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  /** threshold onSlowQuery fires above, ms. Default 500. Forwarded to createQueries. */
  slowMs?: number;
  /** in-process query cache TTL, ms. Default 600_000. Forwarded to createQueries. */
  cacheTtlMs?: number;
  /** cached query results kept before eviction. Default 60. Forwarded to createQueries. */
  cacheSize?: number;
  /** where the browser sees this router mounted — MUST match (traps #8) */
  mountPath?: string;
  apiBase?: string;
  title?: string;
  spaDir?: string;
}

/** /api/* (five primitives, views, system) + the built SPA with hashed assets */
export declare function createDashboard(opts: CreateDashboardOptions): import('express').Router;

/** the bundled SPA directory — resolves dist/ui in builds and source runs */
export declare function defaultSpaDir(): string;
