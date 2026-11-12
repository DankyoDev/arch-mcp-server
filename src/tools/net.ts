import { z } from 'zod';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import {
  parseGetentHosts,
  parseIpAddr,
  parseIpRoute,
  parseIptablesRules,
  parseNmcliWifi,
  parseNftRuleset,
  parseResolvConf,
  parseSsConns,
  parseSsPorts,
  splitAddress,
} from '../parse/net.js';
import { defineTool, toolData } from './registry.js';
import { requireFeature } from './guards.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const netStatusTool = defineTool({
  name: 'net_status',
  title: 'Network status',
  description:
    'Interfaces with their IPs, the default route and the DNS resolvers. Link-local IPv6 addresses are omitted.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const batch = await runSections(
      ctx.conn,
      [
        { key: 'addr', argv: ['ip', '-j', 'addr'] },
        { key: 'route', argv: ['ip', '-j', 'route'] },
        { key: 'resolv', argv: ['cat', '/etc/resolv.conf'] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!batch.ok) return batch;

    const ifaces = parseIpAddr(batch.data.addr?.stdout ?? '')
      .filter((iface) => iface.name !== 'lo' && (iface.state === 'UP' || iface.addrs.length > 0))
      .map((iface) => ({
        name: iface.name,
        state: iface.state,
        mac: iface.mac,
        addrs: iface.addrs
          .filter((addr) => !addr.ip.startsWith('fe80::'))
          .map((addr) => `${addr.ip}/${addr.prefix}`),
      }));

    return ok(
      toolData({
        ifaces,
        default_route: parseIpRoute(batch.data.route?.stdout ?? ''),
        dns: parseResolvConf(batch.data.resolv?.stdout ?? ''),
      }),
    );
  },
});

export const netPortsTool = defineTool({
  name: 'net_ports',
  title: 'Listening ports',
  description:
    'Listening TCP/UDP ports with the owning process. Answers "is the port up?" and "who holds it?".',
  schema: z.object({
    port: z.number().int().min(1).max(65535).optional().describe('Only this port'),
    proto: z.enum(['tcp', 'udp', 'all']).default('all').describe('Protocol filter'),
    limit: z.number().int().min(1).max(100).default(50).describe('Ports per page'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'iproute2', 'install iproute2 (ss)');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['ss', '-tulnpH'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;

    let ports = parseSsPorts(result.data.stdout);
    if (input.proto !== 'all') ports = ports.filter((row) => row.proto === input.proto);
    if (input.port !== undefined) ports = ports.filter((row) => row.port === input.port);
    ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));

    return ok(toolData(ports.slice(0, input.limit), { total: ports.length }));
  },
});

