import type { AttrsOf, MetricsOf, Registry } from './index.js';

export type { AttrsOf, MetricsOf, Registry, EventSpec, RollupSpec, DimSource } from './index.js';
export { defineRegistry, boundedMeta } from './index.js';

/** client-side UUIDv7 — record `_id`s and trace ids (the idempotency contract) */
export declare function newId(): string;

export interface ClientContextInput {
  platform?: string;
  appVersion?: string;
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
}

export interface TransportResult {
  ok: boolean;
  status?: number;
}
export type Transport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<TransportResult>;

export interface ClientStorage {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

export interface WireRecord {
  _id: string;
  name: string;
  occurredAt: string;
  attrs?: Record<string, string>;
  metrics?: Record<string, number>;
  data?: Record<string, unknown>;
  body?: string;
  severity?: string;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  actor?: string;
  traceId?: string;
  spanId?: string;
  parentId?: string;
  durationMs?: number;
  error?: unknown;
  state?: unknown;
  usage?: unknown;
  anonRef?: string;
  userRef?: string;
}

export interface CreateClientOptions {
  /** pk_ for anything shipped to users; sk_ only in trusted processes */
  key: string;
  /** the mounted ingest endpoint */
  url: string;
  /** injected at build; the key supplies service/env */
  release?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** ring buffer cap — drop-oldest beyond it */
  maxQueueSize?: number;
  maxRetries?: number;
  transport?: Transport;
  storage?: ClientStorage;
  clientContext?: ClientContextInput;
  /** false = drop instead of send. Web adapter wires DNT/GPC here. */
  consent?: () => boolean;
  /** registry name used by captureError. Convention: 'error.unhandled'. */
  errorName?: string;
  /**
   * Last gate before a record joins the queue — every kind passes through it.
   * Return the record to keep it, a modified copy to redact it, `null` to drop
   * it. A throwing hook drops the record and reports via `onError`.
   */
  beforeSend?: (rec: WireRecord) => WireRecord | null | undefined | void;
  onError?: (e: unknown) => void;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  end(extra?: { attrs?: Record<string, string>; metrics?: Record<string, number> }): void;
}

export interface TrackOptions<A, M> {
  attrs?: A;
  metrics?: M;
  data?: Record<string, unknown>;
  occurredAt?: Date;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  severity?: string;
}

export interface TelemetryClient<R extends Registry = Registry> {
  /** typed against the host registry when created as createClient<typeof REGISTRY> */
  track<N extends keyof R & string>(name: N, opts?: TrackOptions<AttrsOf<R, N>, MetricsOf<R, N>>): void;
  captureError(err: unknown, ctx?: { handled?: boolean; name?: string; attrs?: Record<string, string> }): void;
  startSpan(name: string, opts?: { attrs?: Record<string, string> }): Span;
  state(name: string, st: { key: string; from?: string; to: string; previousSinceMs?: number }): void;
  /** swap subjects and post the $identify alias record (anon → user) */
  identify(ids: Record<string, string | null | undefined>): void;
  setActor(ref: string | undefined): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * INTERNAL — not a public contract. The platform adapters (`/web`,
   * `/electron`, `/cli`) reach in here to drain and refill the one real queue,
   * so the member exists on every shipped client and pretending otherwise made
   * this declaration false. Its shape is unstable and may change in any
   * release: it is typed opaquely on purpose, so reading a field off it is a
   * deliberate cast rather than an accident. Do not use it.
   */
  readonly _internal: unknown;
}

export declare function createClient<R extends Registry = Registry>(
  options: CreateClientOptions,
): TelemetryClient<R>;
