import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { audit, redact } from '../src/policy/audit.js';
import { RateLimiter } from '../src/policy/rate.js';
import { classifyOutcome } from '../src/tools/registry.js';

describe('redact', () => {
  it('hides secret-looking keys at any depth', () => {
    const redacted = redact({
      password: 'hunter2',
      token: 'abcdef',
      apiKey: 'x',
      nested: { secret: 'y', keep: 1 },
      list: [{ passphrase: 'z' }],
    });
    assert.deepEqual(redacted, {
      password: '[redacted]',
      token: '[redacted]',
      apiKey: '[redacted]',
      nested: { secret: '[redacted]', keep: 1 },
      list: [{ passphrase: '[redacted]' }],
    });
  });
});

describe('audit', () => {
  it('writes one JSONL line with redacted args', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-mcp-audit-'));
    const path = join(dir, 'audit.jsonl');
    const config = loadConfig({
      ARCH_MCP_HOST: 'test',
      ARCH_MCP_USER: 'root',
      ARCH_MCP_AUDIT_PATH: path,
    });

    audit(config, {
      tool: 'svc_action',
      args: { unit: 'nginx.service', action: 'restart', token: 'deadbeef', password: 'hunter2' },
      mode: 'write',
      decision: 'allow',
      confirmed: true,
      ms: 12,
      exit: 'OK',
    });

    const line = readFileSync(path, 'utf8').trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.tool, 'svc_action');
    assert.equal(entry.decision, 'allow');
    assert.equal(entry.confirmed, true);
    assert.match(String(entry.ts), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(entry.args, {
      unit: 'nginx.service',
      action: 'restart',
      token: '[redacted]',
      password: '[redacted]',
    });
    assert.ok(!line.includes('hunter2'));
    assert.ok(!line.includes('deadbeef'));
  });
});

describe('audit decisions', () => {
  it('separates preview, confirm, allow and deny', () => {
    assert.equal(
      classifyOutcome({ ok: false, error: { code: 'E_POLICY', message: 'no' } }),
      'deny',
    );
    assert.equal(
      classifyOutcome({ ok: true, data: { data: { confirm_required: true, token: 'abc' } } }),
      'confirm',
    );
    assert.equal(
      classifyOutcome({ ok: true, data: { data: { confirm_required: true, result: 'dry_run', token: 'abc' } } }),
      'preview',
    );
    assert.equal(classifyOutcome({ ok: true, data: { data: { units: [] } } }), 'allow');
  });
});

describe('RateLimiter', () => {  it('allows up to the limit inside the window', () => {
    const limiter = new RateLimiter(2);
    assert.equal(limiter.take().ok, true);
    assert.equal(limiter.take().ok, true);
    const third = limiter.take();
    assert.equal(third.ok, false);
    if (!third.ok) assert.equal(third.error.code, 'E_POLICY');
  });

  it('counts a costly call twice', () => {
    const limiter = new RateLimiter(3);
    assert.equal(limiter.take(2).ok, true);
    assert.equal(limiter.take(1).ok, true);
    const extra = limiter.take(1);
    assert.equal(extra.ok, false);
  });

  it('frees slots after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(1, () => now);
    assert.equal(limiter.take().ok, true);
    assert.equal(limiter.take().ok, false);
    now = 61_000;
    assert.equal(limiter.take().ok, true);
  });
});
