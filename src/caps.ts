import type { Connection } from './connection/types.js';
import type { Config } from './config.js';
import { ok } from './core/result.js';
import type { Result } from './core/types.js';
import { runSections } from './exec/sequence.js';
import type { SectionSpec } from './exec/sequence.js';
import { parseOsRelease } from './parse/host.js';

export interface HostCapabilities {
  os: { id: string; name: string; version_id?: string };
  kernel: string;
  arch: string;
  systemd?: string;
  /** Only tools that exist, path by basename. */
  tools: Record<string, string>;
  features: Record<string, boolean>;
}

const KNOWN_TOOLS = [
  'pacman',
  'systemctl',
  'journalctl',
  'nmcli',
  'sensors',
  'nvidia-smi',
  'smartctl',
  'dkms',
  'checkupdates',
  'ss',
  'ip',
  'ping',
  'resolvectl',
  'renice',
  'ufw',
  'firewall-cmd',
  'nft',
  'iptables',
  'lspci',
  'lsusb',
  'mokutil',
  'sshd',
  'yay',
  'paru',
  'rg',
  'fd',
  'fdfind',
  'grep',
  'jq',
  'yq',
  'bat',
  'eza',
  'exa',
  'dust',
  'ncdu',
  'tree',
  'tar',
  'unzip',
  'zip',
  '7z',
  'zstd',
  'xz',
  'rsync',
  'curl',
  'wget',
  'croc',
  'git',
  'python3',
  'python',
  'node',
  'ffmpeg',
  'convert',
  'magick',
  'sqlite3',
  'htop',
  'btop',
  'tmux',
  'screen',
  'fzf',
  'file',
  'sha256sum',
  'base64',
] as const;

const SECTIONS: readonly SectionSpec[] = [
  { key: 'cmdv', argv: ['sh', '-c', `command -v ${KNOWN_TOOLS.join(' ')}`] },  { key: 'os', argv: ['cat', '/etc/os-release'] },
  { key: 'kernel', argv: ['uname', '-r'] },
  { key: 'arch', argv: ['uname', '-m'] },
  { key: 'systemd', argv: ['systemctl', '--version'] },
];

/** One batched round trip at startup (docs/02-architecture.md §6). */
export async function detectCapabilities(
  conn: Connection,
  config: Config,
): Promise<Result<HostCapabilities>> {
  const batch = await runSections(conn, SECTIONS, {
    timeoutMs: config.timeoutMs,
    maxBytes: 32_768,
  });
  if (!batch.ok) return batch;
  return ok(buildCapabilities(batch.data));
}

/** Pure parsing step, so fixtures can test it without a host. */
export function buildCapabilities(
  sections: Record<string, { stdout: string; code: number }>,
): HostCapabilities {
  const os = parseOsRelease(sections.os?.stdout ?? '');
  const tools: Record<string, string> = {};
  for (const line of (sections.cmdv?.stdout ?? '').split('\n')) {
    const path = line.trim();
    if (path === '' || !path.startsWith('/')) continue;
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if ((KNOWN_TOOLS as readonly string[]).includes(basename)) tools[basename] = path;
  }

  const versionLine = (sections.systemd?.stdout ?? '').split('\n')[0]?.trim() ?? '';
  const versionMatch = /\(([^)]+)\)/.exec(versionLine);
  const systemd = versionMatch?.[1] ?? (versionLine !== '' ? versionLine : undefined);

  const has = (name: (typeof KNOWN_TOOLS)[number]): boolean => tools[name] !== undefined;

  const features: Record<string, boolean> = {
    systemd: has('systemctl'),
    journald: has('journalctl'),
    pacman: has('pacman'),
    aur: has('yay') || has('paru'),
    checkupdates: has('checkupdates'),
    network_manager: has('nmcli'),
    sensors: has('sensors'),
    smartctl: has('smartctl'),
    nvidia: has('nvidia-smi'),
    nftables: has('nft'),
    iptables: has('iptables'),
    iproute2: has('ss') || has('ip'),
    ping: has('ping'),
    resolved: has('resolvectl'),
    renice: has('renice'),
    ufw: has('ufw'),
    firewalld: has('firewall-cmd'),
    lsusb: has('lsusb'),
    lspci: has('lspci'),
    mokutil: has('mokutil'),
    sshd: has('sshd'),
    ripgrep: has('rg'),
    fd: has('fd') || has('fdfind'),
    jq: has('jq'),
    yq: has('yq'),
    croc: has('croc'),
    curl: has('curl'),
    wget: has('wget'),
    git: has('git'),
    python3: has('python3'),
    node: has('node'),
  };

  const capabilities: HostCapabilities = {
    os: { id: os.id, name: os.prettyName !== '' ? os.prettyName : os.name },
    kernel: (sections.kernel?.stdout ?? '').trim(),
    arch: (sections.arch?.stdout ?? '').trim(),
    tools,
    features,
  };
  if (os.versionId !== undefined) capabilities.os.version_id = os.versionId;
  if (systemd !== undefined) capabilities.systemd = systemd;
  return capabilities;
}
