import type { CreateClientOptions, IgnorePattern, TelemetryClient } from './core.js';

export { createClient, installProcessErrorHandlers } from './core.js';
export type { TelemetryClient } from './core.js';
/** browser-raised non-errors, dropped by default in the renderer (see `captureBenignErrors`) */
export declare const BENIGN_BROWSER_ERRORS: readonly RegExp[];

export declare const IPC_CHANNEL: 'telemetry:batch';

export interface MainTelemetryOptions extends CreateClientOptions {
  /** `process.on('uncaughtException' | 'unhandledRejection')`, reported `handled: false` (default true) */
  captureProcessErrors?: boolean;
  /** electron's ipcMain — accepts renderer batches over IPC */
  ipcMain?: { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void };
}

/**
 * Main process: node transport, crash handlers, the single real queue. Every
 * error record carries `attrs.process: 'main'` under whatever you pass.
 */
export declare function createMainTelemetry(opts: MainTelemetryOptions): TelemetryClient;

export interface RendererTelemetryOptions
  extends Omit<CreateClientOptions, 'key' | 'url' | 'transport' | 'storage'> {
  /** window.onerror / unhandledrejection → captureError (default true) */
  captureGlobalErrors?: boolean;
  /** drop error records by message — ADDED to `BENIGN_BROWSER_ERRORS` */
  ignoreErrors?: readonly IgnorePattern[];
  /** keep the `BENIGN_BROWSER_ERRORS` records instead of dropping them */
  captureBenignErrors?: boolean;
}

/**
 * Renderer: the browser-shaped client (context capture, global error hooks,
 * benign filter) with an IPC transport — records route through main so the
 * key never reaches the renderer and offline behavior lives in one queue.
 * Every error record carries `attrs.process: 'renderer'`. `ipcRenderer` is
 * anything with `invoke(channel, records)` — electron's own, or the one
 * method a sandboxed preload exposes over `contextBridge`.
 */
export declare function createRendererTelemetry(
  ipcRenderer: { invoke(channel: string, ...args: any[]): Promise<any> },
  opts?: RendererTelemetryOptions,
): TelemetryClient;
