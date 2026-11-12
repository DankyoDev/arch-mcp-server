import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseLscpuJson,
  parseMeminfo,
  parseOsRelease,
  parseUptimeSeconds,
} from '../src/parse/host.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseOsRelease', () => {
  it('reads the captured Arch release', () => {
    const release = parseOsRelease(loadFixture('os-release').stdout);
    assert.equal(release.id, 'arch');
    assert.equal(release.name, 'Arch Linux');
    assert.equal(release.prettyName, 'Arch Linux');
    assert.ok(release.versionId !== undefined && release.versionId !== '');
  });

  it('handles quoting, comments and missing fields', () => {
    const release = parseOsRelease(
      '# comment\nNAME="Fedora Linux"\nID=fedora\nPRETTY_NAME=\'Fedora Linux 41\'\n',
    );
    assert.equal(release.id, 'fedora');
    assert.equal(release.name, 'Fedora Linux');
    assert.equal(release.prettyName, 'Fedora Linux 41');
    assert.equal(release.versionId, undefined);
  });

  it('returns empty strings for empty input', () => {
    assert.deepEqual(parseOsRelease(''), { id: '', name: '', prettyName: '' });
  });
});

describe('parseMeminfo', () => {
  it('converts kB to bytes from the captured fixture', () => {
    const mem = parseMeminfo(loadFixture('proc-meminfo').stdout);
    assert.ok(mem.totalB > 0);
    assert.ok(mem.availB > 0);
    assert.ok(mem.availB <= mem.totalB);
    assert.equal(mem.totalB % 1024, 0);
    assert.ok(mem.swapTotalB >= mem.swapFreeB);
  });

  it('accepts lines without the kB suffix and ignores unknown keys', () => {
    const mem = parseMeminfo('MemTotal:       1000 kB\nMemAvailable: 250\nHugePages_Total: 0\n');
    assert.equal(mem.totalB, 1000 * 1024);
    assert.equal(mem.availB, 250 * 1024);
    assert.equal(mem.swapTotalB, 0);
  });

  it('returns zeros for empty input', () => {
    assert.deepEqual(parseMeminfo(''), { totalB: 0, availB: 0, swapTotalB: 0, swapFreeB: 0 });
  });
});

describe('parseUptimeSeconds', () => {
  it('reads the first field of the captured fixture', () => {
    assert.ok(parseUptimeSeconds(loadFixture('proc-uptime').stdout) > 0);
  });

  it('floors fractional seconds and tolerates empty input', () => {
    assert.equal(parseUptimeSeconds('1234.56 9876.54\n'), 1234);
    assert.equal(parseUptimeSeconds(''), 0);
    assert.equal(parseUptimeSeconds('garbage'), 0);
  });
});

describe('parseLscpuJson', () => {
  it('reads cores and model from the captured fixture (fields end with a colon)', () => {
    const cpu = parseLscpuJson(loadFixture('lscpu').stdout);
    assert.ok(cpu.cores !== undefined && cpu.cores > 0);
    assert.ok(cpu.model !== undefined && cpu.model.length > 0);
  });

  it('tolerates a minimal document and unknown fields', () => {
    const cpu = parseLscpuJson(
      JSON.stringify({ lscpu: [{ field: 'CPU(s):', data: '8' }, { field: 'Vendor ID:', data: 'GenuineIntel' }] }),
    );
    assert.equal(cpu.cores, 8);
    assert.equal(cpu.model, undefined);
  });

  it('returns an empty object for empty or invalid input', () => {
    assert.deepEqual(parseLscpuJson(''), {});
    assert.deepEqual(parseLscpuJson('not json'), {});
    assert.deepEqual(parseLscpuJson('{"lscpu":"nope"}'), {});
  });
});
