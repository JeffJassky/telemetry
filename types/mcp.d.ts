import type { z } from 'zod';
import type {
  QueryLimits,
  SubjectAdapter,
  Telemetry,
  Viewer,
  ViewSpec,
} from './index.js';

/**
 * MCP tools — read-only tool descriptors over the query primitives, for a host
 * that wants to hand an agent telemetry access through its own MCP server. Not
 * a server: the factory returns descriptors; the `./mcp/sdk` seam registers
 * them. See plans/mcp-tools.md.
 */

/** inbound adapter — resolves the agent's session context to a Viewer per call */
export interface McpViewerAdapter {
  resolveViewer(ctx: unknown): Viewer | null | Promise<Viewer | null>;
}

/** one registrable tool: name, LLM-facing description, zod arg schema, handler */
export interface ToolDescriptor<A = any> {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (args: A, ctx: unknown) => Promise<unknown>;
}

export interface CreateTelemetryMcpOptions {
  telemetry: Telemetry;
  viewerAdapter: McpViewerAdapter;
  subjectAdapter?: SubjectAdapter;
  configured?: ViewSpec[];
  limits?: Partial<QueryLimits>;
  redact?: ((record: any) => any) | false;
}

/** the full read-only suite — all tools or none; there is no allowlist */
export declare function createTelemetryMcp(opts: CreateTelemetryMcpOptions): ToolDescriptor[];

/** derive a JSON Schema from a descriptor's zod input (zod v4 native) */
export declare const toJsonSchema: (tool: ToolDescriptor) => ReturnType<typeof z.toJSONSchema>;
