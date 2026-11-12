/**
 * Capture real command outputs as fixtures. Dev tool only: never run against a
 * production host. Defaults target the local arch-systemd container.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createConnection } from '../src/connection/index.js';
import { runCommand } from '../src/exec/run.js';

interface CaptureSpec {
  name: string;
  argv: readonly string[];
  /** Byte cap for stdout; journal lines are large. */
  maxBytes?: number;
  /** Scrub IPs, SSH fingerprints and MACs before writing the fixture. */
  redact?: boolean;
}

const SYS_INFO: readonly CaptureSpec[] = [
  { name: 'os-release', argv: ['cat', '/etc/os-release'] },
  { name: 'uname-kernel', argv: ['uname', '-r'] },
  { name: 'uname-arch', argv: ['uname', '-m'] },
  { name: 'hostname', argv: ['cat', '/proc/sys/kernel/hostname'] },
  { name: 'proc-uptime', argv: ['cat', '/proc/uptime'] },
  { name: 'systemd-detect-virt', argv: ['systemd-detect-virt'] },
  { name: 'proc-meminfo', argv: ['cat', '/proc/meminfo'] },
  { name: 'lscpu', argv: ['lscpu', '-J'] },
  { name: 'nproc', argv: ['nproc', '--all'] },
];

const SYSTEMD: readonly CaptureSpec[] = [
  {
    name: 'systemctl-failed',
    argv: ['systemctl', 'list-units', '--failed', '--output=json', '--no-pager'],
  },
  {
    name: 'systemctl-units-all',
    argv: ['systemctl', 'list-units', '--all', '--output=json', '--no-pager'],
  },
  {
    name: 'systemctl-units-running',
    argv: ['systemctl', 'list-units', '--state=running', '--output=json', '--no-pager'],
  },
  {
    name: 'systemctl-show-sshd',
    argv: [
      'systemctl', 'show', 'sshd.service',
      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
      '-p', 'ExecMainStartTimestamp', '-p', 'NRestarts', '-p', 'MemoryCurrent',
      '-p', 'TasksCurrent', '-p', 'UnitFileState', '-p', 'FragmentPath',
      '-p', 'ExecMainStatus', '-p', 'Result', '-p', 'ExecStart', '--no-pager',
    ],
  },
  {
    name: 'systemctl-show-multi',
    argv: [
      'systemctl', 'show', 'sshd.service', 'systemd-tmpfiles-clean.timer',
      '-p', 'Id', '-p', 'StateChangeTimestamp', '-p', 'InactiveEnterTimestamp',
      '-p', 'Result', '-p', 'ExecMainStatus', '--no-pager',
    ],
  },
  { name: 'systemctl-timers', argv: ['systemctl', 'list-timers', '--all', '--output=json', '--no-pager'] },
  { name: 'systemctl-version', argv: ['systemctl', '--version'] },
  { name: 'unit-file-sshd', argv: ['cat', '/usr/lib/systemd/system/sshd.service'] },
];

const JOURNAL: readonly CaptureSpec[] = [
  { name: 'journal-50', argv: ['journalctl', '--output=json', '--no-pager', '-n', '50'], maxBytes: 262_144, redact: true },
  {
    name: 'journal-errors',
    argv: ['journalctl', '-p', 'err..alert', '-n', '200', '--output=json', '--no-pager'],
    maxBytes: 262_144,
    redact: true,
  },
  { name: 'journal-boots', argv: ['journalctl', '--list-boots', '--no-pager'], redact: true },
  {
    name: 'journal-unit-sshd',
    argv: ['journalctl', '-u', 'sshd.service', '-n', '100', '--output=json', '--no-pager'],
    maxBytes: 262_144,
    redact: true,
  },
];

