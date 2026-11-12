import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modeAllows } from '../src/policy/modes.js';

const readOnly = { readOnlyHint: true, destructiveHint: false };
const mutation = { readOnlyHint: false, destructiveHint: true };

describe('modeAllows', () => {
  it('always allows read-only tools', () => {
    for (const mode of ['readonly', 'write', 'admin'] as const) {
      assert.equal(modeAllows(mode, readOnly).ok, true);
    }
  });

  it('blocks mutations in readonly without executing anything', () => {
    const decision = modeAllows('readonly', mutation);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.error.code, 'E_POLICY');
    assert.match(decision.error.hint, /ARCH_MCP_MODE=write/);
  });

  it('allows mutations in write (confirmation still applies)', () => {
    assert.equal(modeAllows('write', mutation).ok, true);
    assert.equal(modeAllows('admin', mutation).ok, true);
  });
});
