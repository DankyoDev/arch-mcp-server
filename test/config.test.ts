import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig, loadConfigDetailed } from '../src/config.js';

const base = {
  ARCH_MCP_HOST: '10.0.0.5',
  ARCH_MCP_PORT: '2222',
  ARCH_MCP_USER: 'ops',
  ARCH_MCP_KEY: '/home/ops/.ssh/id_test',
};

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(base);
    assert.equal(config.host, '10.0.0.5');
    assert.equal(config.port, 2222);
    assert.equal(config.mode, 'readonly');
    assert.equal(config.profile, 'core');
    assert.equal(config.allowSudo, false);
    assert.equal(config.allowRaw, false);
    assert.equal(config.maxBytes, 8192);
    assert.equal(config.timeoutMs, 15_000);
    assert.equal(config.rateLimit, 30);
    assert.equal(config.audit, true);
    assert.equal(config.confirmTtl, 120);
    assert.equal(config.local, false);
  });

  it('does not infer local mode from the host name (ADR-017)', () => {
    assert.equal(loadConfig({ ...base, ARCH_MCP_HOST: '127.0.0.1' }).local, false);
    assert.equal(loadConfig({ ...base, ARCH_MCP_HOST: 'localhost' }).local, false);
    assert.equal(loadConfig({ ...base, ARCH_MCP_LOCAL: '1' }).local, true);
  });

  it('parses env booleans', () => {
    assert.equal(loadConfig({ ...base, ARCH_MCP_AUDIT: '0' }).audit, false);
    assert.equal(loadConfig({ ...base, ARCH_MCP_AUDIT: 'off' }).audit, false);
    assert.equal(loadConfig({ ...base, ARCH_MCP_ALLOW_SUDO: 'yes' }).allowSudo, true);
  });

  it('rejects out-of-range and unknown values', () => {
    assert.throws(() => loadConfig({ ...base, ARCH_MCP_MAX_BYTES: '999999' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, ARCH_MCP_MAX_BYTES: '10' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, ARCH_MCP_PORT: '70000' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, ARCH_MCP_MODE: 'god' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, ARCH_MCP_HOST_KEY: 'md5:abc' }), ConfigError);
  });

  it('warns when both key and password are set', () => {
    const { config, warnings } = loadConfigDetailed({ ...base, ARCH_MCP_PASSWORD: 'secret' });
    assert.equal(config.password, 'secret');
    assert.ok(warnings.some((warning) => warning.includes('takes precedence')));
  });

  it('reads the optional HTTP bearer token', () => {
    assert.equal(loadConfig(base).httpToken, undefined);
    const token = 'a'.repeat(16);
    assert.equal(loadConfig({ ...base, ARCH_MCP_HTTP_TOKEN: token }).httpToken, token);
  });

  it('rejects HTTP tokens shorter than 16 characters', () => {
    assert.throws(() => loadConfig({ ...base, ARCH_MCP_HTTP_TOKEN: 'short' }), ConfigError);
  });
});
