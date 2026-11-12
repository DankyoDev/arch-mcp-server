export interface IfaceAddress {
  ip: string;
  prefix: number;
  scope: string;
}

export interface Iface {
  name: string;
  state: string;
  mac?: string;
  addrs: IfaceAddress[];
}

/** `ip -j addr` (link + addr_info, abbreviated keys as the tool emits them). */
export function parseIpAddr(text: string): Iface[] {
  const parsed = parseJsonArray(text);
  const ifaces: Iface[] = [];
  for (const entry of parsed) {
    const name = asString(entry.ifname);
    if (name === undefined) continue;
    const iface: Iface = { name, state: asString(entry.operstate) ?? '', addrs: [] };
    const mac = asString(entry.address);
    if (mac !== undefined && mac !== '00:00:00:00:00:00') iface.mac = mac;
    const addrInfo = entry.addr_info;
    if (Array.isArray(addrInfo)) {
      for (const info of addrInfo) {
        if (typeof info !== 'object' || info === null) continue;
        const record = info as Record<string, unknown>;
        if (record.family !== 'inet' && record.family !== 'inet6') continue;
        const ip = asString(record.local);
        const prefix = Number(record.prefixlen);
        if (ip === undefined || !Number.isInteger(prefix)) continue;
        iface.addrs.push({ ip, prefix, scope: asString(record.scope) ?? 'global' });
      }
    }
    ifaces.push(iface);
  }
  return ifaces;
}

export interface DefaultRoute {
  gateway?: string;
  dev: string;
}

/** `ip -j route`: pick the default entry. */
export function parseIpRoute(text: string): DefaultRoute | null {
  const parsed = parseJsonArray(text);
  for (const entry of parsed) {
    if (entry.dst !== 'default') continue;
    const dev = asString(entry.dev);
    if (dev === undefined) continue;
    const route: DefaultRoute = { dev };
    const gateway = asString(entry.gateway);
    if (gateway !== undefined && gateway !== '') route.gateway = gateway;
    return route;
  }
  return null;
}

export interface ListeningPort {
  port: number;
  proto: string;
  addr: string;
  pid?: number;
  proc?: string;
}

export interface SocketRow {
  proto: string;
  state: string;
  local: string;
  peer: string;
  pid?: number;
  proc?: string;
}

const SS_LINE = /^(\S+)\s+(?:([A-Z][A-Z0-9-]*)\s+)?(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;
const SS_PROCESS = /users:\(\("([^"]+)",pid=(\d+)/;

/** `ss -tulnpH`: one socket per line, process info when permitted. */
export function parseSsPorts(text: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of text.split('\n')) {
    const row = parseSsLine(line);
    if (row === null) continue;
    const local = splitAddress(row.local);
    if (local === null) continue;
    const port: ListeningPort = { port: local.port, proto: row.proto, addr: local.host };
    if (row.pid !== undefined) port.pid = row.pid;
    if (row.proc !== undefined) port.proc = row.proc;
    ports.push(port);
  }
  return ports;
}

