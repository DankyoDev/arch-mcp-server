import { z } from 'zod';
import { percent, round1 } from '../core/format.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import type { SectionSpec } from '../exec/sequence.js';
import { parseDf, realMounts } from '../parse/df.js';
import {
  parseLscpuJson,
  parseMeminfo,
  parseOsRelease,
  parseThermalMax,
  parseUptimeSeconds,
} from '../parse/host.js';
import {
  parseDiskstats,
  parseLoadavg,
  parseNetDev,
  parseProcStat,
  parsePsOutput,
  parseTopOutput,
} from '../parse/proc.js';
import { parseUnitsJson } from '../parse/systemd.js';
import { confirmationPayload, consumeConfirmation } from '../policy/confirm.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const PS_COLUMNS = 'pid=,ppid=,user:16=,pcpu=,pmem=,rss=,stat=,etimes=,args=';

const SYS_INFO_SECTIONS: readonly SectionSpec[] = [
  { key: 'os', argv: ['cat', '/etc/os-release'] },
  { key: 'kernel', argv: ['uname', '-r'] },
  { key: 'arch', argv: ['uname', '-m'] },
  { key: 'hostname', argv: ['cat', '/proc/sys/kernel/hostname'] },
  { key: 'uptime', argv: ['cat', '/proc/uptime'] },
  { key: 'virt', argv: ['systemd-detect-virt'] },
  { key: 'meminfo', argv: ['cat', '/proc/meminfo'] },
  { key: 'cpu', argv: ['lscpu', '-J'] },
  { key: 'nproc', argv: ['nproc', '--all'] },
];

export const sysInfoTool = defineTool({
  name: 'sys_info',
  title: 'Host identity',
  description:
    'Host identity: hostname, kernel, distro, arch, uptime, virtualization, CPU cores and memory. Call it first to learn what host you are on.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (_input, ctx) => {
    const batch = await runSections(ctx.conn, SYS_INFO_SECTIONS, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 32_768,
    });
    if (!batch.ok) return batch;

    const os = parseOsRelease(batch.data.os?.stdout ?? '');
    const kernel = (batch.data.kernel?.stdout ?? '').trim();
    const arch = (batch.data.arch?.stdout ?? '').trim();
    const hostname = (batch.data.hostname?.stdout ?? '').trim();
    const mem = parseMeminfo(batch.data.meminfo?.stdout ?? '');
    const cpu = parseLscpuJson(batch.data.cpu?.stdout ?? '');

    if (kernel === '' && os.id === '') {
      return err('E_CONN', 'host returned no identity data', 'check SSH connectivity and permissions');
    }

    const virtRaw = (batch.data.virt?.stdout ?? '').trim();
    const cores = cpu.cores ?? positiveInt((batch.data.nproc?.stdout ?? '').trim());

    return ok(
      toolData({
        host: hostname !== '' ? hostname : undefined,
        kernel,
        distro: os.prettyName,
        arch,
        uptime_s: parseUptimeSeconds(batch.data.uptime?.stdout ?? ''),
        virt: virtRaw === '' ? 'unknown' : virtRaw,
        cpu: { cores, model: cpu.model },
        mem: {
          total_b: mem.totalB,
          avail_b: mem.availB,
          used_pct: percent(mem.totalB - mem.availB, mem.totalB),
        },
      }),
    );
  },
});

const SYS_STATUS_SECTIONS: readonly SectionSpec[] = [
  { key: 'loadavg', argv: ['cat', '/proc/loadavg'] },
  { key: 'meminfo', argv: ['cat', '/proc/meminfo'] },
  { key: 'df', argv: ['df', '-P', '-B1'] },
  { key: 'failed', argv: ['systemctl', 'list-units', '--failed', '--output=json', '--no-pager'] },
  { key: 'updates', argv: ['pacman', '-Qu'] },
  { key: 'reboot', argv: ['test', '-f', '/var/run/reboot-required'] },
  { key: 'thermal', argv: ['sh', '-c', 'cat /sys/class/thermal/thermal_zone*/temp'] },
  {
    key: 'top',
    argv: ['ps', '-e', '-o', 'pid=,comm=,pcpu=,pmem=', '--sort=-pcpu', '--no-headers'],
  },
];

