import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type CreateClientOptions, type TelemetryClient } from './core.js';

/**
 * CLI wiring (instrumentation §7): disk queue in the config dir — flushed on
 * exit AND on next run, because exit flushes get killed — persistent
 * machine-scoped anon id, and hard DO_NOT_TRACK / --no-telemetry respect.
 */

export interface CliTelemetryOptions extends Omit<CreateClientOptions, 'storage'> {
  /** where the anon id and offline queue live, e.g. ~/.config/mytool */
  configDir: string;
  /** argv to scan for --no-telemetry (default process.argv) */
  argv?: string[];
  /** age cap for replayed offline records — older ones drop (default 7d) */
  maxQueueAgeMs?: number;
}

const noopClient = (opts: CreateClientOptions): TelemetryClient =>
  // a disabled CLI client is the same client with consent hard-off: every
  // call works, nothing is ever sent or stored
  createClient({ ...opts, flushIntervalMs: 0, consent: () => false });

export function createCliTelemetry(opts: CliTelemetryOptions): TelemetryClient {
  const { configDir, argv = typeof process !== 'undefined' ? process.argv : [], maxQueueAgeMs = 7 * 864e5, ...rest } = opts;

  const optedOut =
    (typeof process !== 'undefined' &&
      (process.env.DO_NOT_TRACK === '1' || process.env.TELEMETRY_DISABLED === '1')) ||
    argv.includes('--no-telemetry');
  if (optedOut) return noopClient(rest);

  try {
    mkdirSync(configDir, { recursive: true });
  } catch {}

  const file = (name: string) => join(configDir, name);
  const storage = {
    get: (k: string) => {
      try {
        return readFileSync(file(`${k}.txt`), 'utf8').trim();
      } catch {
        return null;
      }
    },
    set: (k: string, v: string) => {
      try {
        writeFileSync(file(`${k}.txt`), v);
      } catch {}
    },
  };

  const client = createClient({
    ...rest,
    storage,
    clientContext: { platform: 'cli', appVersion: rest.release ?? 'unknown', ...rest.clientContext },
  });

  // ── next-run replay: whatever last exit could not send ──
  const queueFile = file('telemetry-queue.json');
  try {
    const saved = JSON.parse(readFileSync(queueFile, 'utf8'));
    rmSync(queueFile, { force: true });
    if (Array.isArray(saved)) {
      const floor = Date.now() - maxQueueAgeMs;
      for (const rec of saved) {
        // the age cap keeps a machine offline for a month from replaying a
        // month of stale telemetry into today's buckets (open item §10)
        if (rec && typeof rec._id === 'string' && Date.parse(rec.occurredAt) >= floor) {
          client._internal.enqueue(rec);
        }
      }
    }
  } catch {}

  // ── exit save: flushes get killed, disk writes are sync ──
  if (typeof process !== 'undefined') {
    process.on('exit', () => {
      const q = client._internal.queue;
      if (q.length) {
        try {
          writeFileSync(queueFile, JSON.stringify(q));
        } catch {}
      }
    });
  }

  return client;
}

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';
