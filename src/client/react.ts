import * as React from 'react';
import type { TelemetryClient } from './core.js';

/**
 * React wiring (instrumentation §7): provider, hook, error boundary. Router
 * integration stays userland — page.view semantics belong to the app.
 */

const TelemetryContext = React.createContext<TelemetryClient | null>(null);

export function TelemetryProvider(props: { client: TelemetryClient; children?: React.ReactNode }) {
  return React.createElement(TelemetryContext.Provider, { value: props.client }, props.children);
}

export function useTelemetry(): TelemetryClient {
  const client = React.useContext(TelemetryContext);
  if (!client) {
    throw new Error('useTelemetry: no <TelemetryProvider> above this component');
  }
  return client;
}

interface BoundaryProps {
  /** falls back to the provider's client when omitted */
  client?: TelemetryClient;
  fallback?: React.ReactNode | ((error: Error) => React.ReactNode);
  children?: React.ReactNode;
}

/**
 * Catches render errors, reports them handled:true (the boundary DID handle
 * it — unhandled is the crash path), and renders the fallback.
 */
export class TelemetryErrorBoundary extends React.Component<BoundaryProps, { error: Error | null }> {
  static override contextType = TelemetryContext;
  declare context: TelemetryClient | null;

  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    const client = this.props.client ?? this.context;
    client?.captureError(error, {
      handled: true,
      attrs: info.componentStack ? { component_stack_head: info.componentStack.split('\n')[1]?.trim() ?? '' } : undefined,
    });
  }

  override render() {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback(error) : fallback ?? null;
    }
    return this.props.children ?? null;
  }
}

export { createClient } from './core.js';
export type { TelemetryClient } from './core.js';
