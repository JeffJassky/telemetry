import type { CreateClientOptions, TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

export interface CliTelemetryOptions extends Omit<CreateClientOptions, 'storage'> {
  /** where the anon id and offline queue live, e.g. ~/.config/mytool */
  configDir: string;
  /** argv scanned for --no-telemetry (default process.argv) */
  argv?: string[];
  /** age cap for replayed offline records (default 7 days) */
  maxQueueAgeMs?: number;
}

/**
 * CLI client: disk queue flushed on exit AND next run, persistent anon id,
 * hard DO_NOT_TRACK / TELEMETRY_DISABLED / --no-telemetry respect (opted-out
 * returns a working client that never sends or stores anything).
 */
export declare function createCliTelemetry(opts: CliTelemetryOptions): TelemetryClient;
