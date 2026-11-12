import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { tokenOf } from './confirmation.js';
import type { ToolContext } from '../src/tools/registry.js';
import { cronListTool, cronRemoveTool, cronWriteTool, parseCrontab } from '../src/tools/cron.js';

type Reply = { stdout?: string; code?: number; stderr?: string };

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];
  readonly inputs: Array<string | undefined> = [];

  constructor(private readonly respond: (line: string) => Reply = () => ({})) {}

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
    config: loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'dante' }),
    capabilities: async () => ok(capabilities),
  };
}

const crontab = '# m h dom mon dow command\n0 3 * * * /usr/bin/backup.sh\n*/5 * * * * echo hi\nMAILTO=root\n';

beforeEach(() => resetConfirmations());

describe('parseCrontab', () => {
  it('separa entradas, entorno y líneas inválidas', () => {
    const parsed = parseCrontab(crontab + 'esto no es cron\n');
    assert.equal(parsed.entries.length, 2);
    assert.deepEqual(parsed.entries[0], { schedule: '0 3 * * *', command: '/usr/bin/backup.sh' });
    assert.deepEqual(parsed.env, [{ name: 'MAILTO', value: 'root' }]);
    assert.deepEqual(parsed.invalid, ['esto no es cron']);
  });

  it('acepta macros', () => {
    const parsed = parseCrontab('@daily /usr/bin/rotate\n');
    assert.deepEqual(parsed.entries, [{ schedule: '@daily', command: '/usr/bin/rotate' }]);
  });
});

describe('cron_list', () => {
  it('devuelve exists:false cuando no hay crontab', async () => {
    const conn = new ScriptedConnection(() => ({ code: 1, stderr: 'no crontab for dante' }));
    const result = await cronListTool.handler({ raw: false }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.data, {
      user: null,
      exists: false,
      count: 0,
      entries: [],
      env: [],
      invalid: [],
    });
  });

  it('lista entradas del usuario indicado', async () => {
    const conn = new ScriptedConnection((line) =>
      line.endsWith('crontab -u root -l') ? { stdout: crontab } : {},
    );
    const result = await cronListTool.handler({ user: 'root', raw: false }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { count: number; entries: unknown[] };
    assert.equal(data.count, 2);
    assert.ok(conn.calls[0]?.endsWith('crontab -u root -l'));
  });
});

describe('cron_write', () => {
  it('no ejecuta nada en dry_run', async () => {
    const conn = new ScriptedConnection();
    const result = await cronWriteTool.handler(
      { content: crontab, dry_run: true },
      context(conn),
    );
    assert.equal(result.ok, true);
    assert.equal(conn.calls.length, 0);
  });

  it('rechaza CRLF', async () => {
    const conn = new ScriptedConnection();
    const result = await cronWriteTool.handler(
      { content: '0 3 * * * echo hi\r\n', dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_POLICY');
  });

  it('pide confirmación y luego escribe con stdin', async () => {
    let listed = 0;
    const conn = new ScriptedConnection((line) => {
      if (line.endsWith('crontab -l')) {
        listed += 1;
        return listed === 1
          ? { stdout: '0 1 * * * old.sh\n' }
          : { stdout: crontab };
      }
      return { code: 0 };
    });
    const ctx = context(conn);

    const first = await cronWriteTool.handler({ content: crontab, dry_run: false }, ctx);
    const token = tokenOf(first);
    assert.equal(conn.calls.length, 0);

    const second = await cronWriteTool.handler({ content: crontab, dry_run: false, token }, ctx);
    assert.equal(second.ok, true);
    if (!second.ok) return;

    const writeCall = conn.calls.find((c) => c.endsWith('crontab -'));
    assert.ok(writeCall, 'debe escribir con crontab -');
    const input = conn.inputs[conn.calls.findIndex((c) => c.endsWith('crontab -'))];
    assert.equal(input, crontab);

    const data = second.data.data as { written: boolean; count: number; backup: string | null };
    assert.equal(data.written, true);
    assert.equal(data.count, 2);
    assert.match(data.backup ?? '', /^\/tmp\/arch-mcp-crontab-\d+\.bak$/);
  });

  it('mapea error de privilegios', async () => {
    const conn = new ScriptedConnection((line) => {
      if (line.endsWith('crontab -u root -l')) return { stdout: '' };
      if (line.endsWith('crontab -u root -')) return { code: 1, stderr: 'crontab: must be privileged to use -u' };
      return {};
    });
    const ctx = context(conn);
    const first = await cronWriteTool.handler(
      { content: crontab, user: 'root', dry_run: false },
      ctx,
    );
    const token = tokenOf(first);
    const second = await cronWriteTool.handler(
      { content: crontab, user: 'root', dry_run: false, token },
      ctx,
    );
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, 'E_PERM');
  });
});

describe('cron_remove', () => {
  it('no hace nada si no hay crontab', async () => {
    const conn = new ScriptedConnection(() => ({ code: 1, stderr: 'no crontab for dante' }));
    const ctx = context(conn);
    const first = await cronRemoveTool.handler({ dry_run: false }, ctx);
    const token = tokenOf(first);
    const second = await cronRemoveTool.handler({ dry_run: false, token }, ctx);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(second.data.data, { user: null, removed: false, reason: 'no crontab' });
  });
});
