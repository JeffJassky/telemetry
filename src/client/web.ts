import { createClient, type CreateClientOptions, type TelemetryClient } from './core.js';

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

export interface WebTelemetryOptions extends Omit<CreateClientOptions, 'storage' | 'consent'> {
  /** host consent, e.g. a cookie-banner check. ANDed with DNT/GPC. */
  consent?: () => boolean;
  /** auto-capture window.onerror / unhandledrejection (default true) */
  captureGlobalErrors?: boolean;
}

export function createWebTelemetry(opts: WebTelemetryOptions): TelemetryClient {
  const { consent = () => true, captureGlobalErrors = true, clientContext, ...rest } = opts;

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
