import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { isoFromSystemdStamp } from '../core/format.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { parseJournalLines } from '../parse/journal.js';
import {
  failedDetailFromBlock,
  parseShowBlocks,
  parseShowProperties,
  parseTimersJson,
  parseUnitsJson,
} from '../parse/systemd.js';
import { confirmationPayload, consumeConfirmation } from '../policy/confirm.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const UNIT_PATTERN =
  /^[A-Za-z0-9@:._-]{1,200}(\.(service|socket|timer|target|mount|automount|path|slice|scope|swap|device))?$/;

const UnitInput = z
  .string()
  .max(220)
  .regex(UNIT_PATTERN, 'not a valid systemd unit name')
  .describe('Unit name, e.g. nginx.service');

const ALLOWED_UNIT_DIRS = [
  '/etc/systemd/system/',
  '/usr/lib/systemd/system/',
  '/usr/local/lib/systemd/system/',
  '/run/systemd/system/',
];

const MAX_UNIT_FILE_CHARS = 8000;

export const svcListTool = defineTool({
  name: 'svc_list',
  title: 'List systemd units',
  description:
    'Systemd units filtered by state, name or type. Returns unit, active and sub; detailed adds description and load state.',
  schema: z.object({
    state: z.enum(['failed', 'running', 'all']).default('all').describe('Unit state filter'),
    pattern: z.string().max(64).optional().describe('Case-insensitive substring of the unit name'),
    type: z
      .enum(['service', 'socket', 'timer', 'target', 'mount', 'automount', 'path', 'slice', 'scope', 'swap', 'device'])
      .optional()
      .describe('Unit type (suffix)'),
    detail: z.enum(['concise', 'detailed']).default('concise').describe('detailed adds description and load'),
    limit: z.number().int().min(1).max(100).default(50).describe('Units per page'),
    cursor: z.string().max(64).optional().describe('Cursor from a previous call'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const offset = decodeCursor(input.cursor);
    if (!offset.ok) return offset;

    const argv = ['systemctl', 'list-units', '--output=json', '--no-pager'];
    if (input.state === 'failed') argv.push('--failed');
    else if (input.state === 'running') argv.push('--state=running');
    else argv.push('--all');

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'unit list exceeded the read cap', 'use state=failed or running');
    }

    let units = parseUnitsJson(result.data.stdout);
    if (input.pattern !== undefined && input.pattern !== '') {
      const needle = input.pattern.toLowerCase();
      units = units.filter((unit) => unit.unit.toLowerCase().includes(needle));
    }
    if (input.type !== undefined) {
      const suffix = `.${input.type}`;
      units = units.filter((unit) => unit.unit.endsWith(suffix));
    }
    units.sort((a, b) => a.unit.localeCompare(b.unit));

    const total = units.length;
    const page = units.slice(offset.data, offset.data + input.limit);
    const next = offset.data + page.length < total ? encodeCursor(offset.data + page.length) : null;

    return ok(
      toolData(
        page.map((unit) =>
          input.detail === 'detailed'
            ? {
                unit: unit.unit,
                active: unit.active,
                sub: unit.sub,
                load: unit.load,
                desc: unit.description.length > 60 ? unit.description.slice(0, 60) : unit.description,
              }
            : { unit: unit.unit, active: unit.active, sub: unit.sub },
        ),
        { total, cursor: next },
      ),
    );
  },
});

