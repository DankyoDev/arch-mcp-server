import { z } from 'zod';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, mapCommandError, MUTATE, READ } from './ops.js';

const MAX_CONTENT = 32_768;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const MACROS = /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/;

export interface CronEntry {
  schedule: string;
  command: string;
}

export interface CronEnv {
  name: string;
  value: string;
}

export interface ParsedCrontab {
  entries: CronEntry[];
  env: CronEnv[];
  invalid: string[];
}

/** Parses a crontab: entries, environment variables and lines that do not fit. */
export function parseCrontab(text: string): ParsedCrontab {
  const entries: CronEntry[] = [];
  const env: CronEnv[] = [];
  const invalid: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trimEnd();
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (envMatch !== null) {
      env.push({ name: envMatch[1] ?? '', value: envMatch[2] ?? '' });
      continue;
    }

    if (MACROS.test(trimmed.split(/\s+/)[0] ?? '')) {
      const [schedule = '', ...rest] = trimmed.split(/\s+/);
      const command = rest.join(' ');
      if (command === '') invalid.push(line);
      else entries.push({ schedule, command });
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 6 && parts.slice(0, 5).every((p) => /^[\d*/,\-]+$/.test(p))) {
      entries.push({ schedule: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') });
      continue;
    }

    invalid.push(line);
  }

  return { entries, env, invalid };
}

function validateContent(content: string): string | null {
  if (content.includes('\0')) return 'content contains a NUL byte';
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) return `content exceeds ${MAX_CONTENT} bytes`;
  for (const line of content.split('\n')) {
    if (line.length > 1000) return 'a line exceeds 1000 characters';
    if (line.includes('\r')) return 'use LF line endings, not CRLF';
  }
  return null;
}

function crontabArgv(flags: string, user?: string): string[] {
  return user === undefined ? ['crontab', flags] : ['crontab', '-u', user, flags];
}

function mapCronError(stderr: string, fallback: string) {
  if (/no crontab/i.test(stderr)) return null;
  if (/must be privileged/i.test(stderr)) {
    return {
      code: 'E_PERM' as const,
      message: 'the ssh user cannot manage another user\'s crontab',
      hint: 'run as root or manage your own crontab',
    };
  }
  return mapCommandError(stderr, fallback);
}

async function readCrontab(ctx: ToolContext, user?: string): Promise<Result<{ exists: boolean; text: string }>> {
  const result = await runCommand(ctx.conn, crontabArgv('-l', user), {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: MAX_CONTENT,
  });
  if (!result.ok) return result;
  if (result.data.code === 0) return ok({ exists: true, text: result.data.stdout });
  if (/no crontab/i.test(result.data.stderr)) return ok({ exists: false, text: '' });
  const mapped = mapCronError(result.data.stderr, 'crontab -l failed');
  return mapped === null ? ok({ exists: false, text: '' }) : { ok: false, error: mapped };
}

async function backup(ctx: ToolContext, text: string): Promise<string | null> {
  if (text.trim() === '') return null;
  const path = `/tmp/arch-mcp-crontab-${Date.now()}.bak`;
  const saved = await runCommand(ctx.conn, ['sh', '-c', 'cat > "$1"', '_', path], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 2048,
    input: text,
  });
  return saved.ok && saved.data.code === 0 ? path : null;
}

export const cronListTool = defineTool({
  name: 'cron_list',
  title: 'List a user crontab',
  description:
    'Entries, environment variables and malformed lines of a crontab. Returns empty (exists:false) when there is none.',
  schema: z.object({
    user: z
      .string()
      .max(32)
      .regex(USER_RE, 'not a valid user name')
      .optional()
      .describe('Another user (requires root); defaults to the ssh user'),
    raw: z.boolean().default(false).describe('Include the raw crontab text'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const current = await readCrontab(ctx, input.user);
    if (!current.ok) return current;
    const parsed = parseCrontab(current.data.text);
    return ok(
      toolData({
        user: input.user ?? null,
        exists: current.data.exists,
        count: parsed.entries.length,
        entries: parsed.entries,
        env: parsed.env,
        invalid: parsed.invalid,
        ...(input.raw ? { raw: current.data.text } : {}),
      }),
    );
  },
});

export const cronWriteTool = defineTool({
  name: 'cron_write',
  title: 'Replace a user crontab',
  description:
    'Replace the whole crontab (stdin, never shell). Backs up the previous one to /tmp, then verifies. Two-step confirmation.',
  schema: z.object({
    content: z.string().max(MAX_CONTENT).describe('Full crontab content; use LF and a trailing newline'),
    user: z
      .string()
      .max(32)
      .regex(USER_RE, 'not a valid user name')
      .optional()
      .describe('Another user (requires root); defaults to the ssh user'),
    dry_run: z.boolean().default(false).describe('Preview without writing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const problem = validateContent(input.content);
    if (problem !== null) return err('E_POLICY', problem, 'fix the content and retry');

    const parsed = parseCrontab(input.content);
    const preview = {
      user: input.user ?? null,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      count: parsed.entries.length,
      entries: parsed.entries,
      env: parsed.env,
      invalid: parsed.invalid,
    };

    return confirmed(ctx, 'cron_write', input as never, preview, async () => {
      const previous = await readCrontab(ctx, input.user);
      const backupPath = previous.ok ? await backup(ctx, previous.data.text) : null;

      const written = await runCommand(ctx.conn, crontabArgv('-', input.user), {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 4096,
        input: input.content,
      });
      if (!written.ok) return written;
      if (written.data.code !== 0) {
        const mapped = mapCronError(written.data.stderr, 'crontab - failed');
        if (mapped === null) return err('E_INTERNAL', 'crontab - failed');
        return { ok: false, error: mapped };
      }

      const check = await readCrontab(ctx, input.user);
      if (!check.ok) return check;
      const applied = parseCrontab(check.data.text);

      return ok(
        toolData({
          user: input.user ?? null,
          written: true,
          count: applied.entries.length,
          backup: backupPath,
        }),
      );
    });
  },
});

export const cronRemoveTool = defineTool({
  name: 'cron_remove',
  title: 'Remove a user crontab',
  description: 'Delete the crontab of the ssh user (or another, as root) after backing it up. Two-step confirmation.',
  schema: z.object({
    user: z
      .string()
      .max(32)
      .regex(USER_RE, 'not a valid user name')
      .optional()
      .describe('Another user (requires root); defaults to the ssh user'),
    dry_run: z.boolean().default(false).describe('Preview without removing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const preview = { user: input.user ?? null, action: 'remove crontab' };
    return confirmed(ctx, 'cron_remove', input as never, preview, async () => {
      const previous = await readCrontab(ctx, input.user);
      const backupPath = previous.ok ? await backup(ctx, previous.data.text) : null;
      if (previous.ok && !previous.data.exists) {
        return ok(toolData({ user: input.user ?? null, removed: false, reason: 'no crontab' }));
      }

      const removed = await runCommand(ctx.conn, crontabArgv('-r', input.user), {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 2048,
      });
      if (!removed.ok) return removed;
      if (removed.data.code !== 0) {
        const mapped = mapCronError(removed.data.stderr, 'crontab -r failed');
        if (mapped === null) return ok(toolData({ removed: false }));
        return { ok: false, error: mapped };
      }
      return ok(toolData({ user: input.user ?? null, removed: true, backup: backupPath }));
    });
  },
});
