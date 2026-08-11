import { createClient, type CreateClientOptions, type TelemetryClient, type Transport } from './core.js';

/**
 * Electron wiring (instrumentation §7). The shape that matters: records from
 * the RENDERER route through MAIN over IPC, so the key never reaches the
 * renderer, there is one queue, and offline behavior lives in one place.
 * Electron itself is structural-typed — nothing imports 'electron' at runtime.
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
  const { captureProcessErrors = true, ipcMain, clientContext, ...rest } = opts;
  const client = createClient({
    ...rest,
    clientContext: { platform: 'electron', appVersion: opts.release ?? 'unknown', ...clientContext },
  });

  if (captureProcessErrors && typeof process !== 'undefined') {
    process.on('uncaughtException', (err) => client.captureError(err, { handled: false }));
    process.on('unhandledRejection', (reason) => client.captureError(reason, { handled: false }));
  }

  // renderer batches arrive as raw wire records — enqueue into the one queue
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

/**
 * Renderer: the web-shaped client with an IPC transport. The URL/key options
 * are unused here — main owns the credential — so this takes only behavior.
 */
export function createRendererTelemetry(
  ipcRenderer: IpcRendererLike,
  opts: Omit<CreateClientOptions, 'key' | 'url' | 'transport'> = {},
): TelemetryClient {
  const transport: Transport = async (_url, body) => {
    const batch = JSON.parse(body);
    await ipcRenderer.invoke(IPC_CHANNEL, batch.records);
    return { ok: true };
  };
  return createClient({
    ...opts,
    key: 'pk_ipc_tk_000000000000000000000000', // never leaves the process
    url: 'ipc://main',
    transport,
    clientContext: { platform: 'electron', appVersion: opts.release ?? 'unknown', ...opts.clientContext },
  });
}

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';
