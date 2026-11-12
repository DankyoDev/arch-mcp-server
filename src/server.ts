import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import { registerResources } from './resources.js';
import { allTools } from './tools/index.js';
import { registerTool, toolsForProfile } from './tools/registry.js';
import type { ToolContext } from './tools/registry.js';

/**
 * The version lives in package.json only. `dist/` and `src/` sit one level
 * below the package root, so the same lookup works in both.
 */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

/** Fresh MCP server with the profile's tools and the three resources. */
export function buildServer(ctx: ToolContext, config: Config): McpServer {
  const server = new McpServer({ name: 'arch-mcp', version: VERSION });
  for (const tool of toolsForProfile(allTools, config.profile)) {
    registerTool(server, tool, ctx);
  }
  registerResources(server, ctx);
  return server;
}
