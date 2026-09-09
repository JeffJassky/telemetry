import { uuidv7 } from 'uuidv7';

/**
 * UUIDv7 — time-ordered, insertion-local. Node's crypto.randomUUID() is v4:
 * random, NOT sortable. Do not substitute it here; _ids double as insertion
 * order and traceIds are sampled on their low 32 bits (schema §2.6).
 */
export const newId = uuidv7;

export const TelemetryKind = {
  Event: 'event',
  Error: 'error',
  Span: 'span',
  State: 'state',
  Usage: 'usage',
} as const;
export type TelemetryKind = (typeof TelemetryKind)[keyof typeof TelemetryKind];

export const TELEMETRY_KINDS: readonly TelemetryKind[] = Object.values(TelemetryKind);

export const LogLevel = {
  Debug: 'debug', Info: 'info', Warn: 'warn', Error: 'error', Fatal: 'fatal',
} as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const Env = { Prod: 'prod', Staging: 'staging', Dev: 'dev' } as const;
export type Env = (typeof Env)[keyof typeof Env];

export const Origin = { Server: 'server', Client: 'client' } as const;
export type Origin = (typeof Origin)[keyof typeof Origin];

export type EntityRef = `${string}:${string}`;

export const UNKNOWN = 'unknown';

/**
 * The platform read scope. A dashboard `Viewer` whose tenantId is `'*'` reads
 * ACROSS tenants — a support console, a platform-wide cost page. The package
 * never decides who is a platform admin; the host's `viewerAdapter` does. All
 * `'*'` buys is that the escape hatch is expressible and inside the boundary
 * instead of a host reaching around `scoped()`.
 *
 * Which is exactly why it is RESERVED on the write side. A tenant literally
 * named `'*'` would silently become a cross-tenant read — privilege escalation
 * via a string — so every path that can mint a tenantId from outside the
 * package refuses it: emit(), forget(), createKey() in fixed mode, and the
 * ingest handler once the tenant has resolved (key / session / claimed alike).
 */
export const PLATFORM_SCOPE = '*';

/** true when a scope is the cross-tenant platform scope rather than a tenant */
export const isPlatformScope = (tenantId: unknown): boolean => tenantId === PLATFORM_SCOPE;

/** one wording for the refusal, so the reservation is named wherever it bites */
export const RESERVED_TENANT_MESSAGE =
  `telemetry: tenantId "${PLATFORM_SCOPE}" is reserved for the dashboard's cross-tenant ` +
  'platform scope and may never be written';

/** null = never expires. Sized for small-SaaS volume; per-name override in EventSpec. */
export const RETENTION_DAYS: Record<TelemetryKind, number | null> = {
  // keep-all + 90d is cheap at this scale, and it makes p95-by-route a raw
  // query instead of a rollup design (schema §2.1)
  [TelemetryKind.Span]: 90,
  [TelemetryKind.Error]: 90,
  [TelemetryKind.Event]: 730,
  [TelemetryKind.State]: 730,
  [TelemetryKind.Usage]: null, // money is immortal
};

/**
 * Keep-all across the board — small-SaaS scale, exactness beats extrapolation.
 * The per-trace machinery stays, dormant: turn a kind down here (or one name
 * via EventSpec.sampleRate) when volume ever demands it. Rollups are exact
 * either way — they run before the verdict (schema §4.6).
 */
export const SAMPLE_RATE: Record<TelemetryKind, number> = {
  [TelemetryKind.Span]: 1,
  [TelemetryKind.Event]: 1,
  [TelemetryKind.Error]: 1, // raw storage burst-capped per fingerprint instead
  [TelemetryKind.State]: 1,
  [TelemetryKind.Usage]: 1, // NEVER sample. money.
};

export const REJECT_TTL_DAYS = 30;
export const SCHEMA_VERSION = 2;

/**
 * `body` is the only unbounded field on the envelope, and it feeds Mongo's
 * 16 MB document ceiling. Every other bound in the package is stated and
 * enforced (boundedMeta 4 KB, batch 512 KB / 100 records, index budget 24), so
 * this one is too. Override per instance with CreateTelemetryConfig.bodyMax.
 */
export const BODY_MAX_CHARS = 16_384;

/** surfaced via t.counters so drops are never silent */
export interface TelemetryCounters {
  rejected: number;
  defaulted: number;
  sampled: number;
  capped: number;
  rollupSkipped: number;
  /** an insert-gated write whose dedupeKey (or usage.idempotencyKey) already existed */
  deduped: number;
  /** a `body` clipped to bodyMax — the row survives, marked */
  truncated: number;
  /**
   * `rollupSkipped`, attributed: `${family}|${dimLabel}` → count. Which family
   * dropped which dim — the difference between "12 records went missing" and
   * "`screens_viewed` has no `dimDefault` for `name`", which is a registry line
   * you can go and write. The scalar above is unchanged and still counts every
   * skip; this is additive.
   */
  rollupSkippedBy: Record<string, number>;
  /**
   * attrs keys seen on a record that its spec does not declare:
   * `${name}|${key}` → count. Under the default `validation: 'lenient'` those
   * keys are STRIPPED and the record is written (see attrsDropped below);
   * under `'strict'` the record is rejected. Either way this is the map that
   * names the registry line you are missing — suggest.ts turns it into zod.
   */
  undeclaredAttrs: Record<string, number>;
  /**
   * `${name}|${key}` → count: an attr REMOVED so the record could still be
   * written, under `validation: 'lenient'`. Two causes, one number, because
   * the fix is the same registry line either way: the key is undeclared, or
   * its value fell outside the declared schema (a client shipped a sixth
   * enum member the registry still lists five of).
   *
   * `${name}|(missing)` means stripping could not rescue the object — a
   * REQUIRED attr was absent — and the record was written without it anyway.
   * That one is an emitter bug, not registry drift.
   *
   * A non-zero value here is not an incident: it is the vocabulary drifting,
   * visible, while the events keep landing. Zero under `'strict'`.
   */
  attrsDropped: Record<string, number>;
  /** metrics keys removed for the same reasons — see attrsDropped. */
  metricsDropped: Record<string, number>;
  /**
   * Write-time subject linking (createSubjectLinking() in emit.ts). All six are
   * zero for a host with no `subjectLinker`, and they exist because linking is
   * the one part of the write path that runs HOST code: every way it can fail
   * ends in a record written unlinked, and a silently unlinked record is
   * indistinguishable from one nobody could link. The split says which.
   */
  /** subjects actually ADDED to records — two links on one record count twice */
  subjectsLinked: number;
  /** records where the linker answered `[]` — no link exists, which is an answer */
  subjectLinkMisses: number;
  /** the linker threw, rejected, or returned something that is not a list of refs */
  subjectLinkErrors: number;
  /** the linker outran subjectLinkTimeoutMs and the record was written unlinked */
  subjectLinkTimeouts: number;
  /** a linked subject whose `type` the event's EventSpec.subjects does not declare */
  subjectLinkUndeclared: number;
  /** a linked subject dropped because the record already held SUBJECT_MAX of them */
  subjectLinkCapped: number;
}

