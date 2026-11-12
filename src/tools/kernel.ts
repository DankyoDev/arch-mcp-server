import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { parseJournalLines } from '../parse/journal.js';
import { defineTool, toolData } from './registry.js';
import { confirmed, MUTATE, READ, runChecked } from './ops.js';

const MODULE = /^[A-Za-z0-9_-]{1,64}$/;
const SYSCTL_KEY = /^[A-Za-z0-9_.-]{1,128}$/;
const SYSCTL_VALUE = /^[A-Za-z0-9 ,.:_/+-]{1,256}$/;
const SYSCTL_FILE = '/etc/sysctl.d/99-arch-mcp.conf';

export const modListTool = defineTool({
  name: 'mod_list',
  title: 'Loaded kernel modules',
  description: 'List loaded modules (lsmod) with size and the modules using them.',
  schema: z.object({
    filter: z.string().max(64).optional().describe('Only modules whose name contains this text'),
    limit: z.number().int().min(1).max(300).default(100),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runChecked(ctx, ['lsmod'], 65_536);
    if (!result.ok) return result;
    const rows = result.data.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 3)
      .map((parts) => ({
        name: parts[0] ?? '',
        size_b: Number(parts[1] ?? 0),
        used: Number(parts[2] ?? 0),
        by: (parts[3] ?? '').split(',').filter(Boolean),
      }))
      .filter((row) => row.name !== '')
      .filter((row) => (input.filter ? row.name.includes(input.filter) : true));
    return ok(toolData(rows.slice(0, input.limit), { total: rows.length }));
  },
});

export const modInfoTool = defineTool({
  name: 'mod_info',
  title: 'Kernel module details',
  description: 'modinfo for one module: file, license, description, parameters and dependencies.',
  schema: z.object({ name: z.string().max(64).regex(MODULE, 'not a valid module name') }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runChecked(ctx, ['modinfo', input.name], 65_536);
    if (!result.ok) return result;
    const fields: Record<string, string | string[]> = {};
    for (const line of result.data.stdout.split('\n')) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === 'alias' || key === 'firmware') {
        const list = (fields[key] as string[] | undefined) ?? [];
        list.push(value);
        fields[key] = list.slice(0, 20);
      } else if (key === 'parm') {
        const list = (fields[key] as string[] | undefined) ?? [];
        list.push(value.slice(0, 200));
        fields[key] = list.slice(0, 30);
      } else {
        fields[key] = value.slice(0, 300);
      }
    }
    return ok(toolData({ module: input.name, ...fields }));
  },
});

