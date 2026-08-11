import type { TelemetryClient } from './core.js';

/**
 * Vue wiring (instrumentation §7): plugin installing the global error handler
 * and a provide/inject accessor. Vue itself is a type-only concern — the
 * plugin shape is structural, so nothing imports 'vue' at runtime.
 */

export const TELEMETRY_KEY = 'telemetry' as const;

interface VueAppLike {
  config: { errorHandler?: (err: unknown, instance: unknown, info: string) => void };
  provide(key: string, value: unknown): void;
}

export function createTelemetryPlugin(client: TelemetryClient) {
  return {
    install(app: VueAppLike) {
      const previous = app.config.errorHandler;
      app.config.errorHandler = (err, instance, info) => {
        client.captureError(err, { handled: false, attrs: { vue_info: String(info) } });
        previous?.(err, instance, info);
      };
      app.provide(TELEMETRY_KEY, client);
    },
  };
}

/** composition-API accessor: const t = useTelemetry(inject) */
export function useTelemetry(inject: (key: string) => unknown): TelemetryClient {
  const client = inject(TELEMETRY_KEY) as TelemetryClient | undefined;
  if (!client) throw new Error('useTelemetry: telemetry plugin not installed');
  return client;
}

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';
