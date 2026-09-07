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

// ── catalog (reports §3) ────────────────────────────────────────────────────

/**
 * Everything a reader can ask this instance, inferred from the registry alone:
 * typed dimensions with their value domains, the measures each event supports,
 * and which rollup family answers a sum exactly. Pure and boot-time, like
 * validateRegistry — createDashboard() and createTelemetryMcp() build one each
 * and serve it beside the projection.
 */
export interface Catalog {
  events: Record<string, EventFacet>;
  families: Record<string, FamilyFacet>;
  /** name prefix before the first '.' → event names. An undotted name namespaces to itself. */
  namespaces: Record<string, string[]>;
  /** dims every record carries — filterable and groupable raw, whatever the source */
  envelope: DimFacet[];
  /** every subject type named by any spec's `subjects` or any rollup's `subjects` */
  subjectTypes: string[];
}

export interface EventFacet {
  kind: TelemetryKind;
  origin: Origin | 'any';
  subjects: string[];
  description: string;
  namespace: string;
  /** one per declared attr, typed, followed by this kind's own envelope fields */
  dims: DimFacet[];
  /** 'count' first, then per metric key: sum:, avg:, p50:, p95:, p99: */
  measures: MeasureFacet[];
  /** rollup family names this event feeds (its `as`, or its own name) */
  families: string[];
  indexedAttrs: string[];
  indexedMetrics: string[];
  /** the EFFECTIVE retention — the spec's override, else RETENTION_DAYS[kind] */
  retentionDays: number | null;
}

export interface FamilyFacet {
  as: string;
  /** the grain, in declared order (pinned per family by validateRegistry) */
  by: DimSource[];
  /** rollups.ts `label(src)` per dim — the `x=` prefix written into `dims` */
  labels: string[];
  bucket: 'hour' | 'day' | 'week' | 'month' | null;
  /** a lifetime rollup has no bucket, and its `firstAt` IS the milestone */
  lifetime: boolean;
  /** the spec's `subjects` when `by` has a subject dim, else [] */
  subjectTypes: string[];
  sums: string[];
  /** labels of `capture` sources */
  capture: string[];
  /** event names declaring this family, registry order */
  feeders: string[];
  retentionDays: number | null;
}

export interface DimFacet {
  /**
   * The DimSource form, so it passes straight through to a rollup `by`, to a
   * groupBy, and to a filter term: 'attr:model' | 'field:client.platform' |
   * 'subjectType' | 'actorType'.
   */
  key: string;
  /** what rollups.ts writes before '=' — 'model', 'client.platform'; for the two pseudo-dims, the key */
  label: string;
  type: 'string' | 'enum' | 'number' | 'boolean' | 'date';
  /** closed domain when known: z.enum / z.literal values, envelope enums */
  values?: string[];
  optional: boolean;
  /** true when a real index exists — an `indexedAttrs` attr, or a base-indexed envelope field */
  indexed: boolean;
}

export interface MeasureFacet {
  /** 'count' | 'sum:cost_usd' | 'avg:cost_usd' | 'p95:duration_ms' … */
  key: string;
  metric?: string;
  /** families whose `sum` carries this metric — exact answers. Only 'sum:' keys ever have one. */
  exactVia: string[];
}

export interface DeriveCatalogOptions {
  /** host additions to `client.platform`, exactly as CreateTelemetryConfig.platforms extends them */
  platforms?: readonly string[];
}

/** the projection `/api/registry` and `describe_telemetry` have always returned */
export interface RegistryProjectionEntry {
  kind: TelemetryKind;
  origin: Origin | 'any';
  subjects: string[];
  description: string;
  attrKeys: string[];
  metricKeys: string[];
  indexedAttrs: string[];
  indexedMetrics: string[];
  rollups: {
    as: string;
    by: DimSource[];
    bucket: 'hour' | 'day' | 'week' | 'month' | null;
    sum: string[];
    subjects: string[];
  }[];
}
export type RegistryProjection = Record<string, RegistryProjectionEntry>;

/** Pure. No Mongo, no I/O — derive once at boot and cache it on the instance. */
export declare function deriveCatalog(registry: Registry, opts?: DeriveCatalogOptions): Catalog;

/** the catalog narrowed back to the projection, so adding it costs the SPA nothing */
export declare function projectRegistry(catalog: Catalog): RegistryProjection;

// ── suggestions (reports §9) ────────────────────────────────────────────────

