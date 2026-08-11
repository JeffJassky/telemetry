import type { CreateClientOptions, Registry, TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

export interface WebTelemetryOptions extends Omit<CreateClientOptions, 'storage' | 'consent'> {
  /** host consent (cookie banner etc). ANDed with DNT/GPC — those always win. */
  consent?: () => boolean;
  /** auto-capture window.onerror / unhandledrejection (default true) */
  captureGlobalErrors?: boolean;
}

/**
 * Browser client: ClientContext capture, global error hooks, DNT/GPC gate,
 * unload flush via sendBeacon (pk_ key rides the query string there).
 */
export declare function createWebTelemetry<R extends Registry = Registry>(
  opts: WebTelemetryOptions,
): TelemetryClient<R>;
