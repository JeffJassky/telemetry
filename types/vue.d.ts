import type { TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

export declare const TELEMETRY_KEY: 'telemetry';

export interface VueTelemetryPluginOptions {
  /** default false — Vue's errorHandler is the only place a component error is seen */
  handled?: boolean;
  /** extra attrs on every component error, alongside `source: 'vue'` and `vue_info` */
  attrs?: Record<string, string>;
}

/** Vue 3 plugin: installs the global errorHandler and provides the client. */
export declare function createTelemetryPlugin(
  client: TelemetryClient,
  options?: VueTelemetryPluginOptions,
): {
  install(app: {
    config: { errorHandler?: (err: unknown, instance: unknown, info: string) => void };
    provide(key: string, value: unknown): void;
  }): void;
};

/** composition-API accessor — pass Vue's inject: useTelemetry(inject) */
export declare function useTelemetry(inject: (key: string) => unknown): TelemetryClient;
