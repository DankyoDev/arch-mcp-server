import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { fsReadTool, isSensitivePath } from '../src/tools/fs.js';
import { netCheckTool, netPortsTool } from '../src/tools/net.js';
import { pkgInfoTool, pkgOwnsTool } from '../src/tools/pkg.js';
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
    tools: features.pacman === true ? { pacman: '/usr/bin/pacman' } : {},
    features,
  };
  return { conn, config, capabilities: async () => ok(capabilities) };
}

function marked(sections: string[]): string {
  return sections
    .map((stdout, index) => `\u001e${index}\n${stdout}\u001f0\n`)
    .join('');
}

describe('fs_read', () => {
  it('refuses credential stores before touching the host', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    for (const path of ['/etc/shadow', '/etc/sudoers', '/etc/sudoers.d/site', '/root/.ssh/id_ed25519']) {
      const result = await fsReadTool.handler({ path, offset: 0, lines: 10 }, context(conn));
      assert.equal(result.ok, false, path);
      if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    }
    assert.equal(conn.calls.length, 0);
  });

  it('flags sensitive paths', () => {
    assert.equal(isSensitivePath('/etc/shadow'), true);
    assert.equal(isSensitivePath('/home/me/.ssh/id_rsa'), true);
    assert.equal(isSensitivePath('/home/me/.ssh/config'), false);
    assert.equal(isSensitivePath('/etc/pacman.conf'), false);
  });

  it('returns the requested slice with the total line count', async () => {
    const stdout = marked([
      loadFixture('head-pacman-conf').stdout,
      loadFixture('wc-pacman-conf').stdout,
      loadFixture('sed-pacman-conf').stdout,
    ]);
    const conn = new ScriptedConnection(() => ({ stdout }));
    const result = await fsReadTool.handler({ path: '/etc/pacman.conf', offset: 0, lines: 20 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.total_lines, 106);
    assert.ok(Array.isArray(data.lines) && data.lines.length > 3);
    assert.match(String((data.lines as string[])[0]), /^#/);
    assert.equal(conn.calls.length, 1, 'head, wc and sed share one round trip');
  });

  it('rejects binaries', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: marked(['\u0000\u0001binary', '1', 'x']) }));
    const result = await fsReadTool.handler({ path: '/usr/bin/foo', offset: 0, lines: 10 }, context(conn));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_UNSUPPORTED');
  });
});

describe('net_check', () => {
  it('rejects a malformed target without executing anything', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    for (const target of ['http://example.com', 'host:99999', 'a b:22']) {
      const result = await netCheckTool.handler({ target, timeout_ms: 1000 }, context(conn));
      assert.equal(result.ok, false, target);
      if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    }
    assert.equal(conn.calls.length, 0);
  });

  it('reports success and latency on exit 0', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const result = await netCheckTool.handler({ target: '127.0.0.1:22', timeout_ms: 1000 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.data.data as { ok: boolean }).ok, true);
    assert.match(conn.calls[0] ?? '', /\/dev\/tcp/);
    assert.ok((conn.calls[0] ?? '').includes('127.0.0.1'));
    assert.ok((conn.calls[0] ?? '').includes('22'));
  });

  it('reports a failed connection with the error text', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '', code: 1 }));
    const result = await netCheckTool.handler({ target: 'nope:22', timeout_ms: 1000 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.data.data as { ok: boolean }).ok, false);
  });
});

describe('net_ports', () => {
  it('finds a specific port with its process', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('ss-ports').stdout }));
    const result = await netPortsTool.handler(
      { port: 22, proto: 'tcp', limit: 50 },
      context(conn, { iproute2: true }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, 'IPv4 and IPv6 listeners both count');
    assert.ok(rows.every((row) => row.port === 22 && row.proc === 'sshd'));
  });
});

describe('pkg tools', () => {
  it('pkg_info prefers installed data', async () => {
    const conn = new ScriptedConnection((line) =>
      line.includes('pacman -Qi')
        ? { stdout: loadFixture('pacman-qi-bash').stdout }
        : { stdout: '', code: 1 },
    );
    const result = await pkgInfoTool.handler({ name: 'bash' }, context(conn, { pacman: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.installed, true);
    assert.equal(data.version, '5.3.20-1');
    assert.ok(Number(data.size_b) > 0);
    assert.ok(Array.isArray(data.deps) && (data.deps as string[]).includes('readline'));
  });

  it('pkg_info falls back to the remote index', async () => {
    const remote = 'Repository      : core\nName            : htop\nVersion         : 3.4.1-1\nDownload Size   : 200.00 KiB\nDepends On      : ncurses\n';
    const conn = new ScriptedConnection((line) =>
      line.includes('pacman -Qi') ? { stdout: '', code: 1 } : { stdout: remote },
    );
    const result = await pkgInfoTool.handler({ name: 'htop' }, context(conn, { pacman: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.installed, false);
    assert.equal(data.version, '3.4.1-1');
    assert.equal(data.repo, 'core');
  });

  it('pkg_info reports E_NOTFOUND when neither query works', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '', code: 1 }));
    const result = await pkgInfoTool.handler({ name: 'ghost' }, context(conn, { pacman: true }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('pkg_owns returns the owning package', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: loadFixture('pacman-qo-bash').stdout }));
    const result = await pkgOwnsTool.handler({ path: '/usr/bin/bash' }, context(conn, { pacman: true }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.data, {
      path: '/usr/bin/bash',
      package: 'bash',
      version: '5.3.20-1',
    });
  });

  it('pkg tools return E_UNSUPPORTED without pacman', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '' }));
    const result = await pkgInfoTool.handler({ name: 'bash' }, context(conn, { pacman: false }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_UNSUPPORTED');
    assert.equal(conn.calls.length, 0);
  });
});
