import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { TransportError } from '../src/connection/errors.js';
import { runCommand } from '../src/exec/run.js';
import { runSections } from '../src/exec/sequence.js';

class FakeConnection implements Connection {
  readonly kind = 'local' as const;
  readonly lines: string[] = [];

  constructor(private readonly stdout: string) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.lines.push(line);
    return { code: 0, stdout: this.stdout, stderr: '', ms: 1, timedOut: false, truncated: false };
  }

  close(): void {}
}

class TimeoutConnection extends FakeConnection {
  override async exec(): Promise<RawExecResult> {
    return { code: -1, stdout: '', stderr: '', ms: 1, timedOut: true, truncated: false };
  }
}

class TruncatedConnection extends FakeConnection {
  override async exec(): Promise<RawExecResult> {
    return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false, truncated: true };
  }
}

class RejectingConnection implements Connection {
  readonly kind = 'local' as const;

  constructor(
    private readonly code: 'E_CONN' | 'E_AUTH',
    private readonly message: string,
  ) {}

  async exec(): Promise<RawExecResult> {
    throw new TransportError({ code: this.code, message: this.message });
  }

  close(): void {}
}

const sections = [
  { key: 'a', argv: ['printf', 'hello'] },
  { key: 'b', argv: ['false'] },
];

describe('runSections', () => {
  it('splits marked sections and keeps per-command exit codes', async () => {
    const conn = new FakeConnection('\u001e0\nhello\n\u001f0\n\u001e1\n\u001f1\n');
    const result = await runSections(conn, sections);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.a?.stdout, 'hello\n');
    assert.equal(result.data.a?.code, 0);
    assert.equal(result.data.b?.stdout, '');
    assert.equal(result.data.b?.code, 1);
  });

  it('builds one shell line with quoted argv and markers', async () => {
    const conn = new FakeConnection('\u001e0\n\u001f0\n');
    await runSections(conn, [{ key: 'a', argv: ['echo', 'a b'] }]);
    assert.equal(conn.lines.length, 1);
    const line = conn.lines[0] ?? '';
    assert.match(line, /^printf '\\0360\\n'; env LANG=C/);
    assert.ok(line.includes("'a b'"));
    assert.ok(line.includes(`printf '\\037%d\\n' "$?"`));
  });

  it('fails with E_PARSE when a section is missing', async () => {
    const conn = new FakeConnection('\u001e0\nhello\n\u001f0\n');
    const result = await runSections(conn, sections);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_PARSE');
    assert.ok(result.error.hint !== undefined && result.error.hint.length <= 200);
  });

  it('fails with E_TRUNCATED when the raw read hits the cap', async () => {
    const result = await runSections(new TruncatedConnection(''), sections);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_TRUNCATED');
  });
});

describe('runCommand', () => {
  it('prefixes the stable remote environment', async () => {
    const conn = new FakeConnection('ok');
    await runCommand(conn, ['uname', '-r']);
    assert.equal(conn.lines[0], 'env LANG=C LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat uname -r');
  });

  it('maps a timeout to E_TIMEOUT with a hint', async () => {
    const result = await runCommand(new TimeoutConnection(''), ['sleep', '999'], { timeoutMs: 10 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_TIMEOUT');
    assert.ok(result.error.hint !== undefined);
  });

  it('maps a transport rejection to its AppError (E_CONN, not E_INTERNAL)', async () => {
    const conn = new RejectingConnection('E_CONN', 'cannot connect to 127.0.0.1:2223');
    const result = await runCommand(conn, ['uname', '-r']);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_CONN');
    assert.match(result.error.message, /cannot connect/);
  });

  it('maps an auth rejection to E_AUTH', async () => {
    const conn = new RejectingConnection('E_AUTH', 'SSH authentication failed');
    const result = await runCommand(conn, ['uname', '-r']);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'E_AUTH');
  });
});