export const svcStatusTool = defineTool({
  name: 'svc_status',
  title: 'Unit status',
  description:
    'State, main PID, start time, restarts, memory, tasks and last error of one systemd unit. Use it before reading logs.',
  schema: z.object({
    unit: UnitInput,
    detail: z.enum(['concise', 'detailed']).default('concise').describe('detailed adds unit file state and fragment path'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(
      ctx.conn,
      [
        'systemctl',
        'show',
        input.unit,
        '-p',
        'LoadState',
        '-p',
        'ActiveState',
        '-p',
        'SubState',
        '-p',
        'MainPID',
        '-p',
        'ExecMainStartTimestamp',
        '-p',
        'NRestarts',
        '-p',
        'MemoryCurrent',
        '-p',
        'TasksCurrent',
        '-p',
        'UnitFileState',
        '-p',
        'FragmentPath',
        '-p',
        'ExecMainStatus',
        '-p',
        'Result',
        '-p',
        'ExecStart',
        '--no-pager',
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!result.ok) return result;

    const properties = parseShowProperties(result.data.stdout);
    if (properties.LoadState === 'not-found' || properties.ActiveState === undefined) {
      return err('E_NOTFOUND', `unit ${input.unit} not found`, 'list units with svc_list');
    }

    const data: Record<string, unknown> = {
      unit: input.unit,
      state: properties.ActiveState,
      sub: properties.SubState ?? undefined,
    };

    const pid = Number(properties.MainPID);
    if (Number.isInteger(pid) && pid > 0) data.main_pid = pid;
    const exec = /path=([^ ;]+)/.exec(properties.ExecStart ?? '');
    if (exec?.[1] !== undefined) data.exec = exec[1];

    const restarts = Number(properties.NRestarts);
    if (Number.isInteger(restarts) && restarts >= 0) data.restarts = restarts;
    const memory = Number(properties.MemoryCurrent);
    if (Number.isInteger(memory) && memory >= 0) data.mem_b = memory;
    const tasks = Number(properties.TasksCurrent);
    if (Number.isInteger(tasks) && tasks >= 0) data.tasks = tasks;

    const since = isoFromSystemdStamp(properties.ExecMainStartTimestamp ?? '');
    if (since !== undefined) data.since = since;

    const exitStatus = properties.ExecMainStatus;
    if (
      properties.Result !== undefined &&
      (properties.Result !== 'success' || (exitStatus !== undefined && exitStatus !== '0'))
    ) {
      data.last_error = `${properties.Result}(${exitStatus ?? '?'})`;
    }

    if (input.detail === 'detailed') {
      if (properties.UnitFileState !== undefined) data.unit_file = properties.UnitFileState;
      if (properties.FragmentPath !== undefined && properties.FragmentPath !== '') {
        data.fragment = properties.FragmentPath;
      }
    }

    return ok(toolData(data));
  },
});

export const svcFailedTool = defineTool({
  name: 'svc_failed',
  title: 'Failed units',
  description:
    'Failed systemd units with their last error lines. Answers "why did it fail?" without pulling the whole journal.',
  schema: z.object({
    lines: z.number().int().min(1).max(50).default(10).describe('Journal lines per unit'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const failed = await runCommand(
      ctx.conn,
      ['systemctl', 'list-units', '--failed', '--output=json', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!failed.ok) return failed;

    const units = parseUnitsJson(failed.data.stdout).slice(0, 5);
    if (units.length === 0) return ok(toolData({ count: 0, units: [] }));

    const details = new Map<string, { since?: string; exit?: string }>();
    const show = await runCommand(
      ctx.conn,
      [
        'systemctl',
        'show',
        ...units.map((unit) => unit.unit),
        '-p',
        'Id',
        '-p',
        'StateChangeTimestamp',
        '-p',
        'InactiveEnterTimestamp',
        '-p',
        'Result',
        '-p',
        'ExecMainStatus',
        '--no-pager',
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (show.ok) {
      for (const block of parseShowBlocks(show.data.stdout)) {
        const detail = failedDetailFromBlock(block);
        if (detail === null) continue;
        details.set(detail.unit, detail);
      }
    }

    const output: Array<Record<string, unknown>> = [];
    for (const unit of units) {
      const detail = details.get(unit.unit);
      const log: string[] = [];
      const journal = await runCommand(
        ctx.conn,
        ['journalctl', '-u', unit.unit, '-n', String(input.lines), '-p', 'err', '--output=json', '--no-pager'],
        { timeoutMs: ctx.config.timeoutMs, maxBytes: 32_768 },
      );
      if (journal.ok) {
        for (const entry of parseJournalLines(journal.data.stdout).slice(-input.lines)) {
          log.push(entry.msg.length > 300 ? entry.msg.slice(0, 300) : entry.msg);
        }
      }
      output.push({
        unit: unit.unit,
        since: detail?.since,
        exit: detail?.exit,
        log,
      });
    }

    return ok(toolData({ count: output.length, units: output }));
  },
});

export const svcTimersTool = defineTool({
  name: 'svc_timers',
  title: 'Timers',
  description:
    'Systemd timers with next and last trigger times. Use it to see what runs next on the host.',
  schema: z.object({
    limit: z.number().int().min(1).max(100).default(50).describe('Timers per page'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(
      ctx.conn,
      ['systemctl', 'list-timers', '--all', '--output=json', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;

    const timers = parseTimersJson(result.data.stdout);
    timers.sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999'));
    const page = timers.slice(0, input.limit);
    return ok(
      toolData(
        page.map((timer) => ({
          unit: timer.unit,
          next: timer.next,
          last: timer.last,
          activates: timer.activates,
        })),
        { total: timers.length },
      ),
    );
  },
});

export const svcUnitFileTool = defineTool({
  name: 'svc_unit_file',
  title: 'Unit file content',
  description:
    'Content of a unit file and its drop-ins, from the systemd directories only. Use it to see what a unit actually runs.',
  schema: z.object({
    unit: UnitInput,
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const show = await runCommand(
      ctx.conn,
      ['systemctl', 'show', input.unit, '-p', 'FragmentPath', '-p', 'DropInPaths', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!show.ok) return show;

    const properties = parseShowProperties(show.data.stdout);
    const fragment = properties.FragmentPath ?? '';
    if (fragment === '') {
      return err('E_NOTFOUND', `unit ${input.unit} has no fragment file`, 'it may be transient; use svc_status');
    }
    if (!isAllowedUnitPath(fragment)) {
      return err('E_POLICY', `refusing to read ${fragment}`, 'only systemd unit directories are readable');
    }

    const main = await readText(ctx, fragment);
    if (!main.ok) return main;

    const dropins: Array<Record<string, unknown>> = [];
    for (const path of (properties.DropInPaths ?? '').split(' ').filter((item) => item !== '')) {
      if (!isAllowedUnitPath(path)) continue;
      const content = await readText(ctx, path);
      if (!content.ok) continue;
      dropins.push(content.data);
    }

    return ok(toolData({ ...main.data, dropins }));
  },
});

async function readText(
  ctx: ToolContext,
  path: string,
): Promise<Result<{ path: string; content: string; truncated?: boolean }>> {
  const result = await runCommand(ctx.conn, ['cat', path], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 65_536,
  });
  if (!result.ok) return result;
  if (result.data.code !== 0) {
    return err('E_NOTFOUND', `cannot read ${path}`, result.data.stderr.trim() || 'permission denied');
  }
  const cut = result.data.stdout.length > MAX_UNIT_FILE_CHARS;
  return ok({
    path,
    content: cut ? result.data.stdout.slice(0, MAX_UNIT_FILE_CHARS) : result.data.stdout,
    ...(cut || result.data.truncated ? { truncated: true } : {}),
  });
}

function isAllowedUnitPath(path: string): boolean {
  return path.startsWith('/') && ALLOWED_UNIT_DIRS.some((dir) => path.startsWith(dir));
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

const ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'] as const;

/** Units whose restart can cut the only remote path into the host. */
const LOCKOUT_UNIT =
  /^(ssh|sshd|sshd@[^.]*|systemd-[^.]*|dbus|dbus-broker|systemd-logind|networkmanager)(\.(service|socket|timer|target|mount))?$/i;

export const svcActionTool = defineTool({
  name: 'svc_action',
  title: 'Change a unit state',
  description:
    'Start, stop, restart, reload, enable, disable, mask or unmask one unit after two-step confirmation. sshd, dbus and systemd units are refused.',
  schema: z.object({
    unit: UnitInput,
    action: z.enum(ACTIONS).describe('systemctl action'),
    dry_run: z.boolean().default(false).describe('Validate and preview without changing anything'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (LOCKOUT_UNIT.test(input.unit)) {
      return err('E_POLICY', `${input.unit} is critical: its ${input.action} can lock you out`, 'do it from the console');
    }
    if (input.dry_run) {
      return ok(
        toolData({
          unit: input.unit,
          action: input.action,
          result: 'dry_run',
          ...confirmationPayload('svc_action', input, ctx.config.confirmTtl),
        }),
      );
    }
    if (input.token === undefined) {
      return ok(
        toolData(
          confirmationPayload('svc_action', input, ctx.config.confirmTtl, {
            unit: input.unit,
            action: input.action,
            effect: `systemctl ${input.action} ${input.unit}`,
          }),
        ),
      );
    }
    const consumed = consumeConfirmation(input.token, 'svc_action', input);
    if (!consumed.ok) return consumed;

    const started = performance.now();
    const changed = await runCommand(ctx.conn, ['systemctl', input.action, input.unit], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!changed.ok) return changed;

    const state = await runCommand(
      ctx.conn,
      ['systemctl', 'show', input.unit, '-p', 'ActiveState', '-p', 'SubState', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    const properties = state.ok ? parseShowProperties(state.data.stdout) : {};
    const active = properties.ActiveState ?? 'unknown';
    const stderr = changed.data.stderr.trim();

    if (changed.data.code !== 0) {
      if (/access denied|permission|authentication|not permitted/i.test(stderr)) {
        return err('E_PERM', `systemctl ${input.action} ${input.unit} was denied`, stderr || 'check permissions');
      }
      if (active === 'failed') {
        // The action ran; the unit itself failed to start. That is an answer.
        return ok(
          toolData({
            unit: input.unit,
            action: input.action,
            active,
            sub: properties.SubState ?? 'failed',
            job_failed: true,
            error: firstLine(stderr),
            ms: Math.round(performance.now() - started),
          }),
        );
      }
      return err(
        'E_INTERNAL',
        `systemctl ${input.action} ${input.unit} failed`,
        stderr !== '' ? firstLine(stderr) : 'check the unit with svc_status',
      );
    }

    return ok(
      toolData({
        unit: input.unit,
        action: input.action,
        active,
        sub: properties.SubState,
        ms: Math.round(performance.now() - started),
      }),
    );
  },
});

export const svcDaemonReloadTool = defineTool({
  name: 'svc_daemon_reload',
  title: 'Reload systemd units',
  description:
    'Run systemctl daemon-reload after unit files changed, with two-step confirmation. Use it after writing a unit or drop-in.',
  schema: z.object({
    dry_run: z.boolean().default(false).describe('Preview without reloading'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.dry_run) {
      return ok(toolData({ result: 'dry_run', ...confirmationPayload('svc_daemon_reload', input, ctx.config.confirmTtl) }));
    }
    if (input.token === undefined) {
      return ok(
        toolData(
          confirmationPayload('svc_daemon_reload', input, ctx.config.confirmTtl, {
            effect: 'systemd re-reads unit files',
          }),
        ),
      );
    }
    const consumed = consumeConfirmation(input.token, 'svc_daemon_reload', input);
    if (!consumed.ok) return consumed;

    const result = await runCommand(ctx.conn, ['systemctl', 'daemon-reload'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;
    if (result.data.code !== 0) {
      return err('E_PERM', 'daemon-reload failed', result.data.stderr.trim() || 'check permissions');
    }
    return ok(toolData({ ok: true }));
  },
});
