import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  failedDetailFromBlock,
  parseShowBlocks,
  parseShowProperties,
  parseTimersJson,
  parseUnitsJson,
} from '../src/parse/systemd.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseUnitsJson', () => {
  it('reads the captured unit list', () => {
    const units = parseUnitsJson(loadFixture('systemctl-units-all').stdout);
    assert.ok(units.length > 0);
    const sshd = units.find((unit) => unit.unit === 'sshd.service');
    assert.ok(sshd !== undefined);
    assert.equal(sshd.active, 'active');
    assert.ok(sshd.description.length > 0);
  });

  it('returns [] when no unit failed', () => {
    assert.deepEqual(parseUnitsJson(loadFixture('systemctl-failed').stdout), []);
  });

  it('tolerates empty, invalid and partial entries', () => {
    assert.deepEqual(parseUnitsJson(''), []);
    assert.deepEqual(parseUnitsJson('not json'), []);
    assert.deepEqual(parseUnitsJson('[{"unit":"a.service"},{"load":"loaded"}]'), [
      { unit: 'a.service', load: '', active: '', sub: '', description: '' },
    ]);
  });
});

describe('parseShowProperties', () => {
  it('reads the captured sshd properties', () => {
    const properties = parseShowProperties(loadFixture('systemctl-show-sshd').stdout);
    assert.equal(properties.ActiveState, 'active');
    assert.equal(properties.SubState, 'running');
    assert.ok(Number(properties.MainPID) > 0);
    assert.ok(Number(properties.MemoryCurrent) > 0);
    assert.equal(properties.Result, 'success');
    assert.match(properties.ExecStart ?? '', /path=\//);
  });

  it('keeps values containing equals signs', () => {
    const properties = parseShowProperties('A=1\nB=x=y\nnoise\n');
    assert.equal(properties.A, '1');
    assert.equal(properties.B, 'x=y');
    assert.equal(Object.keys(properties).length, 2);
  });
});

describe('parseShowBlocks', () => {
  it('splits multiple units on the captured output', () => {
    const blocks = parseShowBlocks(loadFixture('systemctl-show-multi').stdout);
    assert.equal(blocks.length, 2);
    const units = blocks.map((block) => block.Id ?? block.Unit);
    assert.deepEqual(units, ['sshd.service', 'systemd-tmpfiles-clean.timer']);
  });

  it('extracts failed details with an ISO timestamp', () => {
    const blocks = parseShowBlocks(loadFixture('systemctl-show-multi').stdout);
    const detail = failedDetailFromBlock(blocks[0] ?? {});
    assert.ok(detail !== null);
    assert.equal(detail?.unit, 'sshd.service');
    assert.match(detail?.since ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(detail?.exit ?? '', /^success\/0$/);
  });
});

describe('parseTimersJson', () => {
  it('converts microsecond times to ISO and keeps activates', () => {
    const timers = parseTimersJson(loadFixture('systemctl-timers').stdout);
    assert.ok(timers.length >= 2);
    for (const timer of timers) {
      assert.ok(timer.unit.endsWith('.timer'));
      if (timer.next !== undefined) assert.match(timer.next, /^\d{4}-\d{2}-\d{2}T/);
      if (timer.last !== undefined) assert.match(timer.last, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.ok(timers.some((timer) => timer.activates !== undefined));
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(parseTimersJson(''), []);
    assert.deepEqual(parseTimersJson('[]'), []);
  });
});
