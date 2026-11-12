import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { registerResources } from './resources.js';
import { allTools } from './tools/index.js';
import { registerTool, toolsForProfile } from './tools/registry.js';
import type { ToolContext } from './tools/registry.js';

export const VERSION = '0.5.0';

/** Fresh MCP server with the profile's tools and the three resources. */
export function buildServer(ctx: ToolContext, config: Config): McpServer {
  const server = new McpServer({ name: 'arch-mcp', version: VERSION });
  for (const tool of toolsForProfile(allTools, config.profile)) {
    registerTool(server, tool, ctx);
  }
  registerResources(server, ctx);
  return server;
}