/**
 * One registry edit the data is asking for. `message` is the sentence a human
 * reads; `fix` is the line they paste. Nothing here writes anything — the host
 * still edits the registry by hand, the package just stops making it guess.
 */
export interface Suggestion {
  kind: 'undeclared_attr' | 'missing_dim_default' | 'unregistered_event';
  /** the registry entry to touch — an event name, or a rollup family name */
  target: string;
  /** attr key or dim label, when the suggestion is about one */
  key?: string;
  count: number;
  message: string;
  /** the registry change, as code */
  fix: string;
}

export interface DeriveSuggestionsInput {
  counters: TelemetryCounters;
  catalog: Catalog;
  /** the quarantine rows the caller already fetched — only `name` and `reason` are read */
  quarantine?: readonly { name?: unknown; reason?: unknown; [k: string]: unknown }[];
}

/**
 * Pure, like deriveCatalog: counters + catalog + quarantine in, registry lines
 * out. Served on `GET /api/system` and by the `telemetry_health` MCP tool.
 */
export declare function deriveSuggestions(input: DeriveSuggestionsInput): Suggestion[];

/** the returned list is capped here — a System page is a thing a human reads */
export declare const MAX_SUGGESTIONS: 50;

// ── reports (reports §4, §6) ────────────────────────────────────────────────

/**
 * A Report is one shape: what a page renders, what a saved view stores, what a
 * URL hash carries, and what `run_report` executes. `resolveReport` turns one
 * into a Plan — the cheapest primitive that answers it exactly, a raw plan when
 * nothing can, and a refusal with a reason when nothing at all can.
 */
export type ReportSource =
  | { event: string }
  | { namespace: string }
  | { kind: TelemetryKind }
  | { family: string };

/** a shorthand from the UI's RANGES ('7d'), or an explicit half-open ISO pair */
export type ReportRange = string | { from: string; to: string };

export interface ReportFilter {
  /** a DimFacet.key: 'attr:model' | 'field:env' | 'subjectType' | 'field:name' … */
  dim: string;
  op: 'eq' | 'in' | 'gte' | 'lte';
  value: string | string[] | number;
}

export interface Report {
  source: ReportSource;
  range: ReportRange;
  interval?: 'hour' | 'day' | 'week' | 'month';
  /** a MeasureFacet.key. Default 'count'; also 'distinct:<subjectType>' and 'funnel' */
  measure?: string;
  /** DimFacet.key[], at most two */
  groupBy?: string[];
  filters?: ReportFilter[];
  excludeActorTypes?: string[];
  /** a rendering hint carried with the Report; no primitive takes it today */
  sort?: 'value' | 'label' | 'time';
  limit?: number;
  /** same length, immediately before */
  compare?: 'previous';

  // ── funnel-only (`measure: 'funnel'`) ──
  stages?: string[];
  anchor?: string;
  exits?: string[];
  subjectType?: string;
}

/**
 * The pre-Report `ViewSpec.query`, still parsed and lifted by normalizeQuery().
 * Its `display` key is removed — the renderer decides from the Report itself
 * (reports §8) — and a stored view still carrying one keeps parsing.
 * @deprecated write a Report.
 */
export interface LegacyQuery {
  range?: string;
  filters?: Record<string, unknown>;
  groupBy?: string;
  sort?: string;
}

export type PlanPrimitive =
  | 'records' | 'series' | 'breakdown' | 'distribution'
  | 'rollups' | 'distinctCount' | 'funnel';

/**
 * How the executor folds a `rollups` plan: `rollups()` has no server-side
 * groupBy, and the requested dims ARE the family's dims, so the grouping is a
 * fold over the returned rows. `labels[i]` is the `dims` prefix rollups.ts
 * writes for `groupBy[i]`; a subject dim labels to 'subject' and its stored
 * value is the bare `type:id` ref.
 */
export interface PlanShape {
  groupBy: string[];
  labels: string[];
  measure: string;
  interval?: 'hour' | 'day' | 'week' | 'month';
  filters?: { dim: string; label: string; op: ReportFilter['op']; value: ReportFilter['value'] }[];
}

export interface Plan {
  primitive: PlanPrimitive;
  /** positional args AFTER scope — the executor is literally `q[primitive](scope, ...args)` */
  args: unknown[];
  exactness: 'exact' | 'raw' | 'scan';
  /** the family that answers it, when one does */
  via?: string;
  /** human sentence — the UI badge and the MCP explanation */
  why: string;
  /** how to fold the rows a `rollups` plan returns */
  shape?: PlanShape;
  /** present when `compare: 'previous'` — same primitive, range shifted back by its own length */
  previous?: { args: unknown[] };
}

