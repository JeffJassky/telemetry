import type { ToolDescriptor } from './mcp.js';

/**
 * The one seam to the official MCP SDK — isolated here so the core `./mcp`
 * entry stays runtime-free. The SDK is NOT imported: `McpServerLike` is a
 * structural type, so a real `McpServer` from `@modelcontextprotocol/sdk`
 * satisfies it without this package taking a dependency on it. Any server that
 * exposes a compatible `registerTool` works identically.
 *
 *   import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
 *   import { createTelemetryMcp } from '@jeffjassky/telemetry/mcp'
 *   import { registerTelemetryTools } from '@jeffjassky/telemetry/mcp/sdk'
 *
 *   const server = new McpServer({ name: 'my-app', version: '1.0.0' })
 *   registerTelemetryTools(server, createTelemetryMcp({ telemetry, viewerAdapter }))
 */

export interface McpServerLike {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
    handler: (args: any, extra: unknown) => unknown | Promise<unknown>,
  ): unknown;
}

/**
 * Register every descriptor on an MCP server. The SDK takes a zod raw shape as
 * `inputSchema`, which is exactly `descriptor.inputSchema.shape`. Each handler's
 * JSON result is wrapped as a single text content block — the MCP wire shape —
 * and `extra` (the SDK's per-request context) is forwarded verbatim to the
 * descriptor, which is what its viewerAdapter resolves the scope from.
 */
export function registerTelemetryTools(server: McpServerLike, tools: ToolDescriptor[]): void {
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema.shape },
      async (args: unknown, extra: unknown) => {
        const data = await t.handler(args, extra);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      },
    );
  }
}
