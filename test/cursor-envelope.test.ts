import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCursor, encodeCursor } from '../src/core/cursor.js';
import { buildEnvelope } from '../src/core/envelope.js';

describe('cursor', () => {
  it('roundtrips an offset', () => {
    const decoded = decodeCursor(encodeCursor(50));
    assert.equal(decoded.ok, true);
    if (!decoded.ok) return;
    assert.equal(decoded.data, 50);
  });

  it('starts at zero without a cursor', () => {
    for (const value of [undefined, '']) {
      const decoded = decodeCursor(value);
      assert.equal(decoded.ok, true);
      if (decoded.ok) assert.equal(decoded.data, 0);
    }
  });

  it('rejects malformed cursors', () => {
    for (const value of ['not-base64!!', Buffer.from('offset:-1').toString('base64url')]) {
      const decoded = decodeCursor(value);
      assert.equal(decoded.ok, false);
      if (!decoded.ok) assert.equal(decoded.error.code, 'E_INTERNAL');
    }
  });
});

describe('buildEnvelope', () => {
  it('passes total and cursor into meta', () => {
    const envelope = buildEnvelope({
      data: [{ unit: 'a.service' }],
      host: 'test',
      ms: 3,
      maxBytes: 8192,
      total: 39,
      cursor: 'abc',
    });
    assert.equal(envelope.ok, true);
    if (!envelope.ok) return;
    assert.equal(envelope.meta.total, 39);
    assert.equal(envelope.meta.cursor, 'abc');
    assert.equal(envelope.meta.truncated, false);
  });

  it('reports E_TRUNCATED when a single object cannot fit', () => {
    const envelope = buildEnvelope({
      data: { blob: 'q'.repeat(9000) },
      host: 'test',
      ms: 1,
      maxBytes: 1024,
    });
    assert.equal(envelope.ok, false);
    if (envelope.ok) return;
    assert.equal(envelope.error.code, 'E_TRUNCATED');
  });
});
