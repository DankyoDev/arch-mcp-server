import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, mapCommandError, MUTATE, READ, runChecked } from './ops.js';
import { isForbiddenWrite, validateSafePath } from './paths.js';

const URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const HOST_PATTERN = /^[A-Za-z0-9_.:[\]-]{1,253}$/;
const IFACE_PATTERN = /^[A-Za-z0-9_.@:-]{1,64}$/;
const IP_PATTERN = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;
const NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

const ConfirmInput = {
  dry_run: z.boolean().default(false).describe('Preview without touching the host'),
  token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
};

async function sha256Of(ctx: ToolContext, path: string): Promise<string | undefined> {
  const result = await runCommand(ctx.conn, ['sha256sum', path], { timeoutMs: ctx.config.timeoutMs, maxBytes: 4096 });
  if (!result.ok || result.data.code !== 0) return undefined;
  return (result.data.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase() || undefined;
}

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  title: 'Download a URL',
  description:
    'Download an http(s) URL to a file with curl/wget, size cap and optional sha256 verification. Two-step confirmation.',
  schema: z.object({
    url: z.string().max(4096).regex(URL_PATTERN, 'expected an http(s) URL').describe('URL to download'),
    path: z.string().min(1).max(4096).describe('Absolute destination file'),
    max_bytes: z.number().int().min(1024).max(2_147_483_648).default(104_857_600).describe('Size cap'),
    timeout_ms: z.number().int().min(1000).max(600_000).default(120_000).describe('Timeout'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'expected 64 hex characters').optional().describe('Expected sha256'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    if (isForbiddenWrite(path.data)) {
      return err('E_POLICY', 'refusing to write a system or credential path', 'download into /tmp or a user directory');
    }
    const capabilities = await ctx.capabilities();
    const curl = capabilities.ok ? capabilities.data.tools.curl : undefined;
    const wget = capabilities.ok ? capabilities.data.tools.wget : undefined;
    const downloader = curl ?? wget;
    if (downloader === undefined) {
      return err('E_UNSUPPORTED', 'curl and wget are missing', 'install curl or wget');
    }
    const usingCurl = curl !== undefined;
    return confirmed(
      ctx,
      'fetch_url',
      input as never,
      { url: input.url, path: path.data, max_bytes: input.max_bytes },
      async () => {
        const seconds = String(Math.ceil(input.timeout_ms / 1000));
        const argv = usingCurl
          ? [
              'curl',
              '-fL',
              '--proto',
              '=http,https',
              '--max-time',
              seconds,
              '--max-filesize',
              String(input.max_bytes),
              '-o',
              path.data,
              '--',
              input.url,
            ]
          : [
              'wget',
              '-q',
              '-O',
              path.data,
              '--timeout',
              seconds,
              '--max-filesize',
              String(input.max_bytes),
              input.url,
            ];
        const result = await runCommand(ctx.conn, argv, {
          timeoutMs: input.timeout_ms,
          maxBytes: 4096,
        });
        if (!result.ok) return result;
        if (result.data.code !== 0) {
          return { ok: false, error: mapCommandError(result.data.stderr, 'download failed') };
        }
        const size = await runCommand(ctx.conn, ['stat', '-c', '%s', path.data], {
          timeoutMs: ctx.config.timeoutMs,
          maxBytes: 1024,
        });
        const bytes = size.ok && size.data.code === 0 ? Number(size.data.stdout.trim()) : 0;
        const actual = input.sha256 === undefined ? undefined : await sha256Of(ctx, path.data);
        if (input.sha256 !== undefined && actual !== input.sha256.toLowerCase()) {
          return err('E_PARSE', 'sha256 mismatch', `expected ${input.sha256}, got ${actual ?? 'unknown'}`);
        }
        return ok(
          toolData({
            url: input.url,
            path: path.data,
            bytes: Number.isFinite(bytes) ? bytes : 0,
            ...(actual === undefined ? {} : { sha256: actual }),
          }),
        );
      },
    );
  },
});

export const httpCheckTool = defineTool({
  name: 'http_check',
  title: 'Check an HTTP endpoint',
  description: 'Request one http(s) URL and return status, latency and downloaded bytes. Read-only.',
  schema: z.object({
    url: z.string().max(4096).regex(URL_PATTERN, 'expected an http(s) URL').describe('URL to request'),
    method: z.enum(['GET', 'HEAD']).default('HEAD').describe('HTTP method'),
    timeout_ms: z.number().int().min(1000).max(60_000).default(10_000).describe('Timeout'),
    expect_status: z.number().int().min(100).max(599).optional().describe('Expected status code'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok || capabilities.data.tools.curl === undefined) {
      return err('E_UNSUPPORTED', 'curl is missing', 'install curl');
    }
    const result = await runCommand(
      ctx.conn,
      [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code} %{time_total} %{size_download}',
        '-X',
        input.method,
        '--max-time',
        String(Math.ceil(input.timeout_ms / 1000)),
        '--',
        input.url,
      ],
      { timeoutMs: input.timeout_ms + 2000, maxBytes: 4096 },
    );
    if (!result.ok) return result;
    if (result.data.code !== 0) {
      const code = result.data.code;
      return {
        ok: false,
        error: {
          code: code === 6 || code === 7 ? 'E_CONN' : code === 28 ? 'E_TIMEOUT' : 'E_INTERNAL',
          message: (result.data.stderr.trim().split('\n')[0] ?? 'request failed').slice(0, 200),
          hint: 'check the URL and network',
        },
      };
    }
    const [statusText, timeText, sizeText] = result.data.stdout.trim().split(/\s+/);
    const status = Number(statusText);
    const seconds = Number(timeText);
    const bytes = Number(sizeText);
    if (!Number.isInteger(status) || !Number.isFinite(seconds)) {
      return err('E_PARSE', 'unexpected curl output', 'retry the request');
    }
    const expected = input.expect_status;
    return ok(
      toolData({
        url: input.url,
        method: input.method,
        status,
        ms: Math.round(seconds * 1000),
        bytes: Number.isFinite(bytes) ? bytes : 0,
        ok: expected === undefined ? status < 400 : status === expected,
        ...(expected === undefined ? {} : { expected }),
      }),
    );
  },
});

export const netPingTool = defineTool({
  name: 'net_ping',
  title: 'Ping a host',
  description: 'ICMP ping with packet loss and rtt min/avg/max. Read-only.',
  schema: z.object({
    host: z.string().max(253).regex(HOST_PATTERN, 'expected a host or IP').describe('Host or IP'),
    count: z.number().int().min(1).max(10).default(4).describe('Packets'),
    timeout_ms: z.number().int().min(1000).max(60_000).default(10_000).describe('Total timeout'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    if (input.host.startsWith('-')) {
      return err('E_POLICY', 'host must not start with a dash', 'pass a host name or IP');
    }
    const perPacket = Math.max(1, Math.ceil(input.timeout_ms / 1000 / input.count));
    const result = await runCommand(
      ctx.conn,
      ['ping', '-c', String(input.count), '-W', String(perPacket), input.host],
      { timeoutMs: input.timeout_ms + 2000, maxBytes: 16_384 },
    );
    if (!result.ok) return result;
    if (result.data.code === 127) {
      return err('E_UNSUPPORTED', 'ping is missing', 'install iputils');
    }
    const text = result.data.stdout;
    const packets = /(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received/.exec(text);
    const rtt = /rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/[\d.]+ ms/.exec(text);
    if (packets === null) {
      if (result.data.code !== 0) {
        return { ok: false, error: mapCommandError(result.data.stderr, 'ping failed') };
      }
      return err('E_PARSE', 'unexpected ping output', 'check the host name');
    }
    const sent = Number(packets[1]);
    const received = Number(packets[2]);
    return ok(
      toolData({
        host: input.host,
        sent,
        received,
        loss_pct: sent === 0 ? 100 : Math.round(((sent - received) / sent) * 100),
        rtt_ms:
          rtt === null
            ? null
            : { min: Number(rtt[1]), avg: Number(rtt[2]), max: Number(rtt[3]) },
      }),
    );
  },
});

export const procReniceTool = defineTool({
  name: 'proc_renice',
  title: 'Change process priority',
  description: 'Change the nice value of one process after two-step confirmation. Negative values need root.',
  schema: z.object({
    pid: z.number().int().min(1).max(4_194_304).describe('Process id'),
    nice: z.number().int().min(-20).max(19).describe('Nice value (-20 highest, 19 lowest)'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) =>
    confirmed(ctx, 'proc_renice', input as never, { pid: input.pid, nice: input.nice }, async () => {
      const result = await runChecked(ctx, ['renice', '-n', String(input.nice), '-p', String(input.pid)]);
      if (!result.ok) return result;
      return ok(toolData({ pid: input.pid, nice: input.nice }));
    }),
});

export const usrActionTool = defineTool({
  name: 'usr_action',
  title: 'Manage a local user or group',
  description:
    'Create, delete, lock or unlock a user, or add a group. Two-step confirmation; refuses root and the MCP user.',
  schema: z.object({
    action: z.enum(['create', 'delete', 'lock', 'unlock', 'group_add']).describe('Operation'),
    name: z.string().max(32).regex(NAME_PATTERN, 'expected a lowercase user or group name').describe('User or group name'),
    shell: z
      .enum(['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/sbin/nologin', '/usr/sbin/nologin'])
      .default('/bin/bash')
      .describe('Login shell for create'),
    groups: z.array(z.string().max(32).regex(NAME_PATTERN)).max(16).default([]).describe('Supplementary groups'),
    home: z.string().min(1).max(4096).optional().describe('Home directory for create'),
    remove_home: z.boolean().default(false).describe('Delete the home directory too'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.name === 'root' || input.name === ctx.config.user) {
      return err('E_POLICY', 'refusing to modify root or the MCP user', 'use the console for that account');
    }
    if (input.home !== undefined) {
      const home = validateSafePath(input.home);
      if (!home.ok) return home;
    }
    return confirmed(
      ctx,
      'usr_action',
      input as never,
      { action: input.action, name: input.name },
      async () => {
        let argv: string[];
        switch (input.action) {
          case 'create':
            argv = [
              'useradd',
              '-m',
              '-s',
              input.shell,
              ...(input.groups.length > 0 ? ['-G', input.groups.join(',')] : []),
              ...(input.home === undefined ? [] : ['-d', input.home]),
              input.name,
            ];
            break;
          case 'delete':
            argv = ['userdel', ...(input.remove_home ? ['-r'] : []), input.name];
            break;
          case 'lock':
            argv = ['usermod', '-L', input.name];
            break;
          case 'unlock':
            argv = ['usermod', '-U', input.name];
            break;
          case 'group_add':
            argv = ['groupadd', input.name];
            break;
          default:
            return err('E_INTERNAL', 'unknown action', 'use create, delete, lock, unlock or group_add');
        }
        const result = await runChecked(ctx, argv);
        if (!result.ok) {
          if (input.action === 'unlock' && /passwordless/i.test(result.error.message)) {
            return err('E_POLICY', 'user has no password to unlock', 'set one with passwd first');
          }
          return result;
        }
        return ok(toolData({ action: input.action, name: input.name }));
      },
    );
  },
});

export const netDnsSetTool = defineTool({
  name: 'net_dns_set',
  title: 'Set DNS servers for an interface',
  description:
    'Set DNS servers on one interface with resolvectl and flush the cache. Two-step confirmation; needs systemd-resolved.',
  schema: z.object({
    interface: z.string().max(64).regex(IFACE_PATTERN, 'expected an interface').describe('Interface'),
    servers: z
      .array(z.string().max(64).regex(IP_PATTERN, 'expected an IP'))
      .min(1)
      .max(3)
      .describe('DNS servers'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;
    if (capabilities.data.tools.resolvectl === undefined) {
      return err('E_UNSUPPORTED', 'resolvectl is missing', 'install systemd-resolved or edit /etc/resolv.conf manually');
    }
    return confirmed(
      ctx,
      'net_dns_set',
      input as never,
      { interface: input.interface, servers: input.servers },
      async () => {
        const result = await runChecked(ctx, ['resolvectl', 'dns', input.interface, ...input.servers]);
        if (!result.ok) return result;
        await runChecked(ctx, ['resolvectl', 'flush-caches']);
        return ok(toolData({ interface: input.interface, servers: input.servers }));
      },
    );
  },
});

export const netRouteTool = defineTool({  name: 'net_route',
  title: 'Add or delete a route',
  description: 'Add or delete a static route with ip route. Two-step confirmation; refuses default routes.',
  schema: z.object({
    action: z.enum(['add', 'delete']).describe('Add or delete'),
    destination: z.string().max(64).regex(IP_PATTERN, 'expected an IP or CIDR').describe('Destination'),
    via: z.string().max(64).regex(IP_PATTERN, 'expected an IP').optional().describe('Gateway'),
    dev: z.string().max(64).regex(IFACE_PATTERN, 'expected an interface').optional().describe('Interface'),
    metric: z.number().int().min(0).max(65535).optional().describe('Route metric'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.destination === 'default' || input.destination === '0.0.0.0/0' || input.destination === '::/0') {
      return err('E_POLICY', 'refusing to change the default route', 'target a specific prefix');
    }
    if (input.dev !== undefined && input.dev.startsWith('-')) {
      return err('E_POLICY', 'interface must not start with a dash', 'pass a real interface name');
    }
    return confirmed(
      ctx,
      'net_route',
      input as never,
      { action: input.action, destination: input.destination, via: input.via ?? null, dev: input.dev ?? null },
      async () => {
        const argv = [
          'ip',
          'route',
          input.action,
          input.destination,
          ...(input.via === undefined ? [] : ['via', input.via]),
          ...(input.dev === undefined ? [] : ['dev', input.dev]),
          ...(input.metric === undefined ? [] : ['metric', String(input.metric)]),
        ];
        const result = await runChecked(ctx, argv);
        if (!result.ok) return result;
        return ok(toolData({ action: input.action, destination: input.destination }));
      },
    );
  },
});

export const fwRuleTool = defineTool({
  name: 'fw_rule',
  title: 'Allow or deny a port',
  description:
    'Allow, deny or delete a port rule with ufw or firewalld. Two-step confirmation; nftables stays read-only.',
  schema: z.object({
    action: z.enum(['allow', 'deny', 'delete']).describe('Rule operation'),
    port: z.number().int().min(1).max(65535).describe('Port'),
    protocol: z.enum(['tcp', 'udp']).default('tcp').describe('Protocol'),
    source: z.string().max(64).regex(IP_PATTERN, 'expected an IP or CIDR').optional().describe('Source address'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;
    const ufw = capabilities.data.tools.ufw !== undefined;
    const firewalld = capabilities.data.tools['firewall-cmd'] !== undefined;
    if (!ufw && !firewalld) {
      return err(
        'E_UNSUPPORTED',
        'neither ufw nor firewalld is installed',
        'install one, or edit nftables with exec/net_firewall',
      );
    }
    if (firewalld && input.source !== undefined) {
      return err('E_UNSUPPORTED', 'source rules need ufw', 'use ufw or a firewalld rich rule manually');
    }
    return confirmed(
      ctx,
      'fw_rule',
      input as never,
      {
        backend: ufw ? 'ufw' : 'firewalld',
        action: input.action,
        port: input.port,
        protocol: input.protocol,
        source: input.source ?? null,
      },
      async () => {
        if (ufw) {
          const rule = input.source === undefined
            ? [`${input.port}/${input.protocol}`]
            : ['from', input.source, 'to', 'any', 'port', String(input.port), 'proto', input.protocol];
          const argv = input.action === 'delete'
            ? ['ufw', 'delete', 'allow', ...rule]
            : ['ufw', input.action, ...rule];
          const result = await runChecked(ctx, argv);
          if (!result.ok) return result;
          return ok(toolData({ backend: 'ufw', action: input.action, port: input.port }));
        }
        const portRule = `${input.port}/${input.protocol}`;
        const first = input.action === 'delete' ? '--remove-port' : '--add-port';
        const result = await runChecked(ctx, ['firewall-cmd', '--permanent', `${first}=${portRule}`]);
        if (!result.ok) return result;
        const reload = await runChecked(ctx, ['firewall-cmd', '--reload']);
        if (!reload.ok) return reload;
        return ok(toolData({ backend: 'firewalld', action: input.action, port: input.port }));
      },
    );
  },
});
