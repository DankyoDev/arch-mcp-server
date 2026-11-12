import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import {
  fetchUrlTool,
  fwRuleTool,
  httpCheckTool,
  netDnsSetTool,
  netPingTool,
  netRouteTool,
  procReniceTool,
  usrActionTool,
} from '../src/tools/daily.js';
import {
  fsArchiveListTool,
  fsArchiveTool,
  fsChecksumTool,
  fsChmodTool,
  fsCopyTool,
  fsDuTool,
  fsMkdirTool,
  fsRemoveTool,
  fsSymlinkTool,
} from '../src/tools/fsops.js';
import type { ToolContext } from '../src/tools/registry.js';

interface Reply {
  stdout: string;
  code?: number;
  stderr?: string;
}

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];

  constructor(private readonly respond: (line: string) => Reply = () => ({ stdout: '' })) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
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

function context(
  conn: Connection,
  tools: Record<string, string> = {},
  user = 'dante',
): ToolContext {
  const capabilities: HostCapabilities = {
    os: { id: 'arch', name: 'Arch Linux' },
    kernel: '7.0',
    arch: 'x86_64',
    tools,
    features: {},
  };
  return {
    conn,
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: user }),
    capabilities: async () => ok(capabilities),
  };
}

function tokenOf(result: Awaited<ReturnType<typeof fsMkdirTool.handler>>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected E_CONFIRM');
  assert.equal(result.error.code, 'E_CONFIRM');
  return (result.error.data as { token: string }).token;
}

const base = { dry_run: false, token: undefined };

beforeEach(() => {
  resetConfirmations();
});

describe('fs_mkdir', () => {
  it('previews and then creates the directory', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { path: '/tmp/demo', mode: '750', parents: true, ...base };
    const first = await fsMkdirTool.handler(input, ctx);
    assert.equal(first.ok, false);
    if (first.ok) return;
    assert.equal(first.error.code, 'E_CONFIRM');
    const second = await fsMkdirTool.handler({ ...input, token: tokenOf(first) }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('mkdir -p -m 750 /tmp/demo'));
  });

  it('refuses system paths', async () => {
    const result = await fsMkdirTool.handler(
      { path: '/etc/nginx', mode: '755', parents: true, ...base },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });
});

describe('fs_remove and fs_chmod', () => {
  it('refuses a system root', async () => {
    const result = await fsRemoveTool.handler(
      { path: '/var', recursive: true, ...base },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });

  it('removes a user path with a token', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { path: '/tmp/old', recursive: true, ...base };
    const first = await fsRemoveTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await fsRemoveTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('rm -rf /tmp/old'));
  });

  it('refuses ~/.ssh in chmod', async () => {
    const result = await fsChmodTool.handler(
      { path: '/home/dante/.ssh/id_ed25519', mode: '644', recursive: false, ...base },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });
});

describe('fs_copy', () => {
  it('refuses a credential source', async () => {
    const result = await fsCopyTool.handler(
      {
        source: '/home/dante/.ssh/id_ed25519',
        destination: '/tmp/key',
        recursive: false,
        preserve: false,
        overwrite: false,
        ...base,
      },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });

  it('refuses to overwrite an existing file without overwrite=true', async () => {
    const conn = new ScriptedConnection((line) =>
      line.includes('stat -c %F') ? { stdout: 'regular file\n' } : { stdout: '' },
    );
    const ctx = context(conn);
    const input = {
      source: '/tmp/a',
      destination: '/tmp/b',
      recursive: false,
      preserve: false,
      overwrite: false,
      ...base,
    };
    const first = await fsCopyTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await fsCopyTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'E_POLICY');
  });
});

describe('fs_checksum and fs_du', () => {
  it('parses a checksum', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd  /tmp/x\n',
    }));
    const result = await fsChecksumTool.handler({ path: '/tmp/x', algorithm: 'sha256' }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.hash, 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd');
  });

  it('sorts du output largest first', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '100\t/tmp/a\n300\t/tmp/b\n' }));
    const result = await fsDuTool.handler({ path: '/tmp', depth: 1, limit: 10 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rows = result.data.data as Array<{ path: string; size_b: number }>;
    assert.deepEqual(rows.map((row) => row.path), ['/tmp/b', '/tmp/a']);
  });
});

describe('fs_archive', () => {
  it('creates and lists a tar archive', async () => {
    const conn = new ScriptedConnection((line) =>
      line.includes('tar -tf') ? { stdout: 'x/a\nx/b\n' } : { stdout: '' },
    );
    const ctx = context(conn);
    const input = { action: 'create' as const, archive: '/tmp/x.tar', source: '/tmp/x', format: 'tar' as const, ...base };
    const first = await fsArchiveTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await fsArchiveTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('tar -cf /tmp/x.tar -C /tmp x'));

    const listed = await fsArchiveListTool.handler({ archive: '/tmp/x.tar', format: 'tar', limit: 10 }, ctx);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const data = listed.data.data as { entries: string[] };
    assert.deepEqual(data.entries, ['x/a', 'x/b']);
  });
});

