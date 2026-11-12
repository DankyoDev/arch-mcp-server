import { z } from 'zod';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, MUTATE, runChecked } from './ops.js';

const CONNECTION = /^[^\n\r:]{1,128}$/;

function unescapeName(value: string): string {
  return value.replace(/\\:/g, ':');
}

async function listConnections(ctx: ToolContext): Promise<Result<string[]>> {
  const result = await runCommand(ctx.conn, ['nmcli', '-t', '-f', 'NAME', 'connection', 'show'], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 32_768,
  });
  if (!result.ok) return result;
  if (result.data.code !== 0) {
    return err('E_UNSUPPORTED', 'nmcli is not available', 'install NetworkManager to manage connections');
  }
  return ok(
    result.data.stdout
      .split('\n')
      .map((line) => unescapeName(line.trim()))
      .filter((line) => line !== ''),
  );
}

async function activeConnection(ctx: ToolContext): Promise<string | null> {
  const result = await runChecked(ctx, ['nmcli', '-t', '-f', 'GENERAL.CONNECTION', 'dev', 'show'], 8192);
  if (!result.ok) return null;
  for (const line of result.data.stdout.split('\n')) {
    const prefix = 'GENERAL.CONNECTION:';
    if (!line.startsWith(prefix)) continue;
    const value = unescapeName(line.slice(prefix.length).trim());
    if (value !== '' && value !== '--') return value;
  }
  return null;
}

export const netWifiActionTool = defineTool({
  name: 'net_wifi_action',
  title: 'Activate or deactivate a NetworkManager connection',
  description:
    'Bring a saved connection up or down by name (nmcli connection up/down). Refuses to drop the active one unless force. Two-step confirmation.',
  schema: z.object({
    connection: z
      .string()
      .max(128)
      .regex(CONNECTION, 'not a valid connection name')
      .describe('Saved connection name, e.g. "Wired connection 1"'),
    action: z.enum(['up', 'down']).describe('up activates it, down deactivates it'),
    force: z.boolean().default(false).describe('Allow deactivating the connection currently carrying traffic'),
    dry_run: z.boolean().default(false).describe('Preview without changing anything'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const caps = await ctx.capabilities();
    if (caps.ok && caps.data.features.network_manager !== true) {
      return err('E_UNSUPPORTED', 'NetworkManager (nmcli) is not installed', 'install networkmanager');
    }

    const connections = await listConnections(ctx);
    if (!connections.ok) return connections;
    if (!connections.data.includes(input.connection)) {
      return err(
        'E_NOTFOUND',
        `connection "${input.connection}" not found`,
        `available: ${connections.data.slice(0, 10).join(', ') || 'none'}`,
      );
    }

    const active = await activeConnection(ctx);
    if (input.action === 'down' && active === input.connection && !input.force) {
      return err(
        'E_POLICY',
        `"${input.connection}" is the active connection`,
        'pass force=true only if you accept losing connectivity',
      );
    }

    const preview = {
      connection: input.connection,
      action: input.action,
      active,
      force: input.force,
    };

    return confirmed(ctx, 'net_wifi_action', input as never, preview, async () => {
      const changed = await runCommand(ctx.conn, ['nmcli', 'connection', input.action, input.connection], {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 4096,
      });
      if (!changed.ok) return changed;
      if (changed.data.code !== 0) {
        return err(
          'E_PERM',
          `cannot bring "${input.connection}" ${input.action}`,
          changed.data.stderr.trim() || 'NetworkManager refused the change',
        );
      }
      const after = await activeConnection(ctx);
      return ok(toolData({ connection: input.connection, action: input.action, active: after }));
    });
  },
});