export interface Unavailable {
  unavailable: true;
  why: string;
}

export interface ResolveOptions {
  /** injected so a plan is deterministic — shorthand ranges end here */
  now?: Date;
  limits?: Partial<QueryLimits>;
}

/**
 * Report → Plan, pure. No Mongo, no I/O, deterministic given `now` — pinned by
 * unit tests like deriveCatalog and summarizeStages.
 */
export declare function resolveReport(
  report: Report,
  catalog: Catalog,
  opts?: ResolveOptions,
): Plan | Unavailable;

/** lift a stored view's legacy query onto a Report. null when nothing names a source. */
export declare function normalizeQuery(query: Report | LegacyQuery | null | undefined): Report | null;

/**
 * A Report is a URL, and these two are inverses: `parseReportQuery(reportToQuery(r))`
 * deep-equals `r`. `source=event:<name>|namespace:<ns>|kind:<kind>|family:<as>`,
 * `range=7d` or `from`+`to`, `groupBy` and `excludeActors` comma-separated, and
 * `filter=<dim>:<op>:<value>` REPEATED — the dim may itself contain a colon, so
 * the first `eq`/`in`/`gte`/`lte` token ends it. Unknown params are ignored; a
 * malformed one throws with `status: 400` naming the param.
 */
export declare function parseReportQuery(query: Record<string, unknown>): Report;
export declare function reportToQuery(report: Report): Record<string, string | string[]>;

// ── the executor ────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  /** injected so a plan is deterministic — shorthand ranges end here */
  now?: Date;
  limits?: Partial<QueryLimits>;
  /** applied to a `records` plan's items before they leave (mcp.ts passes its redactor) */
  redact?: (items: any[]) => any[];
}

export interface ReportResult {
  /** the Report as executed — after a legacy lift, so the caller sees what ran */
  report: Report;
  plan: Plan;
  /** the primitive's own result, EXCEPT a `rollups` plan, which arrives folded */
  result: unknown;
  /** present when `compare: 'previous'` — the same call, range shifted back */
  previous?: unknown;
  dataSource: 'raw' | 'rollups' | 'raw+rollups';
}

/** the fields the fold reads off a rollup doc */
export interface RollupDoc {
  /** dimension values in the family's `by` order: 'region=eu', or a bare 'user:u_1' */
  dims: string[];
  bucketAt?: Date | string | null;
  count?: number;
  sums?: Record<string, number> | Map<string, number> | null;
}

/** what `breakdown()` returns, answered from the rollup store instead */
export interface FoldedRollups {
  rows: Array<{ dims: (string | null)[]; at?: Date; value: number }>;
  groups: number;
  truncated: boolean;
  dataSource: 'rollups';
}

/**
 * Report → the answer: resolve, then `q[plan.primitive](scope, ...plan.args)`.
 * An `Unavailable` throws with `status: 400` and the `why` as its message —
 * a refusal is an answer to `resolveReport`, but not to someone asking for data.
 */
export declare function executeReport(
  q: Queries,
  scope: string,
  report: Report,
  catalog: Catalog,
  opts?: ExecuteOptions,
): Promise<ReportResult>;

/**
 * Fold a `rollups` plan's docs into the row shape `breakdown()` returns, per
 * `Plan.shape` — the family's docs ARE the groups, so this is arithmetic rather
 * than a second read, and a renderer never learns which store answered. Pure.
 */
export declare function foldRollups(
  rows: readonly RollupDoc[],
  shape: PlanShape,
  truncated?: boolean,
): FoldedRollups;

/** '7d' → a half-open pair ending at `now`; an ISO pair validated. Throws `status: 400`. */
export declare function rangeOf(range: ReportRange, now?: Date): TimeRange;

