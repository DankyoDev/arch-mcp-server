import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { fsGrepTool } from '../src/tools/fs.js';
import type { ToolContext } from '../src/tools/registry.js';

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];

  constructor(
    private readonly reply: { stdout: string; code?: number; stderr?: string },
  ) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
    return {
      code: this.reply.code ?? 0,
      stdout: this.reply.stdout,
      stderr: this.reply.stderr ?? '',
      ms: 1,
      timedOut: false,
      truncated: false,
    };
  }

  close(): void {}
}

function context(conn: Connection, tools: Record<string, string> = {}): ToolContext {
  const capabilities: HostCapabilities = {
    os: { id: 'arch', name: 'Arch Linux' },
    kernel: '7.0',
    arch: 'x86_64',
    tools,
    features: {},
  };
  return {
    conn,
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root' }),
    capabilities: async () => ok(capabilities),
  };
}

const rgJson = [
  '{"type":"begin","data":{"path":{"text":"src/a.ts"}}}',
  '{"type":"match","data":{"path":{"text":"src/a.ts"},"lines":{"text":"const TODO = 1;\\n"},"line_number":3}}',
  '{"type":"summary","data":{}}',
].join('\n');

describe('fs_grep', () => {
  it('uses ripgrep and its JSON output when available', async () => {
    const conn = new ScriptedConnection({ stdout: rgJson });
    const result = await fsGrepTool.handler(
      { path: '/work', pattern: 'TODO', fixed: false, ignore_case: false, hidden: false, max_results: 50 },
      context(conn, { rg: '/usr/bin/rg' }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { total: number; matches: Array<Record<string, unknown>> };
    assert.equal(data.total, 1);
    assert.deepEqual(data.matches[0], { path: 'src/a.ts', line: 3, text: 'const TODO = 1;' });
    assert.ok(conn.calls[0]?.includes('rg --json'));
  });

  it('falls back to grep and maps exit 1 to an empty result', async () => {
    const conn = new ScriptedConnection({ stdout: '', code: 1 });
    const result = await fsGrepTool.handler(
      { path: '/etc', pattern: 'nope', fixed: true, ignore_case: true, hidden: false, max_results: 10 },
      context(conn),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { total: number; matches: unknown[] };
    assert.equal(data.total, 0);
    assert.deepEqual(data.matches, []);
    assert.ok(conn.calls[0]?.includes('grep -r -n -I -m 5'));
    assert.ok(conn.calls[0]?.includes('-F'));
    assert.ok(conn.calls[0]?.includes('-i'));
  });

  it('turns grep errors into E_INTERNAL', async () => {
    const conn = new ScriptedConnection({ stdout: '', code: 2, stderr: 'grep: /nope: No such file' });
    const result = await fsGrepTool.handler(
      { path: '/nope', pattern: 'x', fixed: false, ignore_case: false, hidden: false, max_results: 10 },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'E_INTERNAL');
      assert.match(result.error.hint ?? '', /No such file/);
    }
  });
});
