import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { readGaps, redactArgv, summarizeGaps } from '../src/policy/gaps.js';
import { execAnyTool, execGapsTool, execTool, gapReportTool, scriptRunTool } from '../src/tools/exec.js';
import type { ToolContext } from '../src/tools/registry.js';

interface Reply {
  stdout: string;
  code?: number;
  stderr?: string;
}

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];
  readonly inputs: Array<string | undefined> = [];

  constructor(private readonly respond: (line: string) => Reply = () => ({ stdout: '' })) {}

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
  features: {},
};

const dir = mkdtempSync(join(tmpdir(), 'arch-mcp-exec-'));

function context(conn: Connection, env: Record<string, string> = {}): ToolContext {
  const config = loadConfig({
    ARCH_MCP_HOST: 'test',
    ARCH_MCP_USER: 'root',
    ARCH_MCP_GAP_LOG: join(dir, `${randomUUID()}.jsonl`),
    ...env,
  });
  return { conn, config, capabilities: async () => ok(capabilities) };
}

const base = {
  timeout_ms: 1000,
  max_bytes: 4096,
  dry_run: false,
  token: undefined,
};

beforeEach(() => {
  resetConfirmations();
});

describe('exec', () => {
  it('refuses binaries outside the allowlist', async () => {
    const conn = new ScriptedConnection();
    const result = await execTool.handler({ ...base, argv: ['not-a-real-binary'] }, context(conn));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
    assert.equal(conn.calls.length, 0);
  });

  it('previews without running', async () => {
    const conn = new ScriptedConnection();
    const result = await execTool.handler(
      { ...base, argv: ['rg', 'TODO', 'src'], dry_run: true },
      context(conn),
    );
    assert.equal(result.ok, true);
    assert.equal(conn.calls.length, 0);
  });

  it('runs after confirmation and records a redacted gap', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'src/a.ts:1:TODO\n' }));
    const ctx = context(conn);
    const first = await execTool.handler({ ...base, argv: ['rg', 'TODO', 'src'] }, ctx);
    assert.equal(first.ok, false);
    if (first.ok) return;
    assert.equal(first.error.code, 'E_CONFIRM');

    const second = await execTool.handler(
      { ...base, argv: ['rg', 'TODO', 'src'], token: (first.error.data as { token: string }).token },
      ctx,
    );
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('rg TODO src'));

    const gaps = readGaps(ctx.config);
    assert.equal(gaps[0]?.binary, 'rg');
    assert.equal(gaps[0]?.native, false);
  });

  it('blocks find -exec through the denylist', async () => {
    const conn = new ScriptedConnection();
    const result = await execTool.handler(
      { ...base, argv: ['find', '/tmp', '-exec', 'rm', '{}', ';'], dry_run: true },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });
});

describe('exec_any', () => {
  it('is disabled unless explicitly enabled', async () => {
    const result = await execAnyTool.handler({ ...base, argv: ['croc', '--help'] }, context(new ScriptedConnection()));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });

  it('refuses interpreters even in admin mode', async () => {
    const ctx = context(new ScriptedConnection(), {
      ARCH_MCP_MODE: 'admin',
      ARCH_MCP_ALLOW_ANY_EXEC: '1',
    });
    const result = await execAnyTool.handler({ ...base, argv: ['bash', '-c', 'id'] }, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'E_POLICY');
      assert.match(result.error.message, /interpreter/);
    }
  });

  it('runs an arbitrary binary after confirmation', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'croc 10.0\n' }));
    const ctx = context(conn, { ARCH_MCP_MODE: 'admin', ARCH_MCP_ALLOW_ANY_EXEC: '1' });
    const first = await execAnyTool.handler({ ...base, argv: ['croc', '--version'] }, ctx);
    assert.equal(first.ok, false);
    if (first.ok) return;
    const second = await execAnyTool.handler(
      { ...base, argv: ['croc', '--version'], token: (first.error.data as { token: string }).token },
      ctx,
    );
    assert.equal(second.ok, true);
    assert.equal(readGaps(ctx.config)[0]?.binary, 'croc');
  });
});

