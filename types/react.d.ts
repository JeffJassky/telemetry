import type * as React from 'react';
import type { TelemetryClient } from './core.js';

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';

export declare function TelemetryProvider(props: {
  client: TelemetryClient;
  children?: React.ReactNode;
}): React.ReactElement;

/** throws when no <TelemetryProvider> is above the calling component */
export declare function useTelemetry(): TelemetryClient;

export declare class TelemetryErrorBoundary extends React.Component<{
  client?: TelemetryClient;
  fallback?: React.ReactNode | ((error: Error) => React.ReactNode);
  children?: React.ReactNode;
}> {}