/** the interval that keeps a range under ~120 buckets — util.js `intervalFor`, for pairs too */
export declare function intervalForRange(range: ReportRange, now?: Date): 'hour' | 'day' | 'week' | 'month';

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
  /**
   * `rollupSkipped`, attributed: `${family}|${dimLabel}` → count. Which family
   * dropped which dim, so the scalar becomes a `dimDefault` you can go and
   * declare. The seven numbers above are unchanged — this is additive.
   */
  rollupSkippedBy: Record<string, number>;
  /**
   * attrs keys a record carried that its spec does not declare:
   * `${name}|${key}` → count. Those records are REJECTED by the strict parse,
   * not stripped; this groups what the quarantine lists one row at a time.
   */
  undeclaredAttrs: Record<string, number>;
  /**
   * Write-time subject linking. All six stay at zero without a
   * `subjectLinker`. They are split six ways because every way linking can fail
   * ends in the same row — one written with the subjects it arrived with — and
   * a silently unlinked record is indistinguishable from one nobody could link.
   */
  /** subjects actually ADDED to records — two links on one record count twice */
  subjectsLinked: number;
  /** records where the linker answered `[]` — no link exists, which is an answer */
  subjectLinkMisses: number;
  /** the linker threw, rejected, or returned something that is not a list of refs */
  subjectLinkErrors: number;
  /** the linker outran `subjectLinkTimeoutMs`; the record was written unlinked */
  subjectLinkTimeouts: number;
  /** a linked subject whose `type` the event's `EventSpec.subjects` does not declare */
  subjectLinkUndeclared: number;
  /** a linked subject dropped because the record already held `SUBJECT_MAX` of them */
  subjectLinkCapped: number;
}

/**
 * Distinct keys either attributed map holds before new ones fold into a single
 * `(other)` bucket. Both are keyed on client-controlled data, so the bound is
 * what stops a hostile client growing the process heap; the totals stay
 * honest, only the attribution stops.
 */
export declare const COUNTER_MAP_MAX: 1000;
export declare const COUNTER_OVERFLOW_KEY: '(other)|(other)';

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

export interface RelinkOptions {
  /**
   * Restrict to these event names. Default: every stored record, whatever its
   * name. A name the registry does not declare THROWS, before any I/O — a typo
   * that silently relinks nothing looks exactly like a clean run.
   */
  names?: string[];
  /** only records at/after this instant (`occurredAt`) */
  since?: Date;
  /**
   * Stop after this many records are EXAMINED — not linked. A budget for the
   * scan, so a huge collection can be probed cheaply. Default unbounded.
   */
  limit?: number;
  /**
   * Report what would change and write NOTHING. **Defaults to `true`**, because
   * this rewrites historical aggregates and the short call has to be the safe
   * one. A dry run still asks the host's linker, so the linking counters move;
   * nothing on disk does.
   */
  dryRun?: boolean;
  /** records fetched per batch, and the `onProgress` cadence. Default 500. */
  batchSize?: number;
  /** cumulative counts after each batch, for progress output. Guarded: a
   *  printer that throws does not kill the backfill. */
  onProgress?: (r: RelinkResult) => void;
}

export interface RelinkResult {
  /** rows read */
  examined: number;
  /** rows that gained at least one subject */
  linked: number;
  /** subjects added in total — two links on one row count twice */
  subjects: number;
  /** rollup documents written, or under `dryRun` that would have been */
  rollups: number;
  /** rows where the linker answered `[]`. On a backfill this is the expected
   *  answer for most rows, and it is not a failure. */
  misses: number;
  /** rows where the linker threw, rejected, timed out or answered garbage —
   *  once per ROW however many ways it went wrong. `counters.subjectLinkErrors`
   *  and `subjectLinkTimeouts` keep the finer split. */
  errors: number;
  /** rows the run declined to offer the linker (a stored name the registry no
   *  longer declares, so its rollup families are unknowable), plus one standing
   *  for a call with no `subjectLinker` configured, which reads nothing. */
  skipped: number;
}

/** records fetched per batch by `relink()`, and how often `onProgress` fires */
export declare const RELINK_BATCH_SIZE: 500;

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
  /**
   * Attach additional subjects to a record AT WRITE TIME — the desktop
   * `machine:<installId>` the host can resolve to a `user`, joined once, onto
   * the row and its rollups, rather than at every read that ever wants it.
   * Must be cached: it runs once per record on the ingest path.
   */
  subjectLinker?: SubjectLinker;
  /**
   * What `subjectLinker.link()` gets per record before the write proceeds
   * UNLINKED and counts a timeout. Default 50.
   */
  subjectLinkTimeoutMs?: number;
  logger?: Logger;
}

/**
 * WRITE-time subject linking — distinct from `SubjectAdapter`, which labels
 * refs at read time and changes nothing about what is stored.
 *
 * A desktop client knows its install and nothing else, so its records carry
 * `machine:<installId>` and no `user`. Resolving that at read time leaves a
 * cohort funnel anchored on `user` reading zero for every desktop stage;
 * resolving it at write time puts the party on the row AND on its rollups,
 * which is the half a read-time join can never reach.
 */
