import {
  createClient,
  installProcessErrorHandlers,
  type CreateClientOptions,
  type TelemetryClient,
  type Transport,
} from './core.js';
import { BENIGN_BROWSER_ERRORS, browserContext, browserStorage, installBrowserErrorHooks } from './browser.js';
import type { IgnorePattern } from './errors.js';

/**
 * Electron wiring (instrumentation §7). The shape that matters: records from
 * the RENDERER route through MAIN over IPC, so the key never reaches the
 * renderer, there is one queue, and offline behavior lives in one place.
 * Electron itself is structural-typed — nothing imports 'electron' at runtime.
 *
 * Every error record says which process raised it (`attrs.process`) and which
 * hook caught it (`attrs.source`), so a dashboard can split main from renderer
 * without the host tagging anything.
 */

export const IPC_CHANNEL = 'telemetry:batch';

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

interface IpcRendererLike {
  invoke(channel: string, ...args: any[]): Promise<any>;
}

export interface MainTelemetryOptions extends CreateClientOptions {
  /** wire process-level crash handlers (default true) */
  captureProcessErrors?: boolean;
  /** pass electron's ipcMain to accept renderer batches over IPC */
  ipcMain?: IpcMainLike;
}

/** Main process: node transport, crash handlers, the single real queue. */
export function createMainTelemetry(opts: MainTelemetryOptions): TelemetryClient {
  const { captureProcessErrors = true, ipcMain, clientContext, errorAttrs, ...rest } = opts;
  const client = createClient({
    ...rest,
    errorAttrs: { process: 'main', ...errorAttrs },
    clientContext: { platform: 'electron', appVersion: opts.release ?? 'unknown', ...clientContext },
  });

  if (captureProcessErrors) installProcessErrorHandlers(client);

  // renderer batches arrive as raw wire records — enqueue into the one queue.
  // They went through the renderer's beforeSend already; main's runs again in
  // enqueue, so a redaction configured in main covers both processes.
  ipcMain?.handle(IPC_CHANNEL, (_event, records: unknown) => {
    if (Array.isArray(records)) {
      for (const rec of records) {
        if (rec && typeof rec._id === 'string' && typeof rec.name === 'string') {
          client._internal.enqueue(rec);
        }
      }
    }
    return { ok: true };
  });

  return client;
}

export interface RendererTelemetryOptions extends Omit<CreateClientOptions, 'key' | 'url' | 'transport' | 'storage'> {
  /** auto-capture window.onerror / unhandledrejection (default true) */
  captureGlobalErrors?: boolean;
  /** drop error records by message — ADDED to `BENIGN_BROWSER_ERRORS` */
  ignoreErrors?: readonly IgnorePattern[];
  /** keep the `BENIGN_BROWSER_ERRORS` records instead of dropping them */
  captureBenignErrors?: boolean;
}

/**
 * Renderer: the web-shaped client with an IPC transport. The URL/key options
 * are unused here — main owns the credential — so this takes only behavior.
 *
 * `ipcRenderer` is anything with `invoke(channel, records)`: electron's own,
 * or the one method a sandboxed preload exposes over `contextBridge`.
 */
export function createRendererTelemetry(
  ipcRenderer: IpcRendererLike,
  opts: RendererTelemetryOptions = {},
): TelemetryClient {
  const {
    captureGlobalErrors = true,
    ignoreErrors = [],
    captureBenignErrors = false,
    clientContext,
    errorAttrs,
    ...rest
  } = opts;
  const transport: Transport = async (_url, body) => {
    const batch = JSON.parse(body);
    await ipcRenderer.invoke(IPC_CHANNEL, batch.records);
    return { ok: true };
  };
  const client = createClient({
    ...rest,
    key: 'pk_ipc_tk_000000000000000000000000', // never leaves the process
    url: 'ipc://main',
    transport,
    storage: browserStorage(),
    errorAttrs: { process: 'renderer', ...errorAttrs },
    ignoreErrors: [...(captureBenignErrors ? [] : BENIGN_BROWSER_ERRORS), ...ignoreErrors],
    clientContext: { ...browserContext(), platform: 'electron', appVersion: opts.release ?? 'unknown', ...clientContext },
  });
  if (captureGlobalErrors) installBrowserErrorHooks(client);
  return client;
}

export { createClient, installProcessErrorHandlers } from './core.js';
export { BENIGN_BROWSER_ERRORS } from './browser.js';
export type { TelemetryClient } from './core.js';
