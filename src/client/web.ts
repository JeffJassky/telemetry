import { createClient, type CreateClientOptions, type TelemetryClient, type WireRecord } from './core.js';

/**
 * Browser wiring (instrumentation §7): ClientContext capture, global error
 * hooks, consent/DNT/GPC gate, unload flush via sendBeacon. ~wiring, not
 * behavior — anything smarter belongs in core.
 */

declare const window: any;
declare const navigator: any;
declare const document: any;
declare const screen: any;
declare const localStorage: any;

const browserContext = () => {
  const nav = typeof navigator === 'undefined' ? {} : navigator;
  const scr = typeof screen === 'undefined' ? {} : screen;
  const win = typeof window === 'undefined' ? {} : window;
  return {
    platform: 'web',
    appVersion: 'unknown', // overridden by opts.release / clientContext
    userAgent: nav.userAgent,
    locale: nav.language,
    timezone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return undefined;
      }
    })(),
    screenW: scr.width,
    screenH: scr.height,
    viewportW: win.innerWidth,
    viewportH: win.innerHeight,
    connection: nav.connection?.effectiveType,
    online: nav.onLine,
  };
};

/** DNT/GPC are hard signals — a host consent callback can only narrow further */
const privacySignalsAllow = () => {
  if (typeof navigator === 'undefined') return true;
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return false;
  if (typeof window !== 'undefined' && window.doNotTrack === '1') return false;
  return true;
};

/**
 * Errors the browser raises that are not failures.
 *
 * `ResizeObserver loop completed with undelivered notifications` is the whole
 * list for now, and it earns its place: Chrome raises it as an *uncaught
 * error* whenever an observer callback dirties layout and the next batch
 * lands a frame later. Nothing is broken, nothing is actionable, and it is
 * emitted often enough to bury real errors — one production host saw 49 of
 * its last 50 error records come from this one message.
 *
 * Filtered by default because the alternative is every host discovering it
 * separately. Opt back in with `captureBenignErrors: true`.
 */
export const BENIGN_BROWSER_ERRORS: readonly RegExp[] = [
  /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/,
];

export interface WebTelemetryOptions extends Omit<CreateClientOptions, 'storage' | 'consent'> {
  /** host consent, e.g. a cookie-banner check. ANDed with DNT/GPC. */
  consent?: () => boolean;
  /** auto-capture window.onerror / unhandledrejection (default true) */
  captureGlobalErrors?: boolean;
  /**
   * Drop error records whose message matches. Strings match by substring,
   * RegExp by test. ADDED to `BENIGN_BROWSER_ERRORS`, not replacing it.
   */
  ignoreErrors?: Array<string | RegExp>;
  /** keep the `BENIGN_BROWSER_ERRORS` records instead of dropping them */
  captureBenignErrors?: boolean;
}

export function createWebTelemetry(opts: WebTelemetryOptions): TelemetryClient {
  const {
    consent = () => true,
    captureGlobalErrors = true,
    ignoreErrors,
    captureBenignErrors = false,
    clientContext,
    ...rest
  } = opts;

  // Message filtering rides core's `beforeSend` rather than the global error
  // listeners: the listeners are not the only way a record is born
  // (`captureError()` calls from app code are), and a host-supplied
  // `beforeSend` must still get its turn on everything that survives.
  const patterns = [...(captureBenignErrors ? [] : BENIGN_BROWSER_ERRORS), ...(ignoreErrors ?? [])];
  const hostBeforeSend = rest.beforeSend;
  const beforeSend = (rec: WireRecord) => {
    const message = (rec.error as { message?: string } | undefined)?.message;
    if (
      message &&
      patterns.some((p) => (typeof p === 'string' ? message.includes(p) : p.test(message)))
    ) {
      return null;
    }
    return hostBeforeSend ? hostBeforeSend(rec) : rec;
  };

  const storage =
    typeof localStorage === 'undefined'
      ? undefined
      : {
          get: (k: string) => {
            try {
              return localStorage.getItem(k);
            } catch {
              return null;
            }
          },
          set: (k: string, v: string) => {
            try {
              localStorage.setItem(k, v);
            } catch {}
          },
        };

  const client = createClient({
    ...rest,
    beforeSend,
    storage,
    clientContext: { ...browserContext(), appVersion: opts.release ?? 'unknown', ...clientContext },
    consent: () => privacySignalsAllow() && consent(),
  });

  if (typeof window !== 'undefined') {
    if (captureGlobalErrors) {
      window.addEventListener('error', (ev: any) => {
        client.captureError(ev.error ?? ev.message, { handled: false });
      });
      window.addEventListener('unhandledrejection', (ev: any) => {
        client.captureError(ev.reason, { handled: false });
      });
    }

    // Unload flush: sendBeacon carries the batch (no headers possible, so the
    // pk_ key rides the query string — the server accepts that for pk_ only).
    const beaconFlush = () => {
      const q = client._internal.queue;
      if (!q.length || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
      const body = JSON.stringify({
        sdk: { name: '@jeffjassky/telemetry', version: '0' },
        sentAt: new Date().toISOString(),
        release: opts.release,
        client: { ...browserContext(), appVersion: opts.release ?? 'unknown' },
        context: {
          subjects: [...client._internal.subjects].map(([type, id]) => ({ type, id })),
        },
        records: q.slice(0, 100),
      });
      const sep = opts.url.includes('?') ? '&' : '?';
      if (navigator.sendBeacon(`${opts.url}${sep}key=${encodeURIComponent(opts.key)}`, body)) {
        q.length = 0; // retries would duplicate _ids anyway; the server dedupes
      }
    };
    window.addEventListener('pagehide', beaconFlush);
    document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'hidden') beaconFlush();
    });
  }

  return client;
}

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';