export const modLoadTool = defineTool({
  name: 'mod_load',
  title: 'Load a kernel module',
  description: 'modprobe a module (root). Two-step confirmation.',
  schema: z.object({
    name: z.string().max(64).regex(MODULE, 'not a valid module name'),
    dry_run: z.boolean().default(false).describe('Preview without loading'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    return confirmed(ctx, 'mod_load', input as never, { module: input.name, action: 'load' }, async () => {
      const result = await runChecked(ctx, ['modprobe', input.name], 16_384);
      if (!result.ok) return result;
      const loaded = await runChecked(ctx, ['lsmod'], 65_536);
      const present =
        loaded.ok && loaded.data.stdout.split('\n').some((line) => line.startsWith(`${input.name} `));
      return ok(toolData({ module: input.name, loaded: present }));
    });
  },
});

export const modUnloadTool = defineTool({
  name: 'mod_unload',
  title: 'Unload a kernel module',
  description: 'modprobe -r a module (root). Refuses if it is in use. Two-step confirmation.',
  schema: z.object({
    name: z.string().max(64).regex(MODULE, 'not a valid module name'),
    dry_run: z.boolean().default(false).describe('Preview without unloading'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    return confirmed(ctx, 'mod_unload', input as never, { module: input.name, action: 'unload' }, async () => {
      const result = await runChecked(ctx, ['modprobe', '-r', input.name], 16_384);
      if (!result.ok) return result;
      const loaded = await runChecked(ctx, ['lsmod'], 65_536);
      const present =
        loaded.ok && loaded.data.stdout.split('\n').some((line) => line.startsWith(`${input.name} `));
      return ok(toolData({ module: input.name, loaded: present }));
    });
  },
});

export const modBlacklistTool = defineTool({
  name: 'mod_blacklist',
  title: 'Blacklist a kernel module',
  description:
    'Append "blacklist <module>" to /etc/modprobe.d/arch-mcp-blacklist.conf and unload it. Two-step confirmation.',
  schema: z.object({
    name: z.string().max(64).regex(MODULE, 'not a valid module name'),
    unload: z.boolean().default(true).describe('Also try modprobe -r now'),
    dry_run: z.boolean().default(false).describe('Preview without writing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const file = '/etc/modprobe.d/arch-mcp-blacklist.conf';
    const preview = { module: input.name, file, unload: input.unload };
    return confirmed(ctx, 'mod_blacklist', input as never, preview, async () => {
      const present = await runCommand(ctx.conn, ['grep', '-qx', `blacklist ${input.name}`, file], {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 1024,
      });
      if (!present.ok || present.data.code !== 0) {
        const written = await runCommand(
          ctx.conn,
          ['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', '_', `blacklist ${input.name}`, file],
          { timeoutMs: ctx.config.timeoutMs, maxBytes: 2048 },
        );
        if (!written.ok) return written;
        if (written.data.code !== 0) {
          return err('E_PERM', `cannot write ${file}`, written.data.stderr.trim() || 'root is required');
        }
      }
      let unloaded = false;
      if (input.unload) {
        const removed = await runChecked(ctx, ['modprobe', '-r', input.name], 8192);
        unloaded = removed.ok;
      }
      return ok(toolData({ module: input.name, blacklisted: true, file, unloaded }));
    });
  },
});

export const sysctlGetTool = defineTool({
  name: 'sysctl_get',
  title: 'Read sysctl parameters',
  description: 'One kernel parameter by key, or a bounded list with no key.',
  schema: z.object({
    key: z.string().max(128).regex(SYSCTL_KEY, 'not a valid sysctl key').optional().describe('e.g. vm.swappiness'),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    if (input.key) {
      const result = await runChecked(ctx, ['sysctl', '-n', input.key], 4096);
      if (!result.ok) return result;
      return ok(toolData({ key: input.key, value: result.data.stdout.trim() }));
    }
    const result = await runChecked(ctx, ['sysctl', '-a'], 262_144);
    if (!result.ok) return result;
    const entries = result.data.stdout
      .split('\n')
      .map((line) => {
        const idx = line.indexOf(' = ');
        return idx > 0 ? { key: line.slice(0, idx), value: line.slice(idx + 3).trim() } : null;
      })
      .filter((entry): entry is { key: string; value: string } => entry !== null);
    return ok(toolData(entries.slice(0, input.limit), { total: entries.length }));
  },
});

export const sysctlSetTool = defineTool({
  name: 'sysctl_set',
  title: 'Set a sysctl parameter',
  description:
    'Apply a kernel parameter at runtime (sysctl -w) and optionally persist it in /etc/sysctl.d. Two-step confirmation.',
  schema: z.object({
    key: z.string().max(128).regex(SYSCTL_KEY, 'not a valid sysctl key'),
    value: z.string().max(256).regex(SYSCTL_VALUE, 'value contains unsupported characters'),
    persist: z.boolean().default(true).describe('Also append key=value to /etc/sysctl.d/99-arch-mcp.conf'),
    dry_run: z.boolean().default(false).describe('Preview without changing anything'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const preview = { key: input.key, value: input.value, persist: input.persist };
    return confirmed(ctx, 'sysctl_set', input as never, preview, async () => {
      const applied = await runChecked(ctx, ['sysctl', '-w', `${input.key}=${input.value}`], 8192);
      if (!applied.ok) return applied;
      let persisted = false;
      if (input.persist) {
        const written = await runCommand(
          ctx.conn,
          ['sh', '-c', 'printf "%s\\n" "$1" >> "$2"', '_', `${input.key}=${input.value}`, SYSCTL_FILE],
          { timeoutMs: ctx.config.timeoutMs, maxBytes: 2048 },
        );
        if (!written.ok) return written;
        persisted = written.data.code === 0;
      }
      return ok(toolData({ key: input.key, value: input.value, persisted }));
    });
  },
});

export const kernelLogTool = defineTool({
  name: 'kernel_log',
  title: 'Kernel messages',
  description: 'Recent kernel log entries (journalctl -k), compact. Falls back to dmesg if needed.',
  schema: z.object({
    lines: z.number().int().min(1).max(200).default(30),
    priority: z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']).optional(),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const argv = ['journalctl', '-k', '--output=json', '--no-pager', '-n', String(input.lines)];
    if (input.priority) argv.push('-p', input.priority);
    const journal = await runCommand(ctx.conn, argv, { timeoutMs: 20_000, maxBytes: 262_144 });
    if (journal.ok && journal.data.code === 0 && journal.data.stdout.trim() !== '') {
      const entries = parseJournalLines(journal.data.stdout).slice(0, input.lines);
      return ok(toolData(entries));
    }
    const dmesg = await runCommand(ctx.conn, ['dmesg', '--color=never', '-T'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!dmesg.ok) return dmesg;
    const lines = dmesg.data.stdout.split('\n').filter(Boolean).slice(-input.lines);
    return ok(toolData(lines.map((msg) => ({ msg }))));
  },
});