describe('script_run', () => {
  it('is disabled unless explicitly enabled', async () => {
    const result = await scriptRunTool.handler(
      { language: 'python', source: 'print(1)', args: [], timeout_ms: 1000, max_bytes: 4096, keep: false, dry_run: false },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });

  it('writes inline code, runs it and cleans up', async () => {
    const conn = new ScriptedConnection((line) =>
      line.includes('python3 ') ? { stdout: '42\n' } : { stdout: '' },
    );
    const ctx = context(conn, { ARCH_MCP_MODE: 'admin', ARCH_MCP_ALLOW_SCRIPTS: '1' });
    const input = {
      language: 'python' as const,
      source: 'print(42)',
      args: [],
      timeout_ms: 1000,
      max_bytes: 4096,
      keep: false,
      dry_run: false,
      token: undefined,
    };
    const first = await scriptRunTool.handler(input, ctx);
    assert.equal(first.ok, false);
    if (first.ok) return;
    const second = await scriptRunTool.handler({ ...input, token: (first.error.data as { token: string }).token }, ctx);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const data = second.data.data as Record<string, unknown>;
    assert.equal(data.stdout, '42\n');

    assert.ok(conn.calls.some((line) => line.includes('cat > "$1"')));
    assert.ok(conn.inputs.some((value) => value === 'print(42)'));
    assert.ok(conn.calls.some((line) => line.includes('python3 /tmp/arch-mcp-')));
    assert.ok(conn.calls.some((line) => line.includes('rm -f /tmp/arch-mcp-')));
  });

  it('runs an existing script without writing', async () => {
    const conn = new ScriptedConnection(() => ({ stdout: 'ok\n' }));
    const ctx = context(conn, { ARCH_MCP_MODE: 'admin', ARCH_MCP_ALLOW_SCRIPTS: '1' });
    const input = {
      language: 'bash' as const,
      path: '/tmp/existing.sh',
      args: ['a', 'b'],
      timeout_ms: 1000,
      max_bytes: 4096,
      keep: false,
      dry_run: false,
      token: undefined,
    };
    const first = await scriptRunTool.handler(input, ctx);
    assert.equal(first.ok, false);
    if (first.ok) return;
    const second = await scriptRunTool.handler({ ...input, token: (first.error.data as { token: string }).token }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('bash /tmp/existing.sh a b'));
    assert.equal(conn.inputs[0], undefined);
  });
});

describe('gap reporting', () => {
  it('summarises repeated binaries', async () => {
    const ctx = context(new ScriptedConnection());
    const first = await execTool.handler(
      { ...base, argv: ['curl', '--token', 'secret-value', 'https://user:pass@example.com/x'], dry_run: false },
      ctx,
    );
    assert.equal(first.ok, false);
    if (first.ok) return;
    await execTool.handler(
      { ...base, argv: ['curl', '--token', 'secret-value', 'https://user:pass@example.com/x'], token: (first.error.data as { token: string }).token },
      ctx,
    );
    await gapReportTool.handler({ binary: 'croc', argv: ['croc', 'send', 'x'], note: 'plain ssh', exit: 0 }, ctx);

    const result = await execGapsTool.handler({ limit: 10 }, ctx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { total: number; binaries: Array<{ binary: string; count: number }> };
    assert.equal(data.total, 2);
    assert.deepEqual(
      data.binaries.map((entry) => entry.binary),
      ['croc', 'curl'],
    );
    const raw = readFileSync(ctx.config.gapLog, 'utf8');
    assert.ok(!raw.includes('secret-value'));
    assert.ok(raw.includes('[redacted]'));
  });

  it('redacts flag values and URL userinfo', () => {
    assert.deepEqual(redactArgv(['tool', '--password', 'hunter2', '--token=abc', 'PASSWORD=xyz']), [
      'tool',
      '--password',
      '[redacted]',
      '--token=[redacted]',
      'PASSWORD=[redacted]',
    ]);
    assert.deepEqual(redactArgv(['curl', 'https://user:pass@host/x']), ['curl', 'https://[redacted]@host/x']);
  });

  it('summarise keeps first and last timestamps', () => {
    const summary = summarizeGaps([
      { ts: '2026-01-01T00:00:00.000Z', host: 'a', binary: 'rg', argv: ['rg'], exit: 0, ms: 1, stdout_b: 0, native: false, reason: 'x' },
      { ts: '2026-01-02T00:00:00.000Z', host: 'b', binary: 'rg', argv: ['rg', 'x'], exit: 0, ms: 1, stdout_b: 0, native: false, reason: 'y' },
    ]);
    assert.equal(summary[0]?.count, 2);
    assert.equal(summary[0]?.first, '2026-01-01T00:00:00.000Z');
    assert.equal(summary[0]?.last, '2026-01-02T00:00:00.000Z');
    assert.deepEqual(summary[0]?.hosts, ['a', 'b']);
  });
});
