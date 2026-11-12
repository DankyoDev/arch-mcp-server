import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitEnvelope, jsonBytes } from '../src/exec/budget.js';

const meta = { host: 'test', ms: 1 };

describe('fitEnvelope', () => {
  it('returns the full payload when it fits', () => {
    const data = [{ unit: 'a.service' }, { unit: 'b.service' }];
    const envelope = fitEnvelope(data, meta, 4096);
    assert.equal(envelope.ok, true);
    if (!envelope.ok) return;
    assert.deepEqual(envelope.data, data);
    assert.equal(envelope.meta.truncated, false);
    assert.equal(envelope.meta.total, undefined);
  });

  it('cuts lists by whole elements and reports totals', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      id: index,
      name: `item-${index}`,
      desc: 'x'.repeat(80),
    }));
    const envelope = fitEnvelope(items, meta, 1024);
    assert.equal(envelope.ok, true);
    if (!envelope.ok) return;
    assert.ok(Array.isArray(envelope.data));
    assert.ok(envelope.data.length > 0);
    assert.ok(envelope.data.length < items.length);
    assert.equal(envelope.meta.truncated, true);
    assert.equal(envelope.meta.total, 200);
    assert.equal(envelope.meta.total_b, jsonBytes(items));
    assert.ok(jsonBytes(envelope) <= 1024);
    for (const item of envelope.data) {
      assert.equal(item.desc.length, 80);
    }
  });

  it('never exceeds the hard cap', () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({ id: index, pad: 'y'.repeat(40) }));
    const envelope = fitEnvelope(items, meta, 1_000_000);
    assert.ok(jsonBytes(envelope) <= 32_768);
  });

  it('reports E_TRUNCATED for oversized non-list payloads', () => {
    const envelope = fitEnvelope({ blob: 'z'.repeat(5000) }, meta, 1024);
    assert.equal(envelope.ok, false);
    if (envelope.ok) return;
    assert.equal(envelope.error.code, 'E_TRUNCATED');
    assert.equal(envelope.meta.truncated, true);
    assert.ok(envelope.error.hint !== undefined);
  });
});
