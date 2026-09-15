import { createClient, type CreateClientOptions, type TelemetryClient } from './core.js';
import { BENIGN_BROWSER_ERRORS, browserContext, browserStorage, installBrowserErrorHooks } from './browser.js';
import type { IgnorePattern } from './errors.js';

/**
 * Browser wiring (instrumentation §7): ClientContext capture, global error
 * hooks, consent/DNT/GPC gate, unload flush via sendBeacon. ~wiring, not
 * behavior — anything smarter belongs in core.
 */

declare const window: any;
declare const navigator: any;
declare const document: any;

export { BENIGN_BROWSER_ERRORS } from './browser.js';

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
  /**
   * Drop error records whose message matches. Strings match by substring,
   * RegExp by test. ADDED to `BENIGN_BROWSER_ERRORS`, not replacing it.
   */
  ignoreErrors?: readonly IgnorePattern[];
  /** keep the `BENIGN_BROWSER_ERRORS` records instead of dropping them */
  captureBenignErrors?: boolean;
}

export function createWebTelemetry(opts: WebTelemetryOptions): TelemetryClient {
  const {
    consent = () => true,
    captureGlobalErrors = true,
    ignoreErrors = [],
    captureBenignErrors = false,
    clientContext,
    ...rest
  } = opts;

  const client = createClient({
    ...rest,
    ignoreErrors: [...(captureBenignErrors ? [] : BENIGN_BROWSER_ERRORS), ...ignoreErrors],
    storage: browserStorage(),
    clientContext: { ...browserContext(), appVersion: opts.release ?? 'unknown', ...clientContext },
    consent: () => privacySignalsAllow() && consent(),
  });

  if (typeof window !== 'undefined') {
    if (captureGlobalErrors) installBrowserErrorHooks(client);

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