export function parseSsConns(text: string): SocketRow[] {
  const rows: SocketRow[] = [];
  for (const line of text.split('\n')) {
    const row = parseSsLine(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

export function parseResolvConf(text: string): string[] {
  const servers: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    const server = match?.[1];
    if (server !== undefined && !servers.includes(server)) servers.push(server);
  }
  return servers;
}

/** `getent ahosts <name>`: "IP STREAM canonical". */
export function parseGetentHosts(text: string): string[] {
  const answers: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+\S+\s+\S+/.exec(line.trim());
    const ip = match?.[1];
    if (ip !== undefined && !answers.includes(ip)) answers.push(ip);
  }
  return answers;
}

export function splitAddress(value: string): { host: string; port: number } | null {
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return null;
  let host = value.slice(0, colon);
  const port = Number(value.slice(colon + 1));
  if (!Number.isInteger(port) || port < 0) return null;
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  return { host, port };
}

function parseSsLine(line: string): SocketRow | null {
  const match = SS_LINE.exec(line.trim());
  if (match === null) return null;
  const [, proto, state, , , local, peer, process] = match;
  if (proto === undefined || local === undefined || peer === undefined) return null;
  const row: SocketRow = { proto, state: state ?? '', local, peer };
  if (process !== undefined) {
    const procMatch = SS_PROCESS.exec(process);
    if (procMatch !== null) {
      row.proc = procMatch[1];
      const pid = Number(procMatch[2]);
      if (Number.isInteger(pid)) row.pid = pid;
    }
  }
  return row;
}

function parseJsonArray(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    );
  } catch {
    return [];
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export interface FirewallSummary {
  backend: string;
  active: boolean;
  rules_count: number;
  default_policy?: string;
  sample: string[];
}

/** `nft -j list ruleset`: count chains/rules and find the input policy. */
export function parseNftRuleset(text: string): FirewallSummary {
  const summary: FirewallSummary = { backend: 'nftables', active: false, rules_count: 0, sample: [] };
  const trimmed = text.trim();
  if (trimmed === '') return summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return summary;
  }
  if (typeof parsed !== 'object' || parsed === null) return summary;
  const items = (parsed as { nftables?: unknown }).nftables;
  if (!Array.isArray(items)) return summary;

  let chains = 0;
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.table !== undefined) summary.active = true;
    if (record.chain !== undefined) {
      chains += 1;
      const chain = record.chain as Record<string, unknown>;
      if (chain.hook === 'input' && typeof chain.policy === 'string') {
        summary.default_policy = chain.policy;
      }
    }
    if (record.rule !== undefined) {
      summary.rules_count += 1;
      if (summary.sample.length < 5) {
        const rule = record.rule as Record<string, unknown>;
        summary.sample.push(
          `${rule.family ?? 'ip'} ${rule.table ?? '?'} ${rule.chain ?? '?'} handle ${rule.handle ?? '?'}`,
        );
      }
    }
  }
  if (summary.rules_count === 0 && chains > 0) summary.active = true;
  return summary;
}

/** `iptables -S`: count rules and read the INPUT policy. */
export function parseIptablesRules(text: string): FirewallSummary {
  const summary: FirewallSummary = { backend: 'iptables', active: false, rules_count: 0, sample: [] };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const policy = /^-P (\S+) (\S+)$/.exec(trimmed);
    if (policy?.[1] === 'INPUT' && policy[2] !== undefined) {
      summary.default_policy = policy[2].toLowerCase();
      continue;
    }
    if (trimmed.startsWith('-A ')) {
      summary.rules_count += 1;
      if (summary.sample.length < 5) summary.sample.push(trimmed.slice(0, 120));
    }
  }
  summary.active = summary.rules_count > 0;
  return summary;
}

/** `sshd -T`: lowercase "key value" lines. */
export function parseSshdT(text: string): Map<string, string> {
  const config = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const space = trimmed.indexOf(' ');
    const key = space < 0 ? trimmed : trimmed.slice(0, space);
    const value = space < 0 ? '' : trimmed.slice(space + 1).trim();
    if (key !== '') config.set(key.toLowerCase(), value);
  }
  return config;
}

/** `nmcli -t -f IN-USE,SSID,SIGNAL,RATE,SECURITY dev wifi`. */
export function parseNmcliWifi(text: string): {
  connected: boolean;
  ssid: string;
  signal?: number;
  rate?: string;
  security?: string;
} | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('*')) continue;
    const fields = splitNmcli(line.slice(1).replace(/^:/, ''));
    const [ssid, signal, rate, security] = fields;
    const result: { connected: boolean; ssid: string; signal?: number; rate?: string; security?: string } = {
      connected: true,
      ssid: ssid ?? '',
    };
    const numeric = Number(signal);
    if (Number.isFinite(numeric)) result.signal = numeric;
    if (rate !== undefined && rate !== '') result.rate = rate;
    if (security !== undefined && security !== '') result.security = security;
    return result;
  }
  return null;
}

function splitNmcli(value: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && value[index + 1] === ':') {
      current += ':';
      index += 1;
      continue;
    }
    if (char === ':') {
      fields.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}
