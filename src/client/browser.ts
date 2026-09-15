import type { TelemetryClient } from './core.js';

/**
 * What a browser-hosted client captures and hooks — shared by `/web` and the
 * Electron renderer, which is a browser with an IPC transport. Anything in
 * here is wiring, not behaviour: the filtering it relies on lives in core's
 * `ignoreErrors`, so a `captureError()` the app calls itself is filtered the
 * same way as one the window raised.
 */

declare const window: any;
declare const navigator: any;
declare const screen: any;
declare const localStorage: any;

export const browserContext = () => {
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

/** localStorage when it exists and is writable; `undefined` (memory) otherwise */
export const browserStorage = () =>
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

/**
 * `window.onerror` and `unhandledrejection` → `captureError(handled: false)`,
 * tagged with which one fired. Returns the uninstaller.
 */
export function installBrowserErrorHooks(client: TelemetryClient): () => void {
  if (typeof window === 'undefined') return () => {};
  const onError = (ev: any) =>
    client.captureError(ev.error ?? ev.message, { handled: false, attrs: { source: 'window_error' } });
  const onRejection = (ev: any) =>
    client.captureError(ev.reason, { handled: false, attrs: { source: 'unhandled_rejection' } });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
