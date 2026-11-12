import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { coredumpListTool, journalVacuumTool } from '../src/tools/diag.js';
import { kernelLogTool, modListTool, modLoadTool, sysctlSetTool } from '../src/tools/kernel.js';
import { fsMountTool } from '../src/tools/mounts.js';
import { pkgCleanTool, pkgFilesTool } from '../src/tools/pkg-extra.js';
import type { ToolContext } from '../src/tools/registry.js';
import { usrListTool } from '../src/tools/users-extra.js';

type Reply = { stdout?: string; code?: number; stderr?: string };

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];

  constructor(private readonly respond: (line: string) => Reply = () => ({})) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
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
  tools: { yay: '/usr/bin/yay' },
  features: { aur: true },
};

function context(conn: Connection): ToolContext {
  return {
    conn,
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'dante' }),
    capabilities: async () => ok(capabilities),
  };
}

function tokenOf(result: { ok: boolean; error?: unknown }): string {
  assert.equal(result.ok, false);
  return (result as { error: { data: { token: string } } }).error.data.token;
}

beforeEach(() => resetConfirmations());

describe('pkg_files', () => {
  it('lista archivos y respeta el límite', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: 'openssh /usr/bin/ssh\nopenssh /usr/bin/sshd\nopenssh /etc/ssh/\n',
    }));
    const result = await pkgFilesTool.handler({ name: 'openssh', limit: 1 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.data.data as { files: string[] }).files, ['/usr/bin/ssh']);
  });
});

describe('pkg_clean', () => {
  it('no ejecuta nada en dry_run', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '1000\t/var/cache/pacman/pkg' }));
    const result = await pkgCleanTool.handler({ dry_run: true }, context(conn));
    assert.equal(result.ok, true);
    assert.ok(conn.calls.every((c) => !c.includes('pacman -Sc')));
  });
});

describe('mod_list', () => {
  it('parsea lsmod', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'Module Size Used by\next4 100 1\nkvm 200 2 kvm_intel\n' }));
    const result = await modListTool.handler({ limit: 10 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<{ name: string; by: string[] }>;
    assert.equal(rows[0]?.name, 'ext4');
    assert.deepEqual(rows[1]?.by, ['kvm_intel']);
  });
});

describe('mod_load', () => {
  it('pide token y confirma la carga', async () => {
    const conn = new ScriptedConnection((line) => {
      if (line.endsWith('lsmod')) return { stdout: 'Module Size Used by\nloop 1 0\n' };
      return {};
    });
    const ctx = context(conn);
    const first = await modLoadTool.handler({ name: 'loop', dry_run: false }, ctx);
    const token = tokenOf(first);
    const second = await modLoadTool.handler({ name: 'loop', dry_run: false, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls.some((c) => c.endsWith('modprobe loop')));
    if (!second.ok) return;
    assert.equal((second.data.data as { loaded: boolean }).loaded, true);
  });
});

describe('sysctl_set', () => {
  it('aplica en caliente y persiste con token', async () => {
    const conn = new ScriptedConnection(() => ({}));
    const ctx = context(conn);
    const args = { key: 'vm.swappiness', value: '10', persist: true, dry_run: false };
    const first = await sysctlSetTool.handler(args, ctx);
    const token = tokenOf(first);
    const second = await sysctlSetTool.handler({ ...args, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls.some((c) => c.endsWith('sysctl -w vm.swappiness=10')));
    assert.ok(conn.calls.some((c) => c.includes('vm.swappiness=10') && c.includes('/etc/sysctl.d/99-arch-mcp.conf')));
  });
});

describe('fs_mount', () => {
  it('rechaza un target inexistente', async () => {
    const conn = new ScriptedConnection((line) => (line.includes('test -d') ? { code: 1 } : {}));
    const result = await fsMountTool.handler(
      { source: '/dev/sdb1', target: '/mnt/usb', dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('se niega a montar sobre /', async () => {
    const conn = new ScriptedConnection();
    const result = await fsMountTool.handler({ source: '/dev/sdb1', target: '/', dry_run: false }, context(conn));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_POLICY');
  });
});

describe('coredump_list', () => {
  it('parsea la tabla de coredumpctl', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout:
        'TIME                            PID   UID   GID SIG     COREFILE EXE  SIZE\n' +
        'Tue 2026-09-01 00:21:36 -05 1786209 65532 65532 SIGSEGV missing  /kairo -\n',
    }));
    const result = await coredumpListTool.handler({ limit: 5 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<{ pid: number | null; signal: string }>;
    assert.equal(rows[0]?.pid, 1786209);
    assert.equal(rows[0]?.signal, 'SIGSEGV');
  });
});

describe('journal_vacuum', () => {
  it('exige tamaño o antigüedad', async () => {
    const conn = new ScriptedConnection();
    const result = await journalVacuumTool.handler({ dry_run: false }, context(conn));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_POLICY');
  });
});

describe('usr_list', () => {
  it('parsea getent passwd', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: 'root:x:0:0:root:/root:/bin/bash\ndante:x:1000:1000::/home/dante:/bin/zsh\n',
    }));
    const result = await usrListTool.handler({ type: 'users', limit: 10 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const users = result.data.data as Array<{ name: string; shell: string }>;
    assert.equal(users[1]?.name, 'dante');
    assert.equal(users[1]?.shell, '/bin/zsh');
  });
});

describe('kernel_log', () => {
  it('usa journalctl -k y devuelve entradas compactas', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: JSON.stringify({
        __REALTIME_TIMESTAMP: '1794518972000000',
        PRIORITY: '6',
        MESSAGE: 'usb 1-1: new high-speed USB device',
        _TRANSPORT: 'kernel',
      }) + '\n',
    }));
    const result = await kernelLogTool.handler({ lines: 5 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<{ msg: string }>;
    assert.match(rows[0]?.msg ?? '', /USB device/);
  });
});