export interface SubjectLinker {
  /**
   * Additional subjects for a record being written. `[]` when nothing links —
   * that is an answer, and it is counted as one.
   *
   * Runs once per record on the write path, so it must answer from a cache.
   * The package bounds it rather than trusting it: past `subjectLinkTimeoutMs`,
   * or on a throw, the record is written unlinked and counted. A linked subject
   * whose `type` the event does not declare is written ANYWAY and counted in
   * `counters.subjectLinkUndeclared` — refusing it could only ever be obeyed by
   * losing rows, because `EventSpec.subjects` is a required list.
   */
  link(
    subjects: SubjectInput[],
    ctx: { name: string; tenantId: string },
  ): SubjectInput[] | Promise<SubjectInput[]>;
}

/**
 * The guarded linker the instance resolved at construction: the merged subjects
 * to write, or `null` when nothing changed. Exposed as `t.linkSubjects` for the
 * router factories, which reach it the way they reach the registry.
 */
export type LinkSubjects = (
  name: string,
  spec: { subjects: readonly string[] },
  tenantId: string,
  declared: unknown,
) => Promise<SubjectInput[] | null>;

/**
 * Total subjects one record may carry once linking has run. `subjectKeys` is a
 * multikey index term and every subject fans a `by:['subject']` rollup out one
 * more time, so an unbounded array is unbounded write amplification with a
 * host's cache bug behind it. Overflow is dropped and counted in
 * `counters.subjectLinkCapped`.
 */
export declare const SUBJECT_MAX: 8;

/** default `subjectLinkTimeoutMs` — past it the record is written unlinked */
export declare const SUBJECT_LINK_TIMEOUT_MS: 50;

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
   * Backfill for `subjectLinker`: re-ask it about records ALREADY on disk, and
   * replay the rollups the new subjects reach.
   *
   * Linking happens at write time, so configuring the hook fixes the future and
   * nothing else — a lifetime `by:['subject']` family is keyed on the subject
   * the record was written with, permanently, and no read-time join can reach
   * back into it. A host that adopts linking on a Tuesday therefore has a
   * backlog whose rows carry only `machine:<installId>` and whose user-keyed
   * families have no member for any of them. This is how it catches up.
   *
   * **Dry run by default.** It rewrites historical aggregates, so `t.relink()`
   * reports and `t.relink({ dryRun: false })` writes. Idempotent by
   * construction: a row that already carries the linked subject yields nothing
   * new, so a second run writes nothing and replays nothing. Returns
   * `{ skipped: 1 }` rather than throwing when no `subjectLinker` is
   * configured.
   */
  relink(opts?: RelinkOptions): Promise<RelinkResult>;
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
  /**
   * Write-time subject linking, guarded and resolved once at construction;
   * `null` without a `subjectLinker`. Exposed for the router factories: the
   * wire path does not go through `emit()` — at-least-once delivery inverts the
   * plane order — so `createIngest` reaches the one implementation here rather
   * than growing a second copy of the rules.
   */
  linkSubjects: LinkSubjects | null;
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

/**
 * Two kinds of cap, and the word "limit" hides the difference. An OUTPUT cap
 * bounds what the response CONTAINS — its `$limit` sits after the `$group`/sort
 * or rides an indexed cursor, so the work behind it is bounded by the range and
 * the indexes, not by the number. A SCAN cap bounds what the primitive READS,
 * so an answer past it is an undercount — which is why all three report
 * `truncated`.
 */
export interface QueryLimits {
  // ── output caps ──
  records: number;
  series: number;
  rollups: number;
  trace: number;
  journey: number;
  /**
   * Distinct GROUPS one breakdown() returns — the top N by measure, read as
   * cap+1 so truncation is observed. Never a bound on rows scanned.
   */
  breakdown: number;
  /**
   * Distinct VALUES one values() lookup returns — the top N by count, read as
   * cap+1 so truncation is observed. Never a bound on rows scanned.
   */
  values: number;

