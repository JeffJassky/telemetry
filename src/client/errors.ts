/**
 * Error shaping shared by every client AND the server's `captureError()`:
 * how a thrown value becomes `{ type, message, frames, fingerprint }`.
 *
 * One module, deliberately. A fingerprint is only a grouping key if every
 * emitter computes it the same way — a server that normalised ids and a
 * browser that did not would file the same bug as two issues.
 *
 * Isomorphic: no `window`, no `fs`, no `process`.
 */

export interface ErrorFrame {
  fn?: string;
  filename: string;
  lineno: number;
  colno: number;
}

export interface ErrorDetail {
  type: string;
  message: string;
  handled: boolean;
  fingerprint: string;
  frames: ErrorFrame[];
}

/** `at fn (file:line:col)` or `at file:line:col` — V8 and JavaScriptCore alike */
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+))\)?\s*$/;

export const MAX_FRAMES = 20;

export const parseFrames = (stack: string | undefined): ErrorFrame[] =>
  (stack ?? '')
    .split('\n')
    .slice(1, MAX_FRAMES + 1)
    .map((line) => FRAME_RE.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      fn: m[1],
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    }));

/**
 * The message with every identifier flattened, so one bug is one group.
 *
 * Order matters: 24-hex ObjectIds and UUIDs are replaced BEFORE bare digits,
 * or `65f3aa…` would become `N` `f` `N` `aa` … and two ids that differ in
 * where their digits fall would fingerprint differently.
 */
export const normalizeMessage = (message: string): string =>
  message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
    .replace(/\d+/g, 'N')
    .slice(0, 200);

/** stable, cheap grouping — `type | normalized message | top frame filename` */
export const fingerprint = (type: string, message: string, frame: string): string => {
  const s = `${type}|${normalizeMessage(message)}|${frame}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

/**
 * Whatever was thrown, as an Error.
 *
 * A thrown object is described by its constructor and never serialised: a
 * rejection reason can be a response body, a form, a transcript. Saying what
 * it was is diagnostic; saying what it held is a leak.
 */
export const coerceError = (err: unknown): Error => {
  if (err instanceof Error) return err;
  if (err && typeof err === 'object') {
    const name = (err as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
    const e = new Error(`Non-Error thrown (${name})`);
    e.stack = `${e.name}: ${e.message}`;
    return e;
  }
  const e = new Error(String(err));
  e.stack = `${e.name}: ${e.message}`;
  return e;
};

/** the `error` envelope for a thrown value */
export const describeError = (err: unknown, handled: boolean): ErrorDetail => {
  const e = coerceError(err);
  const frames = parseFrames(e.stack);
  const type = e.name || 'Error';
  return {
    type,
    message: e.message,
    handled,
    fingerprint: fingerprint(type, e.message, frames[0]?.filename ?? ''),
    frames,
  };
};

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECTID_SEGMENT_RE = /^[0-9a-f]{24}$/i;
const DIGITS_SEGMENT_RE = /^\d+$/;

/**
 * An endpoint path with every identifier flattened, so one endpoint is one
 * group — the URL analogue of `normalizeMessage` above. Query strings and
 * hashes are dropped outright; a segment shaped like an identifier or token
 * (UUID, 24-hex ObjectId, bare digits, or a long opaque token) becomes
 * `<id>`. Capped at 200 chars, the `route` convention hosts already use.
 */
export const scrubUrlPath = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || !raw) return undefined;
  // Absolute or relative — `new URL` with a dummy base takes both, and the
  // pathname it returns has the origin, query and hash already removed. A
  // parse failure means attacker-shaped input: cut at ?/# raw rather than
  // drop the record's only attribution.
  let path: string;
  try {
    path = new URL(raw, 'http://localhost').pathname;
  } catch {
    path = raw.split(/[?#]/, 1)[0];
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return path
    .split('/')
    .map((seg) =>
      UUID_SEGMENT_RE.test(seg) ||
      OBJECTID_SEGMENT_RE.test(seg) ||
      DIGITS_SEGMENT_RE.test(seg) ||
      seg.length >= 32
        ? '<id>'
        : seg,
    )
    .join('/')
    .slice(0, 200);
};

export interface HttpErrorAttrs {
  url?: string;
  method?: string;
  status?: string;
}

/**
 * HTTP attribution for a captured error (issue #395: an axios rejection
 * symbolicated to vendor frames only — createError/settle/xhr — so no HTTP
 * failure was attributable to an endpoint).
 *
 * Axios builds its error inside the XHR callback, which is why the stack is
 * useless: every frame is axios internals. But the same object carries
 * `config` (url, method) and `response` (status), so `captureError` stamps
 * them as attrs instead of reading the call site out of the frames.
 *
 * Only the scrubbed PATH is recorded, never the full URL: the origin is
 * dropped because a host or tenant subdomain can name a customer, and
 * release/service/env already say which deployment answered. A scrubbed path
 * is also the better group key — the same endpoint failing in staging and
 * prod reads as one issue, not two.
 *
 * A `fetch` rejection carries no such shape — a failed fetch rejects with a
 * bare TypeError, and an HTTP error status does not reject at all — so there
 * is nothing reliable to stamp. A host that wants fetch attribution passes
 * url/method/status explicitly in `captureError`'s `attrs`.
 */
export const extractHttpAttrs = (err: unknown): HttpErrorAttrs => {
  if (!err || typeof err !== 'object') return {};
  const e = err as { isAxiosError?: unknown; config?: unknown; response?: unknown };
  const config =
    e.config && typeof e.config === 'object' ? (e.config as { url?: unknown; method?: unknown; baseURL?: unknown }) : undefined;
  // `isAxiosError`, or the config only — duck-typed so axios-like wrappers
  // match too. A plain Error never carries `config`, so this changes nothing
  // for non-HTTP failures.
  if (e.isAxiosError !== true && !config) return {};
  // `config.url` is often path-only while `config.baseURL` holds the origin;
  // resolve the two so the scrubber sees the real path either way.
  let rawUrl: unknown = config?.url;
  if (typeof rawUrl === 'string' && rawUrl && typeof config?.baseURL === 'string' && config.baseURL) {
    try {
      rawUrl = new URL(rawUrl, config.baseURL).toString();
    } catch {
      // keep the raw url — the scrubber cuts it raw below
    }
  }
  const url = scrubUrlPath(rawUrl);
  const method =
    typeof config?.method === 'string' && config.method ? config.method.toUpperCase().slice(0, 16) : undefined;
  const response = e.response && typeof e.response === 'object' ? (e.response as { status?: unknown }) : undefined;
  const status =
    typeof response?.status === 'number' && Number.isFinite(response.status) ? String(response.status) : undefined;
  return { ...(url ? { url } : {}), ...(method ? { method } : {}), ...(status ? { status } : {}) };
};

export type IgnorePattern = string | RegExp;

/** strings match by substring, RegExp by test */
export const matchesIgnore = (message: string | undefined, patterns: readonly IgnorePattern[]): boolean =>
  !!message && patterns.some((p) => (typeof p === 'string' ? message.includes(p) : p.test(message)));
