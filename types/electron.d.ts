import type { CreateClientOptions, TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

export declare const IPC_CHANNEL: 'telemetry:batch';

export interface MainTelemetryOptions extends CreateClientOptions {
  captureProcessErrors?: boolean;
  /** electron's ipcMain — accepts renderer batches over IPC */
  ipcMain?: { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void };
}

/** Main process: node transport, crash handlers, the single real queue. */
export declare function createMainTelemetry(opts: MainTelemetryOptions): TelemetryClient;

/**
 * Renderer: same client, IPC transport — records route through main so the
 * key never reaches the renderer and offline behavior lives in one queue.
 */
export declare function createRendererTelemetry(
  ipcRenderer: { invoke(channel: string, ...args: any[]): Promise<any> },
  opts?: Omit<CreateClientOptions, 'key' | 'url' | 'transport'>,
): TelemetryClient;
