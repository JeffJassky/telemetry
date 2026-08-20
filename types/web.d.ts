import type { CreateClientOptions, Registry, TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

/** browser-raised non-errors, dropped by default (see `captureBenignErrors`) */
export declare const BENIGN_BROWSER_ERRORS: readonly RegExp[];

export interface WebTelemetryOptions extends Omit<CreateClientOptions, 'storage' | 'consent'> {
  /** host consent (cookie banner etc). ANDed with DNT/GPC — those always win. */
  consent?: () => boolean;
  /** auto-capture window.onerror / unhandledrejection (default true) */
  captureGlobalErrors?: boolean;
  /** drop error records by message — strings match by substring, RegExp by test.
   *  ADDED to `BENIGN_BROWSER_ERRORS`, not replacing it. */
  ignoreErrors?: Array<string | RegExp>;
  /** keep the `BENIGN_BROWSER_ERRORS` records instead of dropping them */
  captureBenignErrors?: boolean;
}

/**
 * Browser client: ClientContext capture, global error hooks, DNT/GPC gate,
 * unload flush via sendBeacon (pk_ key rides the query string there).
 */
export declare function createWebTelemetry<R extends Registry = Registry>(
  opts: WebTelemetryOptions,
): TelemetryClient<R>;