describe('fetch_url and http_check', () => {
  it('downloads and reports bytes', async () => {
    const hash = 'a'.repeat(64);
    const conn = new ScriptedConnection((line) => {
      if (line.includes('curl')) return { stdout: '' };
      if (line.includes('stat -c %s')) return { stdout: '1234\n' };
      if (line.includes('sha256sum')) return { stdout: `${hash}  /tmp/file\n` };
      return { stdout: '' };
    });
    const ctx = context(conn, { curl: '/usr/bin/curl' });
    const input = {
      url: 'https://example.com/file',
      path: '/tmp/file',
      max_bytes: 1_000_000,
      timeout_ms: 10_000,
      sha256: hash,
      ...base,
    };
    const first = await fetchUrlTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await fetchUrlTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const data = second.data.data as Record<string, unknown>;
    assert.equal(data.bytes, 1234);
    assert.equal(data.sha256, hash);
  });

  it('reports status, latency and bytes', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: '200 0.123 45\n' }));
    const result = await httpCheckTool.handler(
      { url: 'https://example.com', method: 'HEAD', timeout_ms: 5000 },
      context(conn, { curl: '/usr/bin/curl' }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.status, 200);
    assert.equal(data.ms, 123);
    assert.equal(data.bytes, 45);
    assert.equal(data.ok, true);
  });
});

describe('net_ping', () => {
  it('parses packet loss and rtt', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout:
        '4 packets transmitted, 4 received, 0% packet loss, time 3004ms\n' +
        'rtt min/avg/max/mdev = 0.030/0.040/0.050/0.005 ms\n',
    }));
    const result = await netPingTool.handler({ host: '127.0.0.1', count: 4, timeout_ms: 5000 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.loss_pct, 0);
    assert.deepEqual(data.rtt_ms, { min: 0.03, avg: 0.04, max: 0.05 });
  });
});

describe('usr_action', () => {
  it('refuses root and the MCP user', async () => {
    for (const name of ['root', 'dante']) {
      const result = await usrActionTool.handler(
        { action: 'lock', name, shell: '/bin/bash', groups: [], remove_home: false, ...base },
        context(new ScriptedConnection()),
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    }
  });

  it('creates a user after confirmation', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = {
      action: 'create' as const,
      name: 'archtest',
      shell: '/bin/bash' as const,
      groups: ['wheel'],
      remove_home: false,
      ...base,
    };
    const first = await usrActionTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await usrActionTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('useradd -m -s /bin/bash -G wheel archtest'));
  });
});

describe('daily extras', () => {
  it('creates a symlink after confirmation', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { target: '/tmp/target', link: '/tmp/link', force: false, ...base };
    const first = await fsSymlinkTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await fsSymlinkTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('ln -s /tmp/target /tmp/link'));
  });

  it('renices a process', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { pid: 123, nice: 5, ...base };
    const first = await procReniceTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await procReniceTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('renice -n 5 -p 123'));
  });

  it('sets DNS servers with resolvectl', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn, { resolvectl: '/usr/bin/resolvectl' });
    const input = { interface: 'eth0', servers: ['1.1.1.1', '9.9.9.9'], ...base };
    const first = await netDnsSetTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await netDnsSetTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('resolvectl dns eth0 1.1.1.1 9.9.9.9'));
    assert.ok(conn.calls[1]?.includes('resolvectl flush-caches'));
  });
});

describe('net_route and fw_rule', () => {
  it('refuses the default route', async () => {
    const result = await netRouteTool.handler(
      { action: 'add', destination: '0.0.0.0/0', ...base },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });

  it('adds a specific route after confirmation', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { action: 'add' as const, destination: '203.0.113.0/24', dev: 'eth0', ...base };
    const first = await netRouteTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await netRouteTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('ip route add 203.0.113.0/24 dev eth0'));
  });

  it('returns E_UNSUPPORTED without a firewall backend', async () => {
    const result = await fwRuleTool.handler(
      { action: 'allow', port: 8080, protocol: 'tcp', ...base },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_UNSUPPORTED');
  });

  it('allows a port through ufw after confirmation', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn, { ufw: '/usr/bin/ufw' });
    const input = { action: 'allow' as const, port: 8080, protocol: 'tcp' as const, ...base };
    const first = await fwRuleTool.handler(input, ctx);
    const token = tokenOf(first);
    const second = await fwRuleTool.handler({ ...input, token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('ufw allow 8080/tcp'));
  });
});
