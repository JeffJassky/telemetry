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

/** surfaced via t.counters so drops are never silent */
export interface TelemetryCounters {
  rejected: number;
  defaulted: number;
  sampled: number;
  capped: number;
  rollupSkipped: number;
}

export const newCounters = (): TelemetryCounters => ({
  rejected: 0, defaulted: 0, sampled: 0, capped: 0, rollupSkipped: 0,
});

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
