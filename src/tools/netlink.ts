import { z } from 'zod';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, MUTATE, runChecked } from './ops.js';

const IFACE = /^[A-Za-z0-9_.:@-]{1,32}$/;

interface LinkRow {
  ifname: string;
  operstate: string;
}

async function listLinks(ctx: ToolContext): Promise<Result<LinkRow[]>> {
  const result = await runChecked(ctx, ['ip', '-j', 'link', 'show'], 32_768);
  if (!result.ok) return result;
  try {
    const parsed: unknown = JSON.parse(result.data.stdout);
    if (!Array.isArray(parsed)) return err('E_PARSE', 'ip -j link show returned an unexpected shape');
    return ok(
      parsed.map((row) => {
        const link = row as Record<string, unknown>;
        return {
          ifname: String(link.ifname ?? ''),
          operstate: String(link.operstate ?? ''),
        };
      }),
    );
  } catch {
    return err('E_PARSE', 'cannot parse ip -j link show', 'is iproute2 installed?');
  }
}

/**
 * Only `up`: bringing an interface down can cut the session and the denylist blocks
 * `ip link ... down` (rule `network-down`). Restoring connectivity is the useful case.
 */
export const netLinkTool = defineTool({
  name: 'net_link',
  title: 'Bring a network interface up',
  description:
    'Bring one interface up (ip link set dev X up) and return its new state. Bringing interfaces down is blocked by policy.',
  schema: z.object({
    interface: z.string().max(32).regex(IFACE, 'not a valid interface name').describe('e.g. eth0, wlan0'),
    dry_run: z.boolean().default(false).describe('Preview without changing anything'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const links = await listLinks(ctx);
    if (!links.ok) return links;
    const link = links.data.find((l) => l.ifname === input.interface);
    if (link === undefined) {
      return err('E_NOTFOUND', `interface ${input.interface} not found`, 'use net_status to list interfaces');
    }

    const preview = { interface: input.interface, action: 'up', current: link.operstate };

    return confirmed(ctx, 'net_link', input as never, preview, async () => {
      const changed = await runCommand(ctx.conn, ['ip', 'link', 'set', 'dev', input.interface, 'up'], {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 4096,
      });
      if (!changed.ok) return changed;
      if (changed.data.code !== 0) {
        return err(
          'E_PERM',
          `cannot bring ${input.interface} up`,
          changed.data.stderr.trim() || 'root or CAP_NET_ADMIN is required',
        );
      }
      const after = await listLinks(ctx);
      const state = after.ok ? (after.data.find((l) => l.ifname === input.interface)?.operstate ?? null) : null;
      return ok(toolData({ interface: input.interface, action: 'up', state }));
    });
  },
});
