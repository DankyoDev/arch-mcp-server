import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { tokenOf } from './confirmation.js';
import type { ToolContext } from '../src/tools/registry.js';
import { svcUnitDeleteTool, svcUnitWriteTool } from '../src/tools/units.js';

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];
  readonly inputs: Array<string | undefined> = [];

  constructor(private readonly respond: (line: string) => { stdout?: string; code?: number; stderr?: string } = () => ({})) {}

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
  tools: {},
  features: {},
};

function context(conn: Connection): ToolContext {
  return {
    conn,
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root' }),
    capabilities: async () => ok(capabilities),
  };
}

const unit = 'arch-mcp-test.service';
const content = '[Unit]\nDescription=arch-mcp test\n[Service]\nType=oneshot\nExecStart=/bin/true\n';

beforeEach(() => {
  resetConfirmations();
});

describe('svc_unit_write', () => {
  it('previews without writing', async () => {
    const conn = new ScriptedConnection();
    const result = await svcUnitWriteTool.handler({ unit, content, enable: false, dry_run: true }, context(conn));
    assert.equal(result.ok, true);
    assert.equal(conn.calls.length, 0);
  });

  it('writes, reloads and enables after confirmation', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { unit, content, enable: true, dry_run: false, token: undefined };
    const first = await svcUnitWriteTool.handler(input, ctx);
    const second = await svcUnitWriteTool.handler({ ...input, token: tokenOf(first) }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('cat > "$1"'));
    assert.equal(conn.inputs[0], content);
    assert.ok(conn.calls[1]?.includes('systemctl daemon-reload'));
    assert.ok(conn.calls[2]?.includes('systemctl enable arch-mcp-test.service'));
  });

  it('rejects a path-traversal unit name', async () => {
    const result = await svcUnitWriteTool.handler(
      { unit: '../../etc/passwd', content, enable: false, dry_run: true },
      context(new ScriptedConnection()),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_POLICY');
  });
});

describe('svc_unit_delete', () => {
  it('disables, removes and reloads after confirmation', async () => {
    const conn = new ScriptedConnection();
    const ctx = context(conn);
    const input = { unit, dry_run: false, token: undefined };
    const first = await svcUnitDeleteTool.handler(input, ctx);
    const second = await svcUnitDeleteTool.handler({ ...input, token: tokenOf(first) }, ctx);
    assert.equal(second.ok, true);
    assert.ok(conn.calls[0]?.includes('systemctl disable arch-mcp-test.service'));
    assert.ok(conn.calls[1]?.includes('rm -f /etc/systemd/system/arch-mcp-test.service'));
    assert.ok(conn.calls[2]?.includes('systemctl daemon-reload'));
  });
});
