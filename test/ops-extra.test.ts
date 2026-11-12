import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { tokenOf } from './confirmation.js';
import { usrPasswordTool } from '../src/tools/password.js';
import type { ToolContext } from '../src/tools/registry.js';
import { svcTimerSetTool } from '../src/tools/timers.js';
import { netWifiActionTool } from '../src/tools/wifi.js';

type Reply = { stdout?: string; code?: number; stderr?: string };

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];
  readonly inputs: Array<string | undefined> = [];

  constructor(private readonly respond: (line: string) => Reply = () => ({})) {}

  async exec(line: string, opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
    this.inputs.push(opts?.input);
    const reply = this.respond(line);
    return {
      code: reply.code ?? 0,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      ms: 1,
      timedOut: false,
      truncated: false,
    };
  }

  close(): void {}
}

const capabilities: HostCapabilities = {
  os: { id: 'arch', name: 'Arch Linux' },
  kernel: '7.0',
  arch: 'x86_64',
  tools: { nmcli: '/usr/bin/nmcli' },
  features: { network_manager: true },
};

function context(conn: Connection): ToolContext {
  return {
    conn,
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'dante' }),
    capabilities: async () => ok(capabilities),
  };
}

beforeEach(() => resetConfirmations());

describe('svc_timer_set', () => {
  const calendar = '  Original form: daily\nNormalized form: *-*-* 00:00:00\n    Next elapse: Wed 2026-11-12 00:00:00 -05\n';

  function responder(line: string): Reply {
    if (line.includes('systemd-analyze calendar')) return { stdout: calendar };
    return {};
  }

  it('rechaza un calendario inválido', async () => {
    const conn = new ScriptedConnection(() => ({ code: 1, stderr: 'Failed to parse calendar specification' }));
    const result = await svcTimerSetTool.handler(
      { name: 'backup', schedule: 'cada luna', command: '/usr/bin/true', enable: true, dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_POLICY');
    assert.ok(!conn.calls.some((c) => c.includes('cat >')));
  });

  it('no escribe en dry_run y muestra el próximo elapse', async () => {
    const conn = new ScriptedConnection(responder);
    const result = await svcTimerSetTool.handler(
      { name: 'backup', schedule: 'daily', command: '/usr/bin/true', enable: true, dry_run: true },
      context(conn),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { next_elapse: string };
    assert.match(data.next_elapse, /2026-11-12/);
    assert.ok(!conn.calls.some((c) => c.includes('cat >')));
  });

  it('escribe el par service+timer y habilita el timer', async () => {
    const conn = new ScriptedConnection(responder);
    const ctx = context(conn);
    const args = { name: 'backup', schedule: 'daily', command: '/usr/bin/true', enable: true, dry_run: false };

    const first = await svcTimerSetTool.handler(args, ctx);
    const token = tokenOf(first);
    const second = await svcTimerSetTool.handler({ ...args, token }, ctx);

    assert.equal(second.ok, true);
    assert.ok(conn.calls.some((c) => c.endsWith('/etc/systemd/system/backup.service')));
    assert.ok(conn.calls.some((c) => c.endsWith('/etc/systemd/system/backup.timer')));
    assert.ok(conn.calls.some((c) => c.endsWith('systemctl enable --now backup.timer')));
    const timerInput = conn.inputs[conn.calls.findIndex((c) => c.endsWith('backup.timer'))];
    assert.match(timerInput ?? '', /OnCalendar=daily/);
    assert.match(timerInput ?? '', /Unit=backup.service/);
  });
});

describe('usr_password', () => {
  it('falla si el usuario no existe', async () => {
    const conn = new ScriptedConnection(() => ({ code: 1, stderr: "id: 'nadie': no such user" }));
    const result = await usrPasswordTool.handler(
      { user: 'nadie', password: 'secreto123', dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('escribe la contraseña por stdin, no en argv', async () => {
    const conn = new ScriptedConnection((line) => (line.includes('id -u') ? { stdout: '1000\n' } : {}));
    const ctx = context(conn);
    const args = { user: 'dante', password: 'secreto123', dry_run: false };

    const first = await usrPasswordTool.handler(args, ctx);
    const token = tokenOf(first);
    assert.ok(conn.calls.every((c) => !c.includes('secreto123')));

    const second = await usrPasswordTool.handler({ ...args, token }, ctx);
    assert.equal(second.ok, true);
    const idx = conn.calls.findIndex((c) => c.endsWith('chpasswd'));
    assert.ok(idx >= 0);
    assert.equal(conn.inputs[idx], 'dante:secreto123\n');
    assert.ok(conn.calls.every((c) => !c.includes('secreto123')));
  });
});

describe('net_wifi_action', () => {
  function responder(line: string): Reply {
    if (line.endsWith('nmcli -t -f NAME connection show')) return { stdout: 'Wired connection 1\nCasa\n' };
    if (line.includes('GENERAL.CONNECTION')) return { stdout: 'GENERAL.CONNECTION:Wired connection 1\n' };
    return {};
  }

  it('rechaza una conexión inexistente', async () => {
    const conn = new ScriptedConnection(responder);
    const result = await netWifiActionTool.handler(
      { connection: 'Otra', action: 'up', force: false, dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('no baja la conexión activa sin force', async () => {
    const conn = new ScriptedConnection(responder);
    const result = await netWifiActionTool.handler(
      { connection: 'Wired connection 1', action: 'down', force: false, dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_POLICY');
  });

  it('activa una conexión tras confirmar', async () => {
    const conn = new ScriptedConnection(responder);
    const ctx = context(conn);
    const args = { connection: 'Casa', action: 'up' as const, force: false, dry_run: false };

    const first = await netWifiActionTool.handler(args, ctx);
    const token = tokenOf(first);
    const second = await netWifiActionTool.handler({ ...args, token }, ctx);

    assert.equal(second.ok, true);
    assert.ok(conn.calls.some((c) => c.endsWith('nmcli connection up Casa')));
  });
});