export const newCounters = (): TelemetryCounters => ({
  rejected: 0, defaulted: 0, sampled: 0, capped: 0, rollupSkipped: 0,
  deduped: 0, truncated: 0, rollupSkippedBy: {}, undeclaredAttrs: {},
  attrsDropped: {}, metricsDropped: {},
  subjectsLinked: 0, subjectLinkMisses: 0, subjectLinkErrors: 0,
  subjectLinkTimeouts: 0, subjectLinkUndeclared: 0, subjectLinkCapped: 0,
});

/**
 * Distinct keys either attributed counter map will hold. Both are keyed on
 * data a CLIENT controls — an event name, an attr key — so an unbounded map is
 * a way to grow this process's heap from the outside. Past the cap every new
 * key folds into one `(other)` bucket: the total stays honest, only the
 * attribution stops. A host seeing `(other)` climbing has either a hostile
 * client or a registry that is very far behind.
 */
/**
 * What a record does when its attrs or metrics do not match the registry.
 *
 * `'lenient'` (the default): strip the offending keys, count them, and WRITE
 * the record. `'strict'`: reject the whole record into the quarantine.
 *
 * The default is lenient because the strict failure mode is the expensive one
 * and it is silent. A registry is a vocabulary maintained in one repo about
 * events emitted from another; the day a client ships a sixth value for a
 * five-value enum, strict mode throws away the WHOLE record — its name, its
 * subject, its metrics, its place in a funnel — to punish one attr. And it
 * does so behind a 202, so nothing surfaces at the emitter. Losing
 * `export.completed` because `outputs` gained an option is not validation
 * working; it is a schema mismatch deleting the evidence a product decision
 * would have been made from.
 *
 * What strictness legitimately protects is unchanged: `data` is still parsed
 * strictly (it is the one free-text corner, so it is a privacy boundary, not a
 * vocabulary one), a missing REQUIRED SUBJECT is still a hard reject (that is
 * structural, not drift), and rollup dimension cardinality is still bounded —
 * a stripped attr simply resolves to the family's `dimDefault`.
 */
export type ValidationPolicy = 'lenient' | 'strict';

export const COUNTER_MAP_MAX = 1000;

/** the fold-here bucket, shaped like a real key so readers can split it the same way */
export const COUNTER_OVERFLOW_KEY = '(other)|(other)';

/** `map[key]++`, bounded. Names no registry entry once it folds — see COUNTER_MAP_MAX. */
export const bumpCounterMap = (map: Record<string, number>, key: string): void => {
  const seen = map[key];
  if (seen !== undefined) {
    map[key] = seen + 1;
    return;
  }
  // The size check is O(n) and runs only on a key never seen before; once the
  // overflow bucket exists the map is known full, so it short-circuits and a
  // storm of distinct keys stays O(1) per record.
  if (map[COUNTER_OVERFLOW_KEY] !== undefined || Object.keys(map).length >= COUNTER_MAP_MAX) {
    map[COUNTER_OVERFLOW_KEY] = (map[COUNTER_OVERFLOW_KEY] ?? 0) + 1;
    return;
  }
  map[key] = 1;
};

/**
 * Consistent probability sampling — deterministic per trace, no propagation
 * needed. A traceId with no parseable hex tail silently degrades to per-record
 * sampling, which invalidates every per-trace aggregate (schema §2.6). That is
 * a bug in the caller's id generation, so it fails loudly in dev rather than
 * skewing data in prod.
 */
export const traceKeep = (traceId: string | undefined, rate: number): boolean => {
  if (rate >= 1) return true;
  if (!traceId) return Math.random() < rate;
  const tail = parseInt(traceId.slice(-8), 16);
  if (!Number.isFinite(tail)) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        `telemetry: traceId "${traceId}" has no parseable hex tail — trace-consistent ` +
        `sampling is impossible and would degrade to per-record. Use UUIDv7 or a ` +
        `32-hex OTel trace id.`,
      );
    }
    return Math.random() < rate;
  }
  return tail / 0xffffffff < rate;
};

/** Map has no toJSON — JSON.stringify(new Map()) is '{}'. Never stringify raw. */
export const plain = (v: unknown): unknown =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
  : Array.isArray(v) ? v.map(plain)
  : v instanceof Date ? v
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const noopLogger: Logger = { info() {}, warn() {}, error() {} };
