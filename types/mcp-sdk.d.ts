import type { ToolDescriptor } from './mcp.js';

/**
 * The seam to the official MCP SDK. Structural — no dependency on
 * `@modelcontextprotocol/sdk`; a real `McpServer` satisfies `McpServerLike`.
 */

export interface McpServerLike {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
    handler: (args: any, extra: unknown) => unknown | Promise<unknown>,
  ): unknown;
}

/** register every descriptor on an MCP (or MCP-shaped) server */
export declare function registerTelemetryTools(server: McpServerLike, tools: ToolDescriptor[]): void;
