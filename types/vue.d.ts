import type { TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

export declare const TELEMETRY_KEY: 'telemetry';

/** Vue 3 plugin: installs the global errorHandler and provides the client. */
export declare function createTelemetryPlugin(client: TelemetryClient): {
  install(app: {
    config: { errorHandler?: (err: unknown, instance: unknown, info: string) => void };
    provide(key: string, value: unknown): void;
  }): void;
};

/** composition-API accessor — pass Vue's inject: useTelemetry(inject) */
export declare function useTelemetry(inject: (key: string) => unknown): TelemetryClient;