export const netConnsTool = defineTool({
  name: 'net_conns',
  title: 'Established connections',
  description:
    'Established connections grouped by process. Use it to see who talks to whom without listing every socket.',
  schema: z.object({
    port: z.number().int().min(1).max(65535).optional().describe('Only connections on this port'),
    limit: z.number().int().min(1).max(50).default(20).describe('Process groups per page'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'iproute2', 'install iproute2 (ss)');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['ss', '-tunapH', 'state', 'established'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;

    let rows = parseSsConns(result.data.stdout);
    if (input.port !== undefined) {
      rows = rows.filter((row) => {
        const local = splitAddress(row.local);
        const peer = splitAddress(row.peer);
        return local?.port === input.port || peer?.port === input.port;
      });
    }

    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.proc ?? 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const byProc = [...counts.entries()]
      .map(([proc, count]) => ({ proc, count }))
      .sort((a, b) => b.count - a.count || a.proc.localeCompare(b.proc))
      .slice(0, input.limit);

    return ok(toolData({ count: rows.length, by_proc: byProc }));
  },
});

export const netCheckTool = defineTool({
  name: 'net_check',
  title: 'TCP reachability check',
  description:
    'Open a TCP connection from the host to host:port and report success and latency. Use it to check that an endpoint is reachable from the server, not from your laptop.',
  schema: z.object({
    target: z.string().min(1).max(300).describe('host:port, [ipv6]:port, or host (port 443)'),
    timeout_ms: z.number().int().min(200).max(30_000).default(5000).describe('Connect timeout'),
  }),
  annotations: OPEN,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const parsed = parseTarget(input.target);
    if (!parsed.ok) return parsed;

    const timeoutS = Math.max(1, Math.ceil(input.timeout_ms / 1000));
    const result = await runCommand(
      ctx.conn,
      [
        'timeout',
        String(timeoutS),
        'bash',
        '-c',
        'exec 3<>/dev/tcp/"$1"/"$2"',
        '_',
        parsed.data.host,
        String(parsed.data.port),
      ],
      { timeoutMs: input.timeout_ms + 2000 },
    );
    if (!result.ok) return result;

    if (result.data.code === 0) {
      return ok(toolData({ ok: true, ms: result.data.ms }));
    }
    const stderr = result.data.stderr.trim().split('\n')[0] ?? '';
    return ok(
      toolData({
        ok: false,
        ms: result.data.ms,
        error: result.data.code === 124 ? 'timeout' : stderr.length > 160 ? stderr.slice(0, 160) : stderr,
      }),
    );
  },
});

export const netDnsTool = defineTool({  name: 'net_dns',
  title: 'Resolve a name',
  description:
    'Resolve a hostname through the host resolver and return the addresses plus the configured nameservers.',
  schema: z.object({
    name: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9._-]+$/, 'not a valid hostname')
      .describe('Hostname to resolve'),
    type: z.enum(['A', 'AAAA', 'any']).default('A').describe('Address family'),
  }),
  annotations: OPEN,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const batch = await runSections(
      ctx.conn,
      [
        { key: 'hosts', argv: ['getent', 'ahosts', input.name] },
        { key: 'resolv', argv: ['cat', '/etc/resolv.conf'] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!batch.ok) return batch;

    const all = parseGetentHosts(batch.data.hosts?.stdout ?? '');
    const answers = all.filter((ip) => {
      if (input.type === 'A') return !ip.includes(':');
      if (input.type === 'AAAA') return ip.includes(':');
      return true;
    });
    const resolver = parseResolvConf(batch.data.resolv?.stdout ?? '')[0];

    return ok(toolData({ name: input.name, answers, resolver: resolver ?? null }));
  },
});

function parseTarget(target: string): Result<{ host: string; port: number }> {  const bracket = /^\[([0-9A-Fa-f:]+)\]:(\d{1,5})$/.exec(target);
  if (bracket !== null) {
    const host = bracket[1];
    const port = Number(bracket[2]);
    if (host !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return ok({ host, port });
    }
  }

  const withoutPort = target.split(':');
  let host = target;
  let port = 443;
  if (withoutPort.length === 2) {
    host = withoutPort[0] ?? '';
    port = Number(withoutPort[1]);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return err('E_POLICY', 'target must be host:port or host', 'example: db.internal:5432');
  }
  return ok({ host, port });
}

export const netWifiTool = defineTool({
  name: 'net_wifi',
  title: 'Wi-Fi state',
  description:
    'SSID, signal, rate and security of the active Wi-Fi link via nmcli. Requires NetworkManager.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const guard = await requireFeature(ctx, 'network_manager', 'install NetworkManager (nmcli) or use net_status');
    if (!guard.ok) return guard;

    const result = await runCommand(
      ctx.conn,
      ['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,RATE,SECURITY', 'dev', 'wifi'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!result.ok) return result;
    if (result.data.code !== 0) {
      const stderr = result.data.stderr.trim().split('\n')[0] ?? '';
      return err(
        'E_UNSUPPORTED',
        'nmcli is installed but NetworkManager is not answering',
        stderr !== '' ? stderr : 'start NetworkManager or use net_status',
      );
    }

    const wifi = parseNmcliWifi(result.data.stdout);
    return ok(toolData(wifi ?? { connected: false }));
  },
});

export const netFirewallTool = defineTool({
  name: 'net_firewall',
  title: 'Firewall rules',
  description:
    'Firewall backend, default input policy and rule count from nftables or iptables. Use it to check whether the host filters traffic.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;
    const features = capabilities.data.features;

    if (features.nftables === true) {
      const result = await runCommand(ctx.conn, ['nft', '-j', 'list', 'ruleset'], {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 262_144,
      });
      if (!result.ok) return result;
      return ok(toolData(parseNftRuleset(result.data.stdout)));
    }
    if (features.iptables === true) {
      const result = await runCommand(ctx.conn, ['iptables', '-S'], {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 262_144,
      });
      if (!result.ok) return result;
      return ok(toolData(parseIptablesRules(result.data.stdout)));
    }
    return err('E_UNSUPPORTED', 'no nftables or iptables found', 'install nftables or iptables');
  },
});
