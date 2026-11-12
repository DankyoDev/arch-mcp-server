import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import type { HostCapabilities } from '../src/caps.js';
import { logQueryTool, logUnitTailTool } from '../src/tools/log.js';
import { svcFailedTool, svcStatusTool } from '../src/tools/svc.js';
import type { ToolContext } from '../src/tools/registry.js';
import { loadFixture } from './helpers/fixtures.js';

class FixtureConnection implements Connection {
  readonly kind = 'local' as const;
  readonly lines: string[] = [];

  constructor(private readonly respond: (line: string) => string) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.lines.push(line);
    return { code: 0, stdout: this.respond(line), stderr: '', ms: 1, timedOut: false, truncated: false };
  }

  close(): void {}
}

const config = loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'root' });
const capabilities: HostCapabilities = {
  os: { id: 'arch', name: 'Arch Linux' },
  kernel: '7.0',
  arch: 'x86_64',
  tools: {},
  features: {},
};

function context(conn: Connection): ToolContext {
  return { conn, config, capabilities: async () => ok(capabilities) };
}

describe('svc_status tool', () => {
  it('parses the captured unit properties', async () => {
    const conn = new FixtureConnection(() => loadFixture('systemctl-show-sshd').stdout);
    const result = await svcStatusTool.handler({ unit: 'sshd.service', detail: 'concise' }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Record<string, unknown>;
    assert.equal(data.state, 'active');
    assert.equal(data.sub, 'running');
    assert.equal(data.exec, '/usr/bin/sshd');
    assert.equal(data.unit_file, undefined);
    assert.match(String(data.since), /^2026-\d{2}-\d{2}T/);
  });

  it('returns E_NOTFOUND for a unit systemd does not know', async () => {
    const conn = new FixtureConnection(() => 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n');
    const result = await svcStatusTool.handler({ unit: 'nope.service', detail: 'concise' }, context(conn));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_NOTFOUND');
  });
});

describe('svc_failed tool', () => {
  it('returns a tiny payload when nothing failed', async () => {
    const conn = new FixtureConnection(() => '[]');
    const result = await svcFailedTool.handler({ lines: 10 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.data, { count: 0, units: [] });
    assert.equal(conn.lines.length, 1, 'must not call the journal when there are no failures');
  });
});

describe('log_query tool', () => {
  it('returns the most recent page with compact fields', async () => {
    const conn = new FixtureConnection(() => loadFixture('journal-50').stdout);
    const result = await logQueryTool.handler(
      { limit: 10, detail: 'concise', cursor: undefined, grep: undefined, unit: undefined, priority: undefined, since: undefined, until: undefined },
      context(conn),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const page = result.data.data as Array<Record<string, unknown>>;
    assert.equal(page.length, 10);
    assert.deepEqual(Object.keys(page[0] ?? {}).sort(), ['msg', 'prio', 'ts']);
    assert.equal(result.data.cursor, 'b2Zmc2V0OjEw');
  });

  it('filters by message text before paginating', async () => {
    const conn = new FixtureConnection(() => loadFixture('journal-50').stdout);
    const result = await logQueryTool.handler(
      { limit: 50, detail: 'concise', grep: 'session opened', cursor: undefined, unit: undefined, priority: undefined, since: undefined, until: undefined },
      context(conn),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const page = result.data.data as Array<Record<string, unknown>>;
    assert.ok(page.length > 0);
    assert.ok(page.every((entry) => String(entry.msg).includes('session opened')));
  });
});

describe('log_unit_tail tool', () => {
  it('returns the last lines of one real unit', async () => {
    const conn = new FixtureConnection(() => loadFixture('journal-unit-sshd').stdout);
    const result = await logUnitTailTool.handler({ unit: 'sshd.service', lines: 5 }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const entries = result.data.data as Array<Record<string, unknown>>;
    assert.equal(entries.length, 5);
    assert.ok(entries.every((entry) => typeof entry.msg === 'string' && entry.msg !== ''));
    assert.ok(conn.lines[0]?.includes('journalctl -u sshd.service -n 5'));
  });
});
