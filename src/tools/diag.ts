import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, MUTATE, READ, runChecked } from './ops.js';

async function diskUsage(ctx: ToolContext): Promise<string> {
  const result = await runCommand(ctx.conn, ['journalctl', '--disk-usage'], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 4096,
  });
  return result.ok ? result.data.stdout.trim() : '';
}

export const coredumpListTool = defineTool({
  name: 'coredump_list',
  title: 'Recent crashes',
  description: 'Coredumps recorded by systemd-coredump, newest first.',
  schema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runChecked(ctx, ['coredumpctl', 'list', '--no-pager', '--reverse'], 131_072);
    if (!result.ok) return result;
    const rows = result.data.stdout
      .split('\n')
      .filter((line) => /^[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}/.test(line))
      .slice(0, input.limit)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          time: [parts[0], parts[1], parts[2], parts[3]].filter(Boolean).join(' '),
          pid: Number(parts[4] ?? 0) || null,
          uid: Number(parts[5] ?? 0) || null,
          signal: parts[7] ?? '',
          corefile: parts[8] ?? '',
          exe: parts[9] ?? '',
          size: parts[10] ?? '',
        };
      });
    return ok(toolData(rows));
  },
});

export const coredumpInfoTool = defineTool({
  name: 'coredump_info',
  title: 'Coredump details',
  description: 'Metadata and backtrace header for one coredump (by PID). Bounded text.',
  schema: z.object({ pid: z.number().int().min(1).max(4_194_304) }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runChecked(ctx, ['coredumpctl', 'info', String(input.pid), '--no-pager'], 65_536);
    if (!result.ok) return result;
    const text = result.data.stdout;
    const max = Math.min(ctx.config.maxBytes * 2, 16_000);
    const truncated = text.length > max;
    return ok(toolData({ pid: input.pid, info: truncated ? text.slice(0, max) : text }, { total: text.length }));
  },
});

export const journalVacuumTool = defineTool({
  name: 'journal_vacuum',
  title: 'Trim the journal',
  description: 'Reduce journal size by size or age (journalctl --vacuum-*). Two-step confirmation.',
  schema: z.object({
    max_size: z.string().max(16).regex(/^\d+[KMGT]?$/i).optional().describe('e.g. 500M, 2G'),
    max_time: z.string().max(16).regex(/^\d+(s|min|h|d|w|month|y)$/i).optional().describe('e.g. 2w, 30d'),
    dry_run: z.boolean().default(false).describe('Preview current usage without trimming'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (!input.max_size && !input.max_time) {
      return err('E_POLICY', 'nothing to vacuum', 'pass max_size (500M) or max_time (30d)');
    }
    const before = await diskUsage(ctx);
    const preview = { before, max_size: input.max_size ?? null, max_time: input.max_time ?? null };
    return confirmed(ctx, 'journal_vacuum', input as never, preview, async () => {
      const argv = ['journalctl'];
      if (input.max_size) argv.push(`--vacuum-size=${input.max_size}`);
      if (input.max_time) argv.push(`--vacuum-time=${input.max_time}`);
      const result = await runChecked(ctx, argv, 16_384, 300_000);
      if (!result.ok) return result;
      const after = await diskUsage(ctx);
      return ok(toolData({ before, after, output: result.data.stdout.trim().slice(0, 500) }));
    });
  },
});
