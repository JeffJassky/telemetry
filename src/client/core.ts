import { uuidv7 } from 'uuidv7';

declare const window: unknown;

/**
 * The isomorphic SDK core (instrumentation §6) — ~80% of every client by
 * value. Zero heavy dependencies; platform entries are thin wiring over this.
 *
 * The wire contract it upholds:
 *  - every record carries a client-generated UUIDv7 `_id` (the idempotency
 *    contract — transports are at-least-once)
 *  - trace ids are UUIDv7 too: schema §2.6 samples on the random hex tail
 *  - batch context carries subjects/actor once, not per record
 *  - `identify()` swaps subjects AND posts one `$identify` control record —
 *    the input to the server-side stitching job
 */

export const newId = uuidv7;

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

export type Transport = (url: string, body: string, headers: Record<string, string>) => Promise<TransportResult>;

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
  /** the mounted ingest endpoint, e.g. https://app.example.com/telemetry/ingest */
  url: string;
  /** injected at build; the key supplies service/env */
  release?: string;
  flushIntervalMs?: number;
  /** records per POST */
  maxBatchSize?: number;
  /** ring buffer cap — drop-OLDEST beyond it; new telemetry outranks stale */
  maxQueueSize?: number;
  /** failed flushes retry with backoff; a batch is abandoned after this many */
  maxRetries?: number;
  transport?: Transport;
  /** persists the anon id (and lets platforms persist queues); memory default */
  storage?: ClientStorage;
  clientContext?: ClientContextInput;
  /** false = drop instead of send. Web adapter wires DNT/GPC/consent here. */
  consent?: () => boolean;
  /** registry name used by captureError. Convention: 'error.unhandled'. */
  errorName?: string;
  /**
   * Last gate before a record joins the queue — the one place every kind
   * (event, error, span, state, usage) passes through. Return the record to
   * keep it, a modified copy to redact it, or `null` to drop it silently.
   *
   * This is where noise dies. A host that filters at the platform level
   * instead — swallowing `window.onerror` before the SDK sees it — has to win
   * a listener-registration race to do it, which is a real footgun; the whole
   * point of putting the hook here is that the host never has to think about
   * ordering.
   *
   * A throwing hook DROPS the record and reports via `onError`. Fail-closed is
   * deliberate: the common use is redaction, and a half-applied redaction that
   * still ships is worse than a lost record.
   */
  beforeSend?: (rec: WireRecord) => WireRecord | null | undefined | void;
  /** SDK-internal failures — never thrown at the app */
  onError?: (e: unknown) => void;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  end(extra?: { attrs?: Record<string, string>; metrics?: Record<string, number> }): void;
}

const SDK = { name: '@jeffjassky/telemetry', version: '0' };

const defaultTransport: Transport = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', headers, body, keepalive: true });
  return { ok: res.ok, status: res.status };
};

const memoryStorage = (): ClientStorage => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
};

