import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { SudoConnection } from '../src/connection/sudo.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { runCommand } from '../src/exec/run.js';

class RecordingConnection implements Connection {
  readonly kind = 'ssh' as const;
  readonly calls: string[] = [];

  constructor(private readonly reply: { code?: number; stdout?: string; stderr?: string } = {}) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
    return {
      code: this.reply.code ?? 0,
      stdout: this.reply.stdout ?? '',
      stderr: this.reply.stderr ?? '',
      ms: 1,
      timedOut: false,
      truncated: false,
    };
  }

  close(): void {}
}

function config(env: Record<string, string>) {
  return loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'dante', ...env });
}

describe('SudoConnection', () => {
  it('does nothing when sudo is disabled', async () => {
    const inner = new RecordingConnection();
    const conn = new SudoConnection(inner, config({ ARCH_MCP_ALLOW_SUDO: '0' }));
    await conn.exec('env LANG=C cat /etc/hostname', { argv: ['cat', '/etc/hostname'] });
    assert.equal(inner.calls[0], 'env LANG=C cat /etc/hostname');
  });

  it('prefixes sudo -n for a single command', async () => {
    const inner = new RecordingConnection();
    const conn = new SudoConnection(inner, config({ ARCH_MCP_ALLOW_SUDO: '1' }));
    await conn.exec('env LANG=C cat /etc/shadow', { argv: ['cat', '/etc/shadow'] });
    assert.equal(inner.calls[0], 'sudo -n env LANG=C cat /etc/shadow');
  });

  it('wraps every section of a batched command', async () => {
    const inner = new RecordingConnection();
    const conn = new SudoConnection(inner, config({ ARCH_MCP_ALLOW_SUDO: '1' }));
    await conn.exec("printf '\\0360\\n'; env LANG=C cat /etc/os-release; printf '\\037%d\\n' \"$?\"");
    assert.match(inner.calls[0] ?? '', /^printf .*; sudo -n env LANG=C cat \/etc\/os-release; printf/);
  });

  it('honours ARCH_MCP_SUDO_ALLOW', async () => {
    const inner = new RecordingConnection();
    const conn = new SudoConnection(
      inner,
      config({ ARCH_MCP_ALLOW_SUDO: '1', ARCH_MCP_SUDO_ALLOW: 'systemctl restart,useradd' }),
    );
    await conn.exec('env LANG=C systemctl restart nginx', { argv: ['systemctl', 'restart', 'nginx'] });
    await conn.exec('env LANG=C cat /etc/hostname', { argv: ['cat', '/etc/hostname'] });
    assert.equal(inner.calls[0], 'sudo -n env LANG=C systemctl restart nginx');
    assert.equal(inner.calls[1], 'env LANG=C cat /etc/hostname');
  });

  it('turns a sudo password prompt into E_PERM', async () => {
    const inner = new RecordingConnection({ code: 1, stderr: 'sudo: a password is required' });
    const conn = new SudoConnection(inner, config({ ARCH_MCP_ALLOW_SUDO: '1' }));
    const result = await runCommand(conn, ['cat', '/etc/hostname'], {});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_PERM');
    assert.match(result.error.hint ?? '', /NOPASSWD/);
  });
});
