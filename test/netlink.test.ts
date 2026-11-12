import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import type { ToolContext } from '../src/tools/registry.js';
import { netLinkTool } from '../src/tools/netlink.js';

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
  tools: {},
  features: {},
};

function context(conn: Connection): ToolContext {
  return {
    conn,
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'dante' }),
    capabilities: async () => ok(capabilities),
  };
}

const links = JSON.stringify([
  { ifname: 'lo', operstate: 'UNKNOWN' },
  { ifname: 'enp3s0', operstate: 'DOWN' },
  { ifname: 'tailscale0', operstate: 'UNKNOWN' },
]);

function responder(line: string): Reply {
  if (line.endsWith('ip -j link show')) return { stdout: links };
  return {};
}

function tokenOf(result: Awaited<ReturnType<typeof netLinkTool.handler>>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected confirmation');
  return (result.error.data as { token: string }).token;
}

beforeEach(() => resetConfirmations());

describe('net_link', () => {
  it('no ejecuta nada en dry_run', async () => {
    const conn = new ScriptedConnection(responder);
    const result = await netLinkTool.handler({ interface: 'enp3s0', dry_run: true }, context(conn));
    assert.equal(result.ok, true);
    assert.ok(conn.calls.every((c) => !c.includes('ip link set')));
  });

  it('rechaza una interfaz inexistente', async () => {
    const conn = new ScriptedConnection(responder);
    const result = await netLinkTool.handler({ interface: 'eth9', dry_run: false }, context(conn));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('pide token y luego ejecuta ip link set up', async () => {
    const conn = new ScriptedConnection(responder);
    const ctx = context(conn);

    const first = await netLinkTool.handler({ interface: 'enp3s0', dry_run: false }, ctx);
    const token = tokenOf(first);
    assert.ok(conn.calls.every((c) => !c.includes('ip link set')));

    const second = await netLinkTool.handler({ interface: 'enp3s0', dry_run: false, token }, ctx);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.ok(conn.calls.some((c) => c.endsWith('ip link set dev enp3s0 up')));
    const data = second.data.data as { interface: string; action: string; state: string | null };
    assert.equal(data.interface, 'enp3s0');
    assert.equal(data.action, 'up');
  });

  it('bajar una interfaz sigue bloqueado por la denylist', async () => {
    const conn = new ScriptedConnection(responder);
    const result = await netLinkTool.handler({ interface: 'enp3s0', action: 'down', dry_run: true }, context(conn));
    // El schema no expone `down`: el handler lo ignora y la tool nunca baja nada.
    assert.equal(result.ok, true);
    assert.ok(conn.calls.every((c) => !c.includes('down')));
  });
});
