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

export type IgnorePattern = string | RegExp;

/** strings match by substring, RegExp by test */
export const matchesIgnore = (message: string | undefined, patterns: readonly IgnorePattern[]): boolean =>
  !!message && patterns.some((p) => (typeof p === 'string' ? message.includes(p) : p.test(message)));
