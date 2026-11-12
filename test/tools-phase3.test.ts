import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { bootInfoTool } from '../src/tools/boot.js';
import { fsMountsTool, fsSmartTool } from '../src/tools/fs.js';
import { hwSensorsTool, hwUsbTool } from '../src/tools/hw.js';
import { netFirewallTool, netWifiTool } from '../src/tools/net.js';
import { secSshConfigTool } from '../src/tools/sec.js';
import { usrLoginsTool } from '../src/tools/usr.js';
import type { ToolContext } from '../src/tools/registry.js';
import { loadFixture } from './helpers/fixtures.js';

interface Reply {
  stdout: string;
  code?: number;
}

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];

  constructor(private readonly respond: (line: string) => Reply) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
    const reply = this.respond(line);
    return {
      code: reply.code ?? 0,
      stdout: reply.stdout,
      stderr: '',
      ms: 1,
      timedOut: false,
      truncated: false,
    };
  }

  close(): void {}
}

const config = loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root' });

function context(conn: Connection, features: Record<string, boolean> = {}): ToolContext {
  const capabilities: HostCapabilities = {
    os: { id: 'arch', name: 'Arch Linux' },
    kernel: '7.0',
    arch: 'x86_64',
    tools: {},
    features,
  };
  return { conn, config, capabilities: async () => ok(capabilities) };
}

function marked(sections: Array<string | { stdout: string; code: number }>): string {
  return sections
    .map((section, index) => {
      const stdout = typeof section === 'string' ? section : section.stdout;
      const code = typeof section === 'string' ? 0 : section.code;
      return `\u001e${index}\n${stdout}\u001f${code}\n`;
    })
    .join('');
}

describe('feature gating', () => {
  it('returns E_UNSUPPORTED before touching the host', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const cases = [
      fsSmartTool.handler({ device: '/dev/sda' }, context(conn)),
      hwUsbTool.handler({}, context(conn)),
      netWifiTool.handler({}, context(conn)),
      secSshConfigTool.handler({ key: 'permitrootlogin' }, context(conn)),
    ];
    for (const result of await Promise.all(cases)) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'E_UNSUPPORTED');
    }
    assert.equal(conn.calls.length, 0);
  });

  it('fs_smart refuses a device smartctl cannot query', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('smartctl-vda').stdout }));
    const result = await fsSmartTool.handler({ device: '/dev/vda' }, context(conn, { smartctl: true }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'E_UNSUPPORTED');
      assert.match(result.error.message, /SMART data unavailable/);
      assert.match(result.error.hint ?? '', /device type|virtual/);
    }
  });

  it('fs_smart returns health for a supported device', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('smartctl-data').stdout }));
    const result = await fsSmartTool.handler({ device: '/dev/nvme0n1' }, context(conn, { smartctl: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.health, 'passed');
    assert.equal(data.tempC, 41);
  });
});

describe('hw_sensors', () => {
  it('normalises sensor readings and filters by chip', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('sensors-data').stdout }));
    const result = await hwSensorsTool.handler({ chip: 'coretemp-isa-0000', limit: 100 }, context(conn, { sensors: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((row) => row.chip === 'coretemp-isa-0000'));
    assert.ok(rows.some((row) => row.unit === 'C'));
  });
});

describe('sec_ssh_config', () => {
  it('returns one effective setting', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('sshd-T').stdout }));
    const result = await secSshConfigTool.handler({ key: 'permitrootlogin' }, context(conn, { sshd: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.data, { key: 'permitrootlogin', value: 'prohibit-password' });
  });

  it('returns E_NOTFOUND for an unknown keyword', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'Port 22\n' }));
    const result = await secSshConfigTool.handler({ key: 'nonsense' }, context(conn, { sshd: true }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_NOTFOUND');
  });
});

describe('net_firewall', () => {
  it('summarises nftables rules', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('nft-ruleset').stdout }));
    const result = await netFirewallTool.handler({}, context(conn, { nftables: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.backend, 'nftables');
    assert.equal(data.active, true);
  });
});

describe('net_wifi', () => {
  it('reads the active network from nmcli', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('nmcli-wifi').stdout }));
    const result = await netWifiTool.handler({}, context(conn, { network_manager: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.connected, true);
    assert.equal(data.ssid, 'HomeNet');
  });

  it('reports E_UNSUPPORTED when NetworkManager is not running', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: '',
      code: 1,
      stderr: 'Error: NetworkManager is not running.',
    }));
    const result = await netWifiTool.handler({}, context(conn, { network_manager: true }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'E_UNSUPPORTED');
      assert.match(result.error.message, /NetworkManager is not answering/);
    }
  });
});

describe('fs_mounts', () => {
  it('returns options and filters by fstype', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('findmnt-options').stdout }));
    const result = await fsMountsTool.handler({ fstype: 'overlay', limit: 100 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.fstype === 'overlay'));
    assert.ok(String(rows[0]?.options).length > 0);
  });
});

describe('boot_info', () => {
  it('merges kernel, bootctl and package data', async () => {
    const stdout = marked([
      loadFixture('uname-kernel').stdout,
      loadFixture('proc-cmdline').stdout,
      { stdout: '', code: 1 },
      loadFixture('bootctl').stdout,
      'linux 7.0.14.arch1-1\n',
    ]);
    const conn = new ScriptedConnection(() => ({ stdout }));
    const result = await bootInfoTool.handler({}, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.efi, false);
    assert.deepEqual(data.installed, [{ name: 'linux', version: '7.0.14.arch1-1' }]);
    assert.match(String(data.cmdline), /BOOT_IMAGE|root=/);
  });
});

describe('usr_logins', () => {
  it('separates successful logins from failed ones (boot rows excluded)', async () => {
    const stdout = marked([
      'root     pts/0        192.0.2.10       Thu Nov 12 14:30:00 2026   still logged in\n',
      'root     ssh:notty    198.51.100.7     Thu Nov 12 14:00:00 2026 - 14:01:00 2026  (00:01)\n',
    ]);
    const conn = new ScriptedConnection(() => ({ stdout }));
    const result = await usrLoginsTool.handler({ limit: 10 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { ok: unknown[]; failed: unknown[] };
    assert.equal(data.ok.length, 1);
    assert.equal(data.failed.length, 1);
  });
});
