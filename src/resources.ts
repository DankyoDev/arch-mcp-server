import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tools/registry.js';
import { allTools } from './tools/index.js';

const DEFAULT_RULES = `# Host rules

This file is yours. arch-mcp reads it from \`ARCH_MCP_RULES\` (inline) or
\`ARCH_MCP_RULES_FILE\`, default \`~/.config/arch-mcp/rules.md\`.

- Published ports: only 30000-35000.
- Do not restart docker or containerd without warning.
- nginx and postgres are critical: ask before touching them.
`;

export function rulesText(): string {
  const inline = process.env.ARCH_MCP_RULES;
  if (inline !== undefined && inline.trim() !== '') return inline;
  const path = process.env.ARCH_MCP_RULES_FILE ?? join(homedir(), '.config', 'arch-mcp', 'rules.md');
  if (existsSync(path)) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return DEFAULT_RULES;
    }
  }
  return DEFAULT_RULES;
}

/** Generated from the tool registry so it cannot drift. */
export function cheatsheetText(): string {
  const lines = [
    '# arch-mcp cheatsheet',
    '',
    '| Question | Tool |',
    '|---|---|',
    '| Is the host healthy? | `sys_status` |',
    '| Why did a unit fail? | `svc_failed` then `log_query` |',
    '| What uses RAM or CPU? | `proc_list` |',
    '| Are there updates? | `pkg_status` |',
    '| What fills the disk? | `fs_usage` |',
    '| Is a port listening? | `net_ports` |',
    '| What is this host? | `sys_info` / `host_capabilities` |',
    '',
    '## All tools',
    '',
    '| Tool | Description |',
    '|---|---|',
  ];
  for (const tool of allTools) {
    lines.push(`| \`${tool.name}\` | ${tool.description.replace(/\|/g, '/')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'rules',
    'arch://rules',
    {
      title: 'Host rules',
      description: 'Owner rules for this host: ports, critical services, what not to touch.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: rulesText() }],
    }),
  );

  server.registerResource(
    'capabilities',
    'arch://capabilities',
    {
      title: 'Host capabilities',
      description: 'Detected tools and features (pacman, journald, sensors, nftables...).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const capabilities = await ctx.capabilities();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(capabilities.ok ? capabilities.data : { error: capabilities.error }),
          },
        ],
      };
    },
  );

  server.registerResource(
    'cheatsheet',
    'arch://cheatsheet',
    {
      title: 'Tool cheatsheet',
      description: 'Which tool answers which question.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: cheatsheetText() }],
    }),
  );
}