/** stable, cheap error grouping — server-side fingerprinting can refine later */
const fingerprint = (type: string, message: string, frame: string): string => {
  const s = `${type}|${message.replace(/\d+/g, 'N').slice(0, 200)}|${frame}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+))\)?\s*$/;

const parseFrames = (stack: string | undefined) =>
  (stack ?? '')
    .split('\n')
    .slice(1, 21)
    .map((line) => FRAME_RE.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      fn: m[1],
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    }));

export function createClient(options: CreateClientOptions) {
  const {
    key,
    url,
    release,
    flushIntervalMs = 5000,
    maxBatchSize = 50,
    maxQueueSize = 1000,
    maxRetries = 5,
    transport = defaultTransport,
    storage = memoryStorage(),
    consent = () => true,
    errorName = 'error.unhandled',
    beforeSend,
    onError = () => {},
  } = options;

  // ClientContext must always be storable — platform/appVersion are required
  // by the envelope, so the core guarantees them and adapters refine them
  const clientContext = {
    platform: typeof window === 'undefined' ? 'server' : 'web',
    appVersion: release ?? 'unknown',
    ...options.clientContext,
  };

  // ── identity context ──
  let anonId = storage.get('telemetry_anon') ?? null;
  if (!anonId) {
    anonId = `anon_${newId()}`;
    try {
      storage.set('telemetry_anon', anonId);
    } catch (e) {
      onError(e);
    }
  }
  const sessionId = `ses_${newId()}`;
  /** current subjects, by type. anon + session ride every batch (schema §2.3). */
  const subjects = new Map<string, string>([
    ['anon', anonId],
    ['session', sessionId],
  ]);
  let actor: string | undefined;

  // ── queue ──
  const queue: WireRecord[] = [];
  let dropped = 0;
  let attempts = 0;
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const enqueue = (rec: WireRecord) => {
    let out: WireRecord | null | undefined | void = rec;
    if (beforeSend) {
      try {
        out = beforeSend(rec);
      } catch (e) {
        onError(e); // fail-closed: a broken filter must not leak what it was filtering
        return;
      }
    }
    if (!out) return;
    queue.push(out);
    while (queue.length > maxQueueSize) {
      queue.shift(); // drop-oldest: fresh telemetry outranks stale
      dropped++;
    }
  };

  // ── tracing ──
  const spanStack: Array<{ traceId: string; spanId: string }> = [];
  const activeTrace = () => spanStack[spanStack.length - 1];

  const doFlush = async (): Promise<void> => {
    if (!queue.length) return;
    if (!consent()) {
      queue.length = 0; // no consent = no send AND no hoard
      return;
    }
    while (queue.length) {
      const batch = queue.slice(0, maxBatchSize);
      const body = JSON.stringify({
        sdk: SDK,
        sentAt: new Date().toISOString(),
        release,
        client: clientContext,
        context: {
          subjects: [...subjects].map(([type, id]) => ({ type, id })),
          ...(actor ? { actor } : {}),
        },
        records: batch,
      });
      try {
        const res = await transport(url, body, {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        });
        if (!res.ok) throw new Error(`ingest ${res.status}`);
        queue.splice(0, batch.length);
        attempts = 0;
      } catch (e) {
        // records stay queued; the SAME _ids retry, so the server dedupes
        attempts++;
        if (attempts >= maxRetries) {
          queue.splice(0, batch.length);
          dropped += batch.length;
          attempts = 0;
        }
        onError(e);
        return; // back off until the next interval
      }
    }
  };

  const flush = () => (flushing ??= doFlush().finally(() => (flushing = null)));

  if (flushIntervalMs > 0) {
    timer = setInterval(() => void flush(), flushIntervalMs);
    (timer as { unref?: () => void }).unref?.(); // never hold a node process open
  }

  const client = {
    track(
      name: string,
      opts: {
        attrs?: Record<string, string>;
        metrics?: Record<string, number>;
        data?: Record<string, unknown>;
        occurredAt?: Date;
        subjects?: Array<{ type: string; id: string; role?: string }>;
        severity?: string;
      } = {},
    ) {
      const trace = activeTrace();
      enqueue({
        _id: newId(),
        name,
        occurredAt: (opts.occurredAt ?? new Date()).toISOString(),
        ...(opts.attrs ? { attrs: opts.attrs } : {}),
        ...(opts.metrics ? { metrics: opts.metrics } : {}),
        ...(opts.data ? { data: opts.data } : {}),
        ...(opts.subjects ? { subjects: opts.subjects } : {}),
        ...(opts.severity ? { severity: opts.severity } : {}),
        ...(trace ? { traceId: trace.traceId, parentId: trace.spanId } : {}),
      });
    },

    captureError(err: unknown, ctx: { handled?: boolean; name?: string; attrs?: Record<string, string> } = {}) {
      const e = err instanceof Error ? err : new Error(String(err));
      const frames = parseFrames(e.stack);
      const trace = activeTrace();
      enqueue({
        _id: newId(),
        name: ctx.name ?? errorName,
        occurredAt: new Date().toISOString(),
        severity: 'error',
        ...(ctx.attrs ? { attrs: ctx.attrs } : {}),
        ...(trace ? { traceId: trace.traceId, parentId: trace.spanId } : {}),
        error: {
          type: e.name || 'Error',
          message: e.message,
          handled: ctx.handled ?? true,
          fingerprint: fingerprint(e.name, e.message, frames[0]?.filename ?? ''),
          frames,
        },
      });
    },

    startSpan(name: string, opts: { attrs?: Record<string, string> } = {}): Span {
      const parent = activeTrace();
      const traceId = parent?.traceId ?? newId();
      const spanId = newId();
      const startedAt = Date.now();
      const frame = { traceId, spanId };
      spanStack.push(frame);
      let ended = false;
      return {
        traceId,
        spanId,
        end: (extra = {}) => {
          if (ended) return;
          ended = true;
          const i = spanStack.indexOf(frame);
          if (i >= 0) spanStack.splice(i, 1);
          enqueue({
            _id: newId(),
            name,
            occurredAt: new Date(startedAt).toISOString(),
            traceId,
            spanId,
            ...(parent ? { parentId: parent.spanId } : {}),
            durationMs: Date.now() - startedAt,
            ...(opts.attrs || extra.attrs ? { attrs: { ...opts.attrs, ...extra.attrs } } : {}),
            ...(extra.metrics ? { metrics: extra.metrics } : {}),
          });
        },
      };
    },

    state(name: string, st: { key: string; from?: string; to: string; previousSinceMs?: number }) {
      enqueue({ _id: newId(), name, occurredAt: new Date().toISOString(), state: st });
    },

    /**
     * Swap in the real identity. Future batches carry the new subjects; one
     * `$identify` control record links anon → user for the stitching job.
     * The anon subject stays on the context — stitching consumes the alias.
     */
    identify(ids: Record<string, string | null | undefined>) {
      const hadUser = subjects.get('user');
      for (const [type, id] of Object.entries(ids)) {
        if (id == null) subjects.delete(type);
        else subjects.set(type, String(id));
      }
      const user = subjects.get('user');
      if (user && user !== hadUser && anonId) {
        enqueue({
          _id: newId(),
          name: '$identify',
          occurredAt: new Date().toISOString(),
          anonRef: `anon:${anonId}`,
          userRef: `user:${user}`,
        });
      }
      if (subjects.has('user')) actor = `user:${subjects.get('user')}`;
    },

    setActor(ref: string | undefined) {
      actor = ref;
    },

    flush,

    async shutdown() {
      if (timer) clearInterval(timer);
      await flush();
    },

    /** introspection for adapters and tests — not a public contract */
    _internal: {
      queue,
      subjects,
      get anonId() {
        return anonId!;
      },
      sessionId,
      get dropped() {
        return dropped;
      },
      enqueue,
    },
  };

  return client;
}

export type TelemetryClient = ReturnType<typeof createClient>;

// The isomorphic registry surface (instrumentation §8): the host's registry
// file imports defineRegistry from '/core' so server AND clients can import
// it — server at runtime, clients `import type` only, so zod never reaches a
// bundle. This chain must stay mongoose/express-free.
export { defineRegistry, boundedMeta } from '../server/registry.js';
export type { Registry, EventSpec, RollupSpec, DimSource } from '../server/registry.js';