export const sysStatusTool = defineTool({
  name: 'sys_status',
  title: 'Host health snapshot',
  description:
    'One call health snapshot: load, memory, disks, failed units, pending updates, reboot flag, max temperature and top processes. Use it to answer "is the server healthy?".',
  schema: z.object({
    detail: z.enum(['concise', 'detailed']).default('concise').describe('detailed adds PIDs and disk free bytes'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const batch = await runSections(ctx.conn, SYS_STATUS_SECTIONS, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!batch.ok) return batch;

    const mem = parseMeminfo(batch.data.meminfo?.stdout ?? '');
    const disks = realMounts(parseDf(batch.data.df?.stdout ?? ''));
    const failed = parseUnitsJson(batch.data.failed?.stdout ?? '');
    const updatesRaw = (batch.data.updates?.stdout ?? '').trim();
    const updatesExit = batch.data.updates?.code ?? 127;
    const tempMax = parseThermalMax(batch.data.thermal?.stdout ?? '');

    const top = parseTopOutput(batch.data.top?.stdout ?? '').slice(
      0,
      input.detail === 'detailed' ? 5 : 3,
    );

    const data: Record<string, unknown> = {
      load: parseLoadavg(batch.data.loadavg?.stdout ?? ''),
      mem: {
        used_pct: percent(mem.totalB - mem.availB, mem.totalB),
        avail_b: mem.availB,
      },
      swap: {
        used_pct: percent(mem.swapTotalB - mem.swapFreeB, mem.swapTotalB),
      },
      disks: disks.map((disk) => ({
        mount: disk.mount,
        use_pct: disk.usePct,
        ...(input.detail === 'detailed' ? { avail_b: disk.availB } : {}),
      })),
      failed_units: failed.length,
      reboot_required: batch.data.reboot?.code === 0,
    };
    if (updatesExit !== 127) data.updates = updatesRaw === '' ? 0 : updatesRaw.split('\n').length;
    if (tempMax !== null) data.temp_max_c = tempMax;
    data.top = top.map((row) => ({
      name: row.name,
      ...(input.detail === 'detailed' ? { pid: row.pid } : {}),
      cpu_pct: row.cpuPct,
      ...(input.detail === 'detailed' ? { mem_pct: row.memPct } : {}),
    }));
    return ok(toolData(data));
  },
});

const METRICS_SECTIONS: readonly SectionSpec[] = [
  { key: 'stat', argv: ['cat', '/proc/stat'] },
  { key: 'meminfo', argv: ['cat', '/proc/meminfo'] },
  { key: 'diskstats', argv: ['cat', '/proc/diskstats'] },
  { key: 'netdev', argv: ['cat', '/proc/net/dev'] },
];

interface MetricsSample {
  stat: ReturnType<typeof parseProcStat>;
  mem: ReturnType<typeof parseMeminfo>;
  disk: ReturnType<typeof parseDiskstats>;
  net: ReturnType<typeof parseNetDev>;
  at: number;
}

export const sysMetricsTool = defineTool({
  name: 'sys_metrics',
  title: 'CPU, IO and network rates',
  description:
    'Snapshot with deltas over window_ms: CPU per core, memory, swap, disk IO and network rates. Use it for utilisation questions that need a rate, not a counter.',
  schema: z.object({
    window_ms: z.number().int().min(300).max(3000).default(1000).describe('Sampling window in milliseconds'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const first = await sample(ctx);
    if (!first.ok) return first;
    await new Promise((resolve) => setTimeout(resolve, input.window_ms));
    const second = await sample(ctx);
    if (!second.ok) return second;

    const elapsedS = Math.max((second.data.at - first.data.at) / 1000, 0.001);
    const totalDelta = second.data.stat.total - first.data.stat.total;
    const idleDelta = second.data.stat.idle - first.data.stat.idle;
    const cpuTotal = totalDelta > 0 ? round1((1 - idleDelta / totalDelta) * 100) : 0;

    const coreCount = Math.min(second.data.stat.cores.length, first.data.stat.cores.length);
    const cores: number[] = [];
    for (let index = 0; index < coreCount; index += 1) {
      const a = first.data.stat.cores[index];
      const b = second.data.stat.cores[index];
      if (a === undefined || b === undefined) continue;
      const total = b.total - a.total;
      const idle = b.idle - a.idle;
      cores.push(total > 0 ? round1((1 - idle / total) * 100) : 0);
    }

    const mem = second.data.mem;
    return ok(
      toolData({
        cpu_total_pct: cpuTotal,
        cpu_core_pct: cores,
        mem: {
          used_pct: percent(mem.totalB - mem.availB, mem.totalB),
          avail_b: mem.availB,
        },
        swap: { used_pct: percent(mem.swapTotalB - mem.swapFreeB, mem.swapTotalB) },
        io: {
          read_bps: Math.max(0, Math.round((second.data.disk.readB - first.data.disk.readB) / elapsedS)),
          write_bps: Math.max(0, Math.round((second.data.disk.writeB - first.data.disk.writeB) / elapsedS)),
        },
        net: {
          rx_bps: Math.max(0, Math.round((second.data.net.rxB - first.data.net.rxB) / elapsedS)),
          tx_bps: Math.max(0, Math.round((second.data.net.txB - first.data.net.txB) / elapsedS)),
        },
        window_ms: input.window_ms,
      }),
    );
  },
});

export const procListTool = defineTool({
  name: 'proc_list',
  title: 'Process list',
  description:
    'Processes filtered and sorted by CPU, memory or PID. Use it to find what consumes resources; rss is in bytes.',
  schema: z.object({
    filter: z.string().max(128).optional().describe('Case-insensitive substring of the command or user'),
    sort: z.enum(['cpu', 'mem', 'pid']).default('cpu').describe('Sort field'),
    limit: z.number().int().min(1).max(50).default(20).describe('Rows per page'),
    detail: z.enum(['concise', 'detailed']).default('concise').describe('detailed adds ppid, rss, state and uptime'),
    cursor: z.string().max(64).optional().describe('Cursor from a previous call'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const offset = decodeCursor(input.cursor);
    if (!offset.ok) return offset;

    const result = await runCommand(
      ctx.conn,
      ['ps', '-e', '-o', PS_COLUMNS, '--sort=-pcpu', '--no-headers'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'process table exceeded the read cap', 'narrow with filter');
    }

    let rows = parsePsOutput(result.data.stdout);
    if (input.filter !== undefined && input.filter !== '') {
      const needle = input.filter.toLowerCase();
      rows = rows.filter(
        (row) => row.cmd.toLowerCase().includes(needle) || row.user.toLowerCase().includes(needle),
      );
    }
    rows.sort((a, b) => {
      if (input.sort === 'pid') return a.pid - b.pid;
      if (input.sort === 'mem') return b.memPct - a.memPct || a.pid - b.pid;
      return b.cpuPct - a.cpuPct || a.pid - b.pid;
    });

    const total = rows.length;
    const page = rows.slice(offset.data, offset.data + input.limit);
    const next = offset.data + page.length < total ? encodeCursor(offset.data + page.length) : null;

    return ok(
      toolData(
        page.map((row) =>
          input.detail === 'detailed'
            ? {
                pid: row.pid,
                user: row.user,
                cpu: row.cpuPct,
                mem: row.memPct,
                rss_b: row.rssB,
                state: row.state,
                ppid: row.ppid,
                uptime_s: row.uptimeS,
                cmd: row.cmd,
              }
            : {
                pid: row.pid,
                user: row.user,
                cpu: row.cpuPct,
                mem: row.memPct,
                cmd: row.cmd.length > 80 ? row.cmd.slice(0, 80) : row.cmd,
              },
        ),
        { total, cursor: next },
      ),
    );
  },
});

const SIGNALS = ['TERM', 'KILL', 'HUP', 'INT', 'QUIT', 'USR1', 'USR2', 'STOP', 'CONT'] as const;
export const procKillTool = defineTool({
  name: 'proc_kill',
  title: 'Signal a process',
  description:
    'Send a signal to a process after two-step confirmation. Never kills PID 1; use dry_run to preview without sending anything.',
  schema: z.object({
    pid: z.number().int().min(2).max(4_194_304).describe('Process ID (1 is always refused)'),
    signal: z.enum(SIGNALS).default('TERM').describe('Signal name'),
    dry_run: z.boolean().default(false).describe('Validate and preview without signalling'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.pid === 1) {
      return err('E_POLICY', 'PID 1 is never signalled', 'restart the service with svc_action instead');
    }

    const exists = await runCommand(ctx.conn, ['kill', '-0', String(input.pid)], {
      timeoutMs: ctx.config.timeoutMs,
    });
    if (!exists.ok) return exists;
    if (exists.data.code !== 0) {
      return err('E_NOTFOUND', `no process with PID ${input.pid}`, 'list processes with proc_list');
    }

    if (input.dry_run) {
      return ok(
        toolData({
          pid: input.pid,
          signal: input.signal,
          result: 'dry_run',
          ...confirmationPayload('proc_kill', input, ctx.config.confirmTtl),
        }),
      );
    }

    if (input.token === undefined) {
      return ok(
        toolData(
          confirmationPayload('proc_kill', input, ctx.config.confirmTtl, {
            pid: input.pid,
            signal: input.signal,
            effect: `PID ${input.pid} receives SIG${input.signal}`,
          }),
        ),
      );
    }

    const consumed = consumeConfirmation(input.token, 'proc_kill', input);
    if (!consumed.ok) return consumed;

    const sent = await runCommand(ctx.conn, ['kill', '-s', input.signal, String(input.pid)], {
      timeoutMs: ctx.config.timeoutMs,
    });
    if (!sent.ok) return sent;
    if (sent.data.code !== 0) {
      return err('E_PERM', `cannot signal PID ${input.pid}`, sent.data.stderr.trim() || 'check permissions');
    }
    return ok(toolData({ pid: input.pid, signal: input.signal, result: 'sent' }));
  },
});

async function sample(ctx: ToolContext): Promise<Result<MetricsSample>> {
  const at = performance.now();
  const batch = await runSections(ctx.conn, METRICS_SECTIONS, {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 262_144,
  });
  if (!batch.ok) return batch;
  return ok({
    stat: parseProcStat(batch.data.stat?.stdout ?? ''),
    mem: parseMeminfo(batch.data.meminfo?.stdout ?? ''),
    disk: parseDiskstats(batch.data.diskstats?.stdout ?? ''),
    net: parseNetDev(batch.data.netdev?.stdout ?? ''),
    at,
  });
}

function positiveInt(text: string): number | undefined {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export const sysServicesSummaryTool = defineTool({
  name: 'sys_services_summary',
  title: 'Units by state',
  description:
    'Counts of systemd units by state (total, running, failed, inactive). Use it when you only need the numbers, not the list.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const result = await runCommand(
      ctx.conn,
      ['systemctl', 'list-units', '--all', '--output=json', '--no-pager'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;

    const units = parseUnitsJson(result.data.stdout);
    let running = 0;
    let failed = 0;
    for (const unit of units) {
      if (unit.active === 'active') running += 1;
      if (unit.active === 'failed') failed += 1;
    }
    return ok(
      toolData({
        total: units.length,
        running,
        failed,
        inactive: units.length - running - failed,
      }),
    );
  },
});
