import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  argsFingerprint,
  confirmationPayload,
  consumeConfirmation,
  createConfirmation,
  pendingCount,
  resetConfirmations,
} from '../src/policy/confirm.js';

const args = { pid: 4242, signal: 'TERM' };

describe('confirmations', () => {
  beforeEach(() => {
    resetConfirmations();
  });

  it('issues an 8 hex character token with a TTL', () => {
    const confirmation = createConfirmation('proc_kill', args, 120);
    assert.match(confirmation.token, /^[0-9a-f]{8}$/);
    assert.equal(confirmation.expiresInS, 120);
    assert.equal(pendingCount(), 1);
  });

  it('accepts the token once for the same tool and arguments', () => {
    const { token } = createConfirmation('proc_kill', args, 120);
    assert.equal(consumeConfirmation(token, 'proc_kill', args).ok, true);
    assert.equal(pendingCount(), 0);
    const reused = consumeConfirmation(token, 'proc_kill', args);
    assert.equal(reused.ok, false);
    if (reused.ok) return;
    assert.equal(reused.error.code, 'E_CONFIRM');
  });

  it('rejects a token used with different arguments', () => {
    const { token } = createConfirmation('proc_kill', args, 120);
    const other = consumeConfirmation(token, 'proc_kill', { pid: 4243, signal: 'TERM' });
    assert.equal(other.ok, false);
    if (other.ok) return;
    assert.match(other.error.message, /does not match/);
  });

  it('rejects a token used with a different tool', () => {
    const { token } = createConfirmation('proc_kill', args, 120);
    const other = consumeConfirmation(token, 'fs_write', args);
    assert.equal(other.ok, false);
  });

  it('rejects unknown tokens', () => {
    const result = consumeConfirmation('deadbeef', 'proc_kill', args);
    assert.equal(result.ok, false);
  });

  it('expires after the TTL', () => {
    const { token } = createConfirmation('proc_kill', args, 10);
    const realNow = Date.now;
    Date.now = () => realNow() + 11_000;
    try {
      const expired = consumeConfirmation(token, 'proc_kill', args);
      assert.equal(expired.ok, false);
      if (expired.ok) return;
      assert.match(expired.error.message, /expired/);
    } finally {
      Date.now = realNow;
    }
  });

  it('ignores the token field when fingerprinting', () => {
    assert.equal(
      argsFingerprint({ pid: 1, signal: 'HUP' }),
      argsFingerprint({ signal: 'HUP', pid: 1, token: 'abc12345' }),
    );
  });

  it('ignores dry_run so a preview token authorizes the real call', () => {
    const args = { path: '/tmp/x', content: 'hello\n' };
    assert.equal(argsFingerprint({ ...args, dry_run: true }), argsFingerprint({ ...args, dry_run: false }));
  });

  it('ignores line endings and trailing whitespace in scripts', () => {
    const a = argsFingerprint({ language: 'bash', source: 'docker ps   \r\n\r\n' });
    const b = argsFingerprint({ language: 'bash', source: 'docker ps' });
    assert.equal(a, b);
  });

  it('still tells apart scripts that differ inside a line', () => {
    const a = argsFingerprint({ source: 'echo a b' });
    const b = argsFingerprint({ source: 'echo a  b' });
    assert.notEqual(a, b);
  });

  it('issues the confirmation payload as a success-shaped object', () => {
    const payload = confirmationPayload('svc_action', { unit: 'nginx.service' }, 120, { effect: 'restart' });
    assert.equal(payload.confirm_required, true);
    assert.match(payload.token, /^[0-9a-f]{8}$/);
    assert.equal(payload.expires_in_s, 120);
    assert.deepEqual(payload.preview, { effect: 'restart' });
    assert.equal(consumeConfirmation(payload.token, 'svc_action', { unit: 'nginx.service' }).ok, true);
  });
});
