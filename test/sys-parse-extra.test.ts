import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDf, realMounts } from '../src/parse/df.js';
import { parseThermalMax } from '../src/parse/host.js';

describe('parseThermalMax', () => {
  it('descarta el centinela 127 °C de acpitz', () => {
    assert.equal(parseThermalMax('57000\n127000\n'), 57);
  });

  it('devuelve null si no hay lecturas válidas', () => {
    assert.equal(parseThermalMax('127000\n0\n'), null);
  });

  it('acepta una CPU real a 100 °C', () => {
    assert.equal(parseThermalMax('45000\n100000\n'), 100);
  });
});

describe('realMounts', () => {
  it('ignora los overlays de Docker montados bajo el data-root', () => {
    const df = [
      'Filesystem 1-blocks Used Available Capacity Mounted on',
      '/dev/sda3 100 50 50 50% /home',
      'overlay 100 60 40 60% /home/dante/docker-data/rootfs/overlayfs/abc',
    ].join('\n');
    const mounts = realMounts(parseDf(df));
    assert.deepEqual(mounts.map((m) => m.mount), ['/home']);
  });

  it('conserva un overlay que sea el root del sistema', () => {
    const df = [
      'Filesystem 1-blocks Used Available Capacity Mounted on',
      'overlay 100 60 40 60% /',
    ].join('\n');
    assert.deepEqual(realMounts(parseDf(df)).map((m) => m.mount), ['/']);
  });
});
