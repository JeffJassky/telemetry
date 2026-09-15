import { describeError } from '../client/errors.js';
import type { EmitInput, EmitResult } from './emit.js';

/**
 * `captureError()` for the SERVER — a thrown value becomes an `error`-kind
 * record through `emit()`, shaped by the same frame parser and fingerprint
 * every client uses (client/errors.ts). One algorithm, so the API server's
 * `CastError` and the desktop's group the same way.
 *
 * Trusted caller, so unlike the client SDK this takes `tenantId`, `service`
 * and `release` explicitly and may name subjects. Redaction is the host's:
 * pass a `redact` hook at construction and it runs on message, stack-derived
 * frames and attrs before anything is written — a server stack names files
 * under a home directory and a message can echo a request.
 */

export interface CaptureErrorOptions {
  tenantId: string;
  /** registry name; default 'error.unhandled' — hosts usually declare a server-origin twin */
  name?: string;
  service?: string;
  release?: string;
  env?: string;
  subjects?: Array<{ type: string; id: string; role?: string }>;
  attrs?: Record<string, string>;
  /** false for an uncaught exception / unhandled rejection; default true */
  handled?: boolean;
  dedupeKey?: string;
  occurredAt?: Date;
}

export interface CaptureErrorCtx {
  emit: (name: string, doc: EmitInput) => Promise<EmitResult>;
  /** default registry name */
  errorName?: string;
  /** stamped under the per-call attrs, e.g. `{ process: 'api' }` */
  errorAttrs?: Record<string, string>;
  /** host redaction, applied to every string before the write; fail-closed */
  redact?: (text: string) => string;
  logger: { warn(msg: string): void };
}

export function createCaptureError(ctx: CaptureErrorCtx) {
  const { emit, errorName = 'error.unhandled', errorAttrs, redact = (s) => s, logger } = ctx;

  return async function captureError(err: unknown, opts: CaptureErrorOptions): Promise<EmitResult | null> {
    let doc: EmitInput;
    try {
      const detail = describeError(err, opts.handled ?? true);
      const error = {
        type: redact(detail.type).slice(0, 100),
        message: redact(detail.message).slice(0, 500),
        handled: detail.handled,
        fingerprint: detail.fingerprint,
        frames: detail.frames.map((f) => ({
          ...(f.fn ? { fn: redact(f.fn) } : {}),
          filename: redact(f.filename),
          lineno: f.lineno,
          colno: f.colno,
        })),
      };
      const merged = errorAttrs || opts.attrs ? { ...errorAttrs, ...opts.attrs } : undefined;
      const attrs = merged
        ? Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, redact(String(v))]))
        : undefined;
      doc = {
        tenantId: opts.tenantId,
        severity: 'error',
        ...(opts.service ? { service: opts.service } : {}),
        ...(opts.release ? { release: opts.release } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.subjects ? { subjects: opts.subjects } : {}),
        ...(attrs ? { attrs } : {}),
        ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
        ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}),
        error,
      };
    } catch (e) {
      // fail-closed: a redaction that throws must not ship what it was redacting
      logger.warn(`[telemetry] captureError dropped a record: ${(e as Error)?.message ?? e}`);
      return null;
    }
    return emit(opts.name ?? errorName, doc);
  };
}
