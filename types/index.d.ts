import type { Aggregate, Collection, Connection, Model, Mongoose, Query } from 'mongoose';
import type { z } from 'zod';

// ── vocabulary ──────────────────────────────────────────────────────────────

export type TelemetryKind = 'event' | 'error' | 'span' | 'state' | 'usage';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type Env = 'prod' | 'staging' | 'dev';
export type Origin = 'server' | 'client';

/** `type:id` — 'user:u_1', 'org:o_9', 'system:cron' */
export type EntityRef = `${string}:${string}`;

export declare const RETENTION_DAYS: Record<TelemetryKind, number | null>;
export declare const SAMPLE_RATE: Record<TelemetryKind, number>;
export declare const SCHEMA_VERSION: number;
export declare const INDEX_BUDGET: number;

/** UUIDv7 — sortable, insertion-local. Never substitute crypto.randomUUID (v4). */
export declare function newId(): string;

/** Consistent per-trace sampling verdict. Throws in dev on an unsampleable traceId. */
export declare function traceKeep(traceId: string | undefined, rate: number): boolean;

/** Deep-converts Mongoose Maps to plain objects — JSON.stringify(Map) is '{}'. */
export declare function plain(v: unknown): unknown;

export declare function truncate(d: Date, bucket?: 'hour' | 'day' | 'week' | 'month'): Date | undefined;

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
  /** `data` is UNSTORED unless declared. Closes the erasure hole. */
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
  platform: 'web' | 'electron' | 'ios' | 'android' | 'server' | 'cli';
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
  /** base collection; siblings derive: `<collection>_rollups`, `_rejects`, `_aliases`, `_checkpoints` */
  collection?: string;
  /** set when two instances share one connection — traps #2 */
  modelName?: string;
  /** secret pepper for forget()'s rekeying. Falls back to TELEMETRY_PEPPER. */
  pepper?: string;
  logger?: Logger;
}

export interface Telemetry<R extends Registry = Registry> {
  /** write — the only write */
  emit<N extends keyof R & string>(name: N, doc: EmitInput<R, N>): Promise<void>;
  /** erasure: delete sole-party rows, redact shared ones, rekey rollups, drop aliases */
  forget(tenantId: string, ref: EntityRef): Promise<ForgetResult>;
  /** tenant scope is not optional — every read goes through here */
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

export type KeyKind = 'publishable' | 'secret';
/** fixed: the key carries tenantId · session: the host resolves it · claimed: the payload asserts it (sk_ only) */
export type TenantMode = 'fixed' | 'session' | 'claimed';

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