const PROC: readonly CaptureSpec[] = [  {
    name: 'ps-table',
    argv: [
      'ps', '-e', '-o', 'pid=,ppid=,user:16=,pcpu=,pmem=,rss=,stat=,etimes=,args=',
      '--sort=-pcpu', '--no-headers',
    ],
  },
  {
    name: 'ps-top',
    argv: ['ps', '-e', '-o', 'pid=,comm=,pcpu=,pmem=', '--sort=-pcpu', '--no-headers'],
  },
  { name: 'df', argv: ['df', '-P', '-B1'] },
  { name: 'proc-stat', argv: ['cat', '/proc/stat'] },
  { name: 'proc-diskstats', argv: ['cat', '/proc/diskstats'] },
  { name: 'proc-net-dev', argv: ['cat', '/proc/net/dev'] },
  { name: 'proc-loadavg', argv: ['cat', '/proc/loadavg'] },
  { name: 'thermal', argv: ['sh', '-c', 'cat /sys/class/thermal/thermal_zone*/temp'] },
  { name: 'pacman-qu', argv: ['pacman', '-Qu'] },
  {
    name: 'command-v',
    argv: ['sh', '-c', 'command -v pacman systemctl journalctl nmcli sensors nvidia-smi smartctl dkms checkupdates ss nft iptables lspci lsusb yay paru'],
  },
];

const PHASE2: readonly CaptureSpec[] = [
  { name: 'pacman-qdtq', argv: ['pacman', '-Qdtq'] },
  { name: 'pacman-sync', argv: ['stat', '-c', '%Y', '/var/lib/pacman/sync'] },
  { name: 'pacman-cache', argv: ['du', '-sb', '/var/cache/pacman/pkg'] },
  { name: 'pacman-qi-bash', argv: ['pacman', '-Qi', 'bash'] },
  { name: 'pacman-ss-bash', argv: ['pacman', '-Ss', 'bash'] },
  { name: 'pacman-qo-bash', argv: ['pacman', '-Qo', '/usr/bin/bash'] },
  { name: 'ip-addr', argv: ['ip', '-j', 'addr'] },
  { name: 'ip-route', argv: ['ip', '-j', 'route'] },
  { name: 'resolv-conf', argv: ['cat', '/etc/resolv.conf'] },
  { name: 'ss-ports', argv: ['ss', '-tulnpH'] },
  { name: 'ss-conns', argv: ['ss', '-tunapH', 'state', 'established'] },
  { name: 'getent-localhost', argv: ['getent', 'ahosts', 'localhost'] },
  {
    name: 'findmnt',
    argv: ['findmnt', '-J', '-b', '--output', 'TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%'],
  },
  {
    name: 'findmnt-options',
    argv: ['findmnt', '-J', '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS'],
  },
  { name: 'df-inodes', argv: ['df', '-P', '-i', '-B1'] },
  {
    name: 'mount-nondirs',
    argv: ['sh', '-c', 'findmnt -rn -o TARGET | while read -r t; do [ -d "$t" ] || printf "%s\\n" "$t"; done'],
  },
  { name: 'find-etc', argv: ['find', '/etc', '-maxdepth', '1', '-mindepth', '1', '-printf', '%f\t%s\t%T@\t%y\n'] },
  { name: 'find-etc-conf', argv: ['find', '/etc', '-maxdepth', '6', '-type', 'f', '-name', '*.conf', '-printf', '%p\t%s\t%T@\n'] },
  { name: 'head-pacman-conf', argv: ['head', '-c', '512', '/etc/pacman.conf'] },
  { name: 'wc-pacman-conf', argv: ['wc', '-l', '/etc/pacman.conf'] },
  { name: 'sed-pacman-conf', argv: ['sed', '-n', '1,20p', '/etc/pacman.conf'] },
];

