/**
 * Generate fixtures that cannot be captured in the local container (ADR-016).
 * Journal: journald is masked. Hardware: no battery, no smartctl, no lsusb, no
 * wifi, sensors empty. Shape matches the real command output so parsers are
 * exercised the same way; `synthetic: true` marks provenance.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'test', 'fixtures');

function fixture(name, cmd, stdout, exit = 0) {
  writeFileSync(
    join(OUT, `${name}.json`),
    `${JSON.stringify(
      {
        cmd,
        exit,
        stdout,
        stderr: '',
        captured_at: '2026-11-12T15:00:00.000Z',
        host: 'synthetic',
        synthetic: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

// --- journal ---------------------------------------------------------------

const BOOT_ID = '8a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const MACHINE_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const TEMPLATES = [
  { unit: 'nginx.service', prio: '3', msg: 'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)' },
  { unit: 'nginx.service', prio: '3', msg: 'nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)' },
  { unit: 'sshd.service', prio: '6', msg: 'Accepted publickey for root from 192.0.2.10 port 51234 ssh2: ED25519 SHA256:abc' },
  { unit: 'kernel', prio: '4', msg: 'TCP: request_sock_TCP: Possible SYN flooding on port 80. Sending cookies.' },
  { unit: 'systemd', prio: '6', msg: 'Started nginx.service - A high performance web server and a reverse proxy server.' },
  { unit: 'postgresql.service', prio: '3', msg: 'FATAL:  password authentication failed for user "app"' },
  { unit: 'cron.service', prio: '6', msg: '(root) CMD (run-parts /etc/cron.hourly)' },
  { unit: 'systemd-logind.service', prio: '4', msg: 'Session c1 logged out. Waiting for processes to exit.' },
  { unit: 'sshd.service', prio: '5', msg: 'Received disconnect from 198.51.100.7 port 40222:11: Bye Bye' },
  { unit: 'kernel', prio: '6', msg: 'Linux version 7.2.15-arch1-1 (linux@archlinux) (gcc 15.2.1, GNU ld 2.44) #1 SMP PREEMPT_DYNAMIC' },
];

function entry(template, index, baseMs) {
  return {
    __REALTIME_TIMESTAMP: String((baseMs + index * 60_000) * 1000),
    __MONOTONIC_TIMESTAMP: String(9_000_000_000 + index * 60_000_000),
    _BOOT_ID: BOOT_ID,
    _MACHINE_ID: MACHINE_ID,
    _HOSTNAME: 'dante',
    _TRANSPORT: template.unit === 'kernel' ? 'kernel' : 'journal',
    _PID: String(1000 + index),
    _CMDLINE: '/usr/bin/nginx -g daemon off;',
    SYSLOG_IDENTIFIER: template.unit,
    PRIORITY: template.prio,
    _SYSTEMD_UNIT: template.unit,
    MESSAGE: template.msg,
  };
}

const base = Date.parse('2026-11-12T03:10:00Z');
const fifty = [];
for (let index = 0; index < 50; index += 1) {
  fifty.push(entry(TEMPLATES[index % TEMPLATES.length], index, base));
}
fifty.push({ ...entry(TEMPLATES[0], 51, base), MESSAGE: [0x00, 0x01, 0x02, 0xff] });

const errors = [];
for (let index = 0; index < 40; index += 1) {
  errors.push(entry(TEMPLATES[index % 4], index, base));
}

fixture(
  'journal-50',
  ['journalctl', '--output=json', '--no-pager', '-n', '50'],
  `${fifty.map((item) => JSON.stringify(item)).join('\n')}\n`,
);
fixture(
  'journal-errors',
  ['journalctl', '-p', 'err..alert', '-n', '200', '--output=json', '--no-pager'],
  `${errors.map((item) => JSON.stringify(item)).join('\n')}\n`,
);
fixture(
  'journal-boots',
  ['journalctl', '--list-boots', '--no-pager'],
  [
    ' -1 4f9c1a2b3c4d5e6f7a8b9c0d1e2f3a4b Wed 2026-11-11 22:10:05 UTC—Thu 2026-11-12 02:59:59 UTC',
    '  0 8a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d Thu 2026-11-12 14:28:24 UTC—Thu 2026-11-12 15:00:00 UTC',
  ].join('\n') + '\n',
);

// --- hardware --------------------------------------------------------------

fixture(
  'sensors-data',
  ['sensors', '-j'],
  JSON.stringify({
    'coretemp-isa-0000': {
      Adapter: 'ISA adapter',
      'Package id 0': { temp1_input: 48.0, temp1_max: 100.0, temp1_crit: 100.0 },
      'Core 0': { temp2_input: 46.0 },
      'Core 1': { temp3_input: 47.0 },
    },
    'nvme-pci-0100': {
      Adapter: 'PCI adapter',
      Composite: { temp1_input: 38.85, temp1_max: 81.85 },
      Fan: { fan1_input: 2100 },
    },
  }) + '\n',
);

fixture(
  'lsusb-data',
  ['lsusb'],
  [
    'Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub',
    'Bus 001 Device 002: ID 046d:c52b Logitech, Inc. Unifying Receiver',
    'Bus 002 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub',
  ].join('\n') + '\n',
);

fixture(
  'smartctl-data',
  ['smartctl', '-j', '-H', '-A', '/dev/nvme0n1'],
  JSON.stringify({
    device: { name: '/dev/nvme0n1', type: 'nvme' },
    model_name: 'Samsung SSD 990 PRO 2TB',
    smart_status: { passed: true },
    temperature: { current: 41 },
    power_on_time: { hours: 12873 },
  }) + '\n',
);

fixture(
  'nmcli-wifi',
  ['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,RATE,SECURITY', 'dev', 'wifi'],
  ['*:HomeNet:72:130 Mbit/s:WPA2', ':Neighbor:31:54 Mbit/s:WPA2'].join('\n') + '\n',
);

fixture(
  'power-supply',
  ['sh', '-c', 'cat /sys/class/power_supply/BAT0/capacity /sys/class/power_supply/BAT0/status'],
  '87\nDischarging\n',
);

process.stderr.write('wrote journal-*, sensors-data, lsusb-data, smartctl-data, nmcli-wifi, power-supply (synthetic)\n');