  // ── scan caps ──
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
  /** one event name, or a SET of them as an `$in` — a namespace or a family is several */
  name?: string | string[];
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
   * Top groups of a measure by one or two dimensions. `groupBy` takes
   * `attr:<key>`, `field:<path>` (an allowlist of envelope paths), `subjectType`
   * or `actorType`; 0 or 3+ dims, an unlisted path, or a bad interval throw with
   * `status: 400`. Rows carry `at` only when an `interval` is given.
   *
   * `limit` caps the GROUPS returned, never the rows scanned — the scan is
   * bounded by the range and the indexes exactly as `series` is, and truncation
   * keeps the TOP groups by measure. A record missing the dim groups under
   * `null` rather than being dropped. Aggregates across tenants under `'*'`.
   *
   * Two truncation flags, because they cut different axes: `truncated` means
   * groups were dropped, `bucketsTruncated` that the per-interval pass hit its
   * own ceiling (`limits.series` buckets per returned group) and some group
   * shown is missing periods. `bucketsTruncated` is always false with no
   * `interval`.
   *
   * `sum:durationMs` / `avg:durationMs` read the ENVELOPE field, not
   * `metrics.durationMs` — a span's duration is not a declared metric.
   */
  breakdown(scope: string, range: TimeRange, filter: RecordFilter, opts: { groupBy: string[]; measure?: string; interval?: 'hour' | 'day' | 'week' | 'month'; limit?: number }):
    Promise<{ rows: Array<{ dims: (string | null)[]; at?: Date; value: number }>; groups: number; truncated: boolean; bucketsTruncated: boolean; dataSource: 'raw' }>;
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

// ── values (reports §5) ─────────────────────────────────────────────────────

/**
 * The observed domain of one dimension — the lookup a report builder makes
 * before it names a value. NOT a tenth primitive: it reads the catalog, which
 * the primitives deliberately do not, and it answers from whichever of four
 * sources is cheapest.
 */
export interface ValuesParams {
  /**
   * A `DimFacet.key` — `attr:model`, `field:client.platform`, `subjectType`,
   * `actorType`. The literal `'subject'` also works and is the only way to ask
   * a family for its subject refs.
   */
  dim: string;
  /** the Report's source events: decides the raw step, narrows the other two */
  names?: string[];
  /** required by the raw step; ignored by the others */
  range?: TimeRange;
  /** values cap, default `limits.values` (200), clamped to it */
  limit?: number;
}

export interface ValuesResult {
  /** catalog order for a declared enum, else by count desc then value asc */
  values: string[];
  /** parallel to `values` when the source can count — absent for 'catalog' */
  counts?: number[];
  /**
   * Which of the four answered, in preference order: `catalog` (a declared
   * enum — no read at all), `rollups` (one indexed `$group` over a family keyed
   * by the dim), `raw` (an indexed attr or envelope dim over the range), or
   * `none`. `none` is an ANSWER, never an error: the caller offers free-text
   * equality with a scan badge.
   */
  source: 'catalog' | 'rollups' | 'raw' | 'none';
  /** the family read, when `source === 'rollups'` */
  via?: string;
  /** more values existed than the cap; the ones kept are the top by count */
  truncated: boolean;
  dataSource: 'catalog' | 'rollups' | 'raw' | 'none';
}

export interface ValuesCtx {
  catalog: Catalog;
  TelemetryModel: Model<any>;
  RollupModel: Model<any>;
  limits?: Partial<QueryLimits>;
  onSlowQuery?: (info: { op: string; ms: number; params: unknown }) => void;
  slowMs?: number;
  cacheTtlMs?: number;
  cacheSize?: number;
}

export type Values = (scope: string, params: ValuesParams) => Promise<ValuesResult>;

/** memoized like `series`; never throws on the `none` path */
export declare function createValues(ctx: ValuesCtx): Values;

export interface ViewSpec {
  name: string;
  icon?: string;
  page: 'errors' | 'traces' | 'events' | 'journeys' | 'usage' | 'overview' | 'system' | 'explore';
  /**
   * A Report — or the pre-Report shape, which every stored view still carries
   * and `normalizeQuery()` lifts. `spec` is a Mixed document, so nothing has to
   * migrate: a query with no `source` is read as legacy.
   */
  query: Report | LegacyQuery;
}

export interface ResolvedView extends ViewSpec {
  origin: 'derived' | 'configured' | 'saved';
  id?: string;
  ownerRef?: string;
  shared?: boolean;
}

/**
 * Derived views — generated from the registry, zero config. Five shapes, every
 * one a Report: per event, per rollup family, per namespace, per usage event
 * that meters money, and one funnel per subject type. Pass the boot-time
 * catalog to skip re-deriving one.
 */
export declare function deriveViews(registry: Registry, catalog?: Catalog): ResolvedView[];

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
