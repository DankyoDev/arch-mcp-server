import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { jobArgv, jobStatus, killJob, startJob } from '../src/jobs.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { fsWriteTool } from '../src/tools/fs.js';
import { rawExecTool } from '../src/tools/meta.js';
import { pkgInstallTool, pkgUpdateTool } from '../src/tools/pkg.js';
import type { ToolContext } from '../src/tools/registry.js';
import { svcActionTool } from '../src/tools/svc.js';
import { tokenOf } from './confirmation.js';

interface Reply {
  stdout: string;
  code?: number;
  stderr?: string;
}

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];
  readonly inputs: Array<string | undefined> = [];

  constructor(private readonly respond: (line: string) => Reply) {}

  async exec(line: string, opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
    this.inputs.push(opts?.input);
    const reply = this.respond(line);
    return {
      code: reply.code ?? 0,
      stdout: reply.stdout,
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
  tools: {},
  features: { pacman: true },
};

function context(conn: Connection, env: Record<string, string> = {}): ToolContext {
  const config = loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root', ...env });
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

describe('jobs', () => {
  it('only builds allowlisted argv', () => {
    assert.deepEqual(jobArgv('pkg_update'), ['pacman', '-Syu', '--noconfirm']);
    assert.deepEqual(jobArgv('updatedb'), ['updatedb']);
    assert.deepEqual(jobArgv('btrfs_scrub', '/dev/nvme0n1'), ['btrfs', 'scrub', 'start', '/dev/nvme0n1']);
    assert.equal(jobArgv('btrfs_scrub'), null);
    assert.equal(jobArgv('btrfs_scrub', '/etc/passwd'), null);
  });

  it('starts a job and reports running, exited and killed states', async () => {
    const config = loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root' });
    const starter = new ScriptedConnection(() => ({ stdout: '4321\n' }));
    const started = await startJob(starter, config, 'pkg_update');
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const jobId = started.data.id;
    assert.match(jobId, /^[0-9a-f]{8}$/);
    assert.match(starter.calls[0] ?? '', /nohup sh -c/);

    const running = new ScriptedConnection(() => ({
      stdout: marked([{ stdout: '', code: 1 }, { stdout: '', code: 0 }, 'working\n']),
    }));
    const status = await jobStatus(running, config, jobId, 0);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.data.state, 'running');
    assert.equal(status.data.output, 'working\n');
    assert.equal(status.data.next_offset, 8);

    const finished = new ScriptedConnection(() => ({
      stdout: marked(['0\n', { stdout: '', code: 1 }, 'done\n']),
    }));
    const exited = await jobStatus(finished, config, jobId, 0);
    assert.equal(exited.ok, true);
    if (!exited.ok) return;
    assert.equal(exited.data.state, 'exited');
    assert.equal(exited.data.exit_code, 0);

    const killer = new ScriptedConnection(() => ({ stdout: '' }));
    const killed = await killJob(killer, config, jobId);
    assert.equal(killed.ok, true);
    if (killed.ok) assert.equal(killed.data.state, 'killed');
  });

  it('refuses unknown job ids', async () => {
    const config = loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root' });
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const status = await jobStatus(conn, config, 'deadbeef', 0);
    assert.equal(status.ok, false);
    if (!status.ok) assert.equal(status.error.code, 'E_NOTFOUND');
  });
});

describe('svc_action', () => {
  beforeEach(() => resetConfirmations());

  it('refuses lockout units before confirmation', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    for (const unit of ['sshd', 'sshd.service', 'systemd-logind', 'dbus', 'NetworkManager']) {
      const result = await svcActionTool.handler(
        { unit, action: 'restart', dry_run: false },
        context(conn, { ARCH_MCP_MODE: 'write' }),
      );
      assert.equal(result.ok, false, unit);
      if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    }
    assert.equal(conn.calls.length, 0);
  });

  it('previews with dry_run and requires a token otherwise', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const preview = await svcActionTool.handler(
      { unit: 'nginx.service', action: 'restart', dry_run: true },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(preview.ok, true);

    const confirm = await svcActionTool.handler(
      { unit: 'nginx.service', action: 'restart', dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(confirm);
    assert.match(token, /^[0-9a-f]{8}$/);
    assert.equal(conn.calls.length, 0);
  });

  it('executes once with the token', async () => {
    const conn = new ScriptedConnection((line) =>
      line.includes('show')
        ? { stdout: 'ActiveState=active\nSubState=running\n' }
        : { stdout: '' },
    );
    const first = await svcActionTool.handler(
      { unit: 'nginx.service', action: 'restart', dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(first);
    const done = await svcActionTool.handler(
      { unit: 'nginx.service', action: 'restart', dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(done.ok, true);
    if (!done.ok) return;
    const data = done.data.data as Record<string, unknown>;
    assert.equal(data.unit, 'nginx.service');
    assert.equal(data.active, 'active');
    assert.ok(conn.calls.some((line) => line.includes('systemctl restart nginx.service')));

    const reused = await svcActionTool.handler(
      { unit: 'nginx.service', action: 'restart', dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(reused.ok, false);
    if (!reused.ok) assert.equal(reused.error.code, 'E_CONFIRM');
  });

  it('reports a failed start as job_failed instead of E_PERM', async () => {
    const conn = new ScriptedConnection((line) => {
      if (line.includes('systemctl start')) {
        return {
          stdout: '',
          code: 1,
          stderr: 'Job for app.service failed because the control process exited with error code.',
        };
      }
      if (line.includes('show')) return { stdout: 'ActiveState=failed\nSubState=failed\n' };
      return { stdout: '' };
    });
    const first = await svcActionTool.handler(
      { unit: 'app.service', action: 'start', dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(first);
    const done = await svcActionTool.handler(
      { unit: 'app.service', action: 'start', dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(done.ok, true);
    if (!done.ok) return;
    const data = done.data.data as Record<string, unknown>;
    assert.equal(data.active, 'failed');
    assert.equal(data.job_failed, true);
    assert.match(String(data.error), /control process exited/);
  });

  it('keeps E_PERM only for permission errors', async () => {
    const conn = new ScriptedConnection((line) => {
      if (line.includes('systemctl start')) {
        return { stdout: '', code: 1, stderr: 'Failed to start app.service: Access denied' };
      }
      if (line.includes('show')) return { stdout: 'ActiveState=inactive\nSubState=dead\n' };
      return { stdout: '' };
    });
    const first = await svcActionTool.handler(
      { unit: 'app.service', action: 'start', dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(first);
    const done = await svcActionTool.handler(
      { unit: 'app.service', action: 'start', dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(done.ok, false);
    if (!done.ok) assert.equal(done.error.code, 'E_PERM');
  });
});

describe('fs_write', () => {
  beforeEach(() => resetConfirmations());

  it('refuses system paths', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    for (const path of ['/etc/nginx.conf', '/boot/loader.conf', '/usr/bin/x', '/root/.ssh/authorized_keys']) {
      const result = await fsWriteTool.handler(
        { path, content: 'x', dry_run: true },
        context(conn, { ARCH_MCP_MODE: 'write' }),
      );
      assert.equal(result.ok, false, path);
      if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    }
    assert.equal(conn.calls.length, 0);
  });

  it('writes content over stdin after confirmation', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const first = await fsWriteTool.handler(
      { path: '/tmp/test.conf', content: 'hello\n', mode: '640', dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(first);
    const done = await fsWriteTool.handler(
      { path: '/tmp/test.conf', content: 'hello\n', mode: '640', dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(done.ok, true);
    assert.equal(conn.inputs[0], 'hello\n');
    assert.ok(conn.calls.some((line) => line.includes('chmod 640')));
  });
});

describe('pkg mutations', () => {
  beforeEach(() => resetConfirmations());

  it('pkg_update dry_run only reads pending updates', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'bash 5.3.20-1 -> 5.3.21-1\n' }));
    const result = await pkgUpdateTool.handler({ dry_run: true }, context(conn, { ARCH_MCP_MODE: 'write' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.data.data as { updates: number }).updates, 1);
  });

  it('pkg_install previews and then confirms', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const preview = await pkgInstallTool.handler(
      { names: ['htop'], dry_run: true },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(preview.ok, true);

    const first = await pkgInstallTool.handler(
      { names: ['htop'], dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(first);
    const done = await pkgInstallTool.handler(
      { names: ['htop'], dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(done.ok, true);
    assert.ok(conn.calls.some((line) => line.includes('pacman -S --needed --noconfirm htop')));
  });

  it('maps "target not found" to E_NOTFOUND', async () => {
    const conn = new ScriptedConnection((line) =>
      line.includes('pacman -S')
        ? { stdout: '', code: 1, stderr: 'error: target not found: ghost' }
        : { stdout: '' },
    );
    const first = await pkgInstallTool.handler(
      { names: ['ghost'], dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    const token = tokenOf(first);
    const done = await pkgInstallTool.handler(
      { names: ['ghost'], dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'write' }),
    );
    assert.equal(done.ok, false);
    if (!done.ok) assert.equal(done.error.code, 'E_NOTFOUND');
  });
});

describe('raw_exec', () => {
  beforeEach(() => resetConfirmations());

  it('is off unless allowed and admin', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const disabled = await rawExecTool.handler(
      { argv: ['uname', '-r'], timeout_ms: 1000, dry_run: true },
      context(conn, { ARCH_MCP_MODE: 'admin' }),
    );
    assert.equal(disabled.ok, false);
    if (!disabled.ok) assert.equal(disabled.error.code, 'E_POLICY');

    const notAdmin = await rawExecTool.handler(
      { argv: ['uname', '-r'], timeout_ms: 1000, dry_run: true },
      context(conn, { ARCH_MCP_MODE: 'write', ARCH_MCP_ALLOW_RAW: '1' }),
    );
    assert.equal(notAdmin.ok, false);
    if (!notAdmin.ok) assert.equal(notAdmin.error.code, 'E_POLICY');
  });

  it('only accepts allowlisted binaries', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    for (const argv of [['bash', '-c', 'echo hi'], ['rm', '-rf', '/tmp/x'], ['docker', 'ps']]) {
      const result = await rawExecTool.handler(
        { argv, timeout_ms: 1000, dry_run: true },
        context(conn, { ARCH_MCP_MODE: 'admin', ARCH_MCP_ALLOW_RAW: '1' }),
      );
      assert.equal(result.ok, false, argv.join(' '));
      if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    }
  });

  it('runs an allowlisted command after confirmation', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'Linux host 7.0\n' }));
    const first = await rawExecTool.handler(
      { argv: ['uname', '-a'], timeout_ms: 1000, dry_run: false },
      context(conn, { ARCH_MCP_MODE: 'admin', ARCH_MCP_ALLOW_RAW: '1' }),
    );
    const token = tokenOf(first);
    const done = await rawExecTool.handler(
      { argv: ['uname', '-a'], timeout_ms: 1000, dry_run: false, token },
      context(conn, { ARCH_MCP_MODE: 'admin', ARCH_MCP_ALLOW_RAW: '1' }),
    );
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.match(String((done.data.data as { stdout: string }).stdout), /Linux host/);
  });
});