const PHASE3: readonly CaptureSpec[] = [
  { name: 'lsblk', argv: ['lsblk', '-J', '-b'] },
  { name: 'lspci', argv: ['lspci', '-mm', '-nn'] },
  { name: 'lspci-k', argv: ['lspci', '-k'] },
  { name: 'sensors', argv: ['sensors', '-j'] },
  { name: 'power-supply', argv: ['sh', '-c', 'cat /sys/class/power_supply/*/capacity /sys/class/power_supply/*/status'] },
  { name: 'governor', argv: ['sh', '-c', 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'] },
  { name: 'systemd-analyze', argv: ['systemd-analyze'] },
  { name: 'systemd-analyze-blame', argv: ['systemd-analyze', 'blame'] },
  { name: 'bootctl', argv: ['bootctl', 'status'] },
  { name: 'proc-cmdline', argv: ['cat', '/proc/cmdline'] },
  { name: 'kernel-packages', argv: ['pacman', '-Q', 'linux'] },
  { name: 'efi-dir', argv: ['test', '-d', '/sys/firmware/efi'] },
  { name: 'mokutil', argv: ['mokutil', '--sb-state'] },
  { name: 'loginctl-sessions', argv: ['loginctl', 'list-sessions', '--no-pager'] },
  { name: 'last', argv: ['last', '-F', '-n', '10'] },
  { name: 'lastb', argv: ['lastb', '-n', '10'] },
  { name: 'sshd-T', argv: ['sshd', '-T'] },
  { name: 'nft-ruleset', argv: ['nft', '-j', 'list', 'ruleset'] },
  { name: 'world-writable', argv: ['find', '/etc', '-xdev', '-type', 'f', '-perm', '-0002', '-printf', '%p\n'] },
  { name: 'smartctl-vda', argv: ['smartctl', '-j', '-H', '-A', '/dev/vda'] },
  { name: 'lsusb', argv: ['lsusb'] },
];

const ALL_CAPTURES: readonly CaptureSpec[] = [...SYS_INFO, ...SYSTEMD, ...JOURNAL, ...PROC, ...PHASE2, ...PHASE3];

async function main(): Promise<void> {
  const config = loadConfig({
    ARCH_MCP_HOST: process.env.ARCH_MCP_HOST ?? '127.0.0.1',
    ARCH_MCP_PORT: process.env.ARCH_MCP_PORT ?? '2223',
    ARCH_MCP_USER: process.env.ARCH_MCP_USER ?? 'root',
    ARCH_MCP_KEY:
      process.env.ARCH_MCP_KEY ?? join(process.cwd(), 'dev', 'ssh', 'id_test'),
    ARCH_MCP_MODE: 'readonly',
  });

  const conn = createConnection(config);
  const outDir = join(process.cwd(), 'test', 'fixtures');
  mkdirSync(outDir, { recursive: true });

  const host = process.env.ARCH_MCP_FIXTURE_HOST ?? `${config.host}:${config.port}`;
  const capturedAt = new Date().toISOString();

  try {
    for (const spec of ALL_CAPTURES) {
      const result = await runCommand(conn, spec.argv, {
        timeoutMs: 15_000,
        maxBytes: spec.maxBytes ?? 65_536,
      });
      if (!result.ok) {
        process.stderr.write(`skip ${spec.name}: ${result.error.code} ${result.error.message}\n`);
        continue;
      }
      const scrub = spec.redact === true;
      const stdout = scrub ? redactCapture(result.data.stdout) : result.data.stdout;
      const stderr = scrub ? redactCapture(result.data.stderr) : result.data.stderr;
      const fixture = {
        cmd: spec.argv,
        exit: result.data.code,
        stdout,
        stderr,
        captured_at: capturedAt,
        host,
        synthetic: false,
        ...(scrub ? { redacted: ['ipv4', 'ssh-fingerprint', 'mac'] } : {}),
      };
      writeFileSync(join(outDir, `${spec.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
      process.stderr.write(`wrote ${spec.name}.json (${Buffer.byteLength(stdout)} B stdout)\n`);
    }
  } finally {
    conn.close();
  }
}

await main();

/** Keep the shape real but drop network identifiers before committing a fixture. */
function redactCapture(text: string): string {
  return text
    .replace(/\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, '203.0.113.10')
    .replace(/SHA256:[A-Za-z0-9+/=]+/g, 'SHA256:REDACTED')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, '00:00:5e:00:53:01');
}
