import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { groupErrors, parseBoots, parseJournalLines } from '../parse/journal.js';
import type { JournalEntry } from '../parse/journal.js';
import { defineTool, toolData } from './registry.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const DATE_ARG = /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?|-?\d{1,3}[smhdw]|today|yesterday|now)$/;

const UNIT_PATTERN = /^[A-Za-z0-9@:._-]{1,200}(\.(service|socket|timer|target|mount|automount|path|slice|scope|swap|device))?$/;

const LogQueryInput = z.object({
  unit: z.string().max(220).regex(UNIT_PATTERN, 'not a valid unit name').optional().describe('Only entries from this unit'),
  priority: z
    .enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'])
    .optional()
    .describe('Maximum priority (err includes more severe)'),
  since: z.string().max(32).regex(DATE_ARG, 'expected YYYY-MM-DD or YYYY-MM-DD HH:MM:SS').optional().describe('Start of the window'),
  until: z.string().max(32).regex(DATE_ARG, 'expected YYYY-MM-DD or YYYY-MM-DD HH:MM:SS').optional().describe('End of the window'),
  grep: z.string().max(200).optional().describe('Case-insensitive substring of the message'),
  limit: z.number().int().min(1).max(200).default(50).describe('Entries per page'),
  cursor: z.string().max(64).optional().describe('Cursor from a previous call'),
  detail: z.enum(['concise', 'detailed']).default('concise').describe('detailed adds unit, pid and boot id'),
});

export const logQueryTool = defineTool({
  name: 'log_query',
  title: 'Journal query',
  description:
    'Journal entries filtered by unit, priority, time window or message text. Returns ts, prio and msg only; detailed adds unit, pid and boot.',
  schema: LogQueryInput,
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const offset = decodeCursor(input.cursor);
    if (!offset.ok) return offset;

    const fetch = offset.data + input.limit;
    const argv = ['journalctl', '--output=json', '--no-pager', '-n', String(fetch)];
    if (input.unit !== undefined) argv.push('-u', input.unit);
    if (input.priority !== undefined) argv.push('-p', input.priority);
    if (input.since !== undefined) argv.push('--since', input.since);
    if (input.until !== undefined) argv.push('--until', input.until);

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'journal output exceeded the read cap', 'narrow the window or lower limit');
    }

    let entries = parseJournalLines(result.data.stdout);
    if (input.grep !== undefined && input.grep !== '') {
      const needle = input.grep.toLowerCase();
      entries = entries.filter((entry) => entry.msg.toLowerCase().includes(needle));
    }

    const from = Math.max(0, entries.length - offset.data - input.limit);
    const page = entries.slice(from, Math.max(0, entries.length - offset.data));
    const next = entries.length >= fetch ? encodeCursor(offset.data + input.limit) : null;

    return ok(
      toolData(
        page.map((entry) => compactEntry(entry, input.detail === 'detailed')),
        { cursor: next },
      ),
    );
  },
});

export const logErrorsTool = defineTool({
  name: 'log_errors',
  title: 'Deduplicated errors',
  description:
    'Errors and worse from the current boot, deduplicated by unit and message with counts. Use it to spot recurring failures.',
  schema: z.object({
    limit: z.number().int().min(1).max(50).default(30).describe('Groups per page'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(
      ctx.conn,
      ['journalctl', '-p', 'err..alert', '-n', '200', '--output=json', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'journal output exceeded the read cap', 'use log_query with a filter');
    }

    const groups = groupErrors(parseJournalLines(result.data.stdout));
    return ok(toolData(groups.slice(0, input.limit), { total: groups.length }));
  },
});

export const logBootsTool = defineTool({
  name: 'log_boots',
  title: 'Boot list',
  description:
    'Journal boots with their first and last timestamp. Use it to know which boot you are inspecting.',
  schema: z.object({
    limit: z.number().int().min(1).max(50).default(20).describe('Boots per page'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(ctx.conn, ['journalctl', '--list-boots', '--no-pager'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;

    const boots = parseBoots(result.data.stdout);
    return ok(toolData(boots.slice(0, input.limit), { total: boots.length }));
  },
});

export const logUnitTailTool = defineTool({
  name: 'log_unit_tail',
  title: 'Tail one unit',
  description:
    'Last journal lines of one unit. Use it after svc_status when you need recent context, not a full query.',
  schema: z.object({
    unit: z.string().max(220).regex(UNIT_PATTERN, 'not a valid unit name').describe('Unit name'),
    lines: z.number().int().min(1).max(200).default(20).describe('Lines to return'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(
      ctx.conn,
      ['journalctl', '-u', input.unit, '-n', String(input.lines), '--output=json', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'journal output exceeded the read cap', 'lower lines');
    }

    const entries = parseJournalLines(result.data.stdout).slice(-input.lines);
    return ok(toolData(entries.map((entry) => compactEntry(entry, false))));
  },
});

function compactEntry(entry: JournalEntry, detailed: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = { ts: entry.ts, prio: entry.prio, msg: entry.msg };
  if (detailed) {
    if (entry.unit !== undefined) base.unit = entry.unit;
    if (entry.pid !== undefined) base.pid = entry.pid;
    if (entry.boot !== undefined) base.boot = entry.boot;
  }
  return base;
}
