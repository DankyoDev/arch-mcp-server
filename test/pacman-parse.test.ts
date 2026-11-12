import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseHumanSize,
  parsePacmanInfo,
  parsePacmanQo,
  parsePacmanQu,
  parsePacmanSs,
  splitList,
} from '../src/parse/pacman.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parsePacmanQu', () => {
  it('parses "pkg old -> new" lines', () => {
    const updates = parsePacmanQu('bash 5.3.20-1 -> 5.3.21-1\nlinux 7.0.13 -> 7.0.14\n');
    assert.deepEqual(updates, [
      { name: 'bash', from: '5.3.20-1', to: '5.3.21-1' },
      { name: 'linux', from: '7.0.13', to: '7.0.14' },
    ]);
  });

  it('returns [] when the host is up to date', () => {
    assert.deepEqual(parsePacmanQu(loadFixture('pacman-qu').stdout), []);
  });
});

describe('parsePacmanInfo', () => {
  it('reads the captured -Qi block', () => {
    const info = parsePacmanInfo(loadFixture('pacman-qi-bash').stdout);
    assert.equal(info.Name, 'bash');
    assert.equal(info.Version, '5.3.20-1');
    assert.equal(info.Architecture, 'x86_64');
    assert.match(info['Installed Size'] ?? '', /MiB/);
    assert.ok(splitList(info['Depends On']).includes('readline'));
    assert.ok(splitList(info['Required By']).includes('base'));
  });

  it('returns {} for empty input', () => {
    assert.deepEqual(parsePacmanInfo(''), {});
  });
});

describe('parsePacmanSs', () => {
  it('reads package blocks with descriptions', () => {
    const results = parsePacmanSs(loadFixture('pacman-ss-bash').stdout);
    assert.ok(results.length >= 3);
    const first = results[0];
    assert.equal(first?.name, 'bash');
    assert.equal(first?.repo, 'core');
    assert.equal(first?.version, '5.3.20-1');
    assert.equal(first?.desc, 'The GNU Bourne Again shell');
  });

  it('does not mistake descriptions for packages', () => {
    const results = parsePacmanSs('core/foo 1.0-1\n    A description with spaces\n');
    assert.equal(results.length, 1);
  });
});

describe('parsePacmanQo', () => {
  it('reads the owning package', () => {
    assert.deepEqual(parsePacmanQo(loadFixture('pacman-qo-bash').stdout), {
      package: 'bash',
      version: '5.3.20-1',
    });
  });

  it('returns null for error output', () => {
    assert.equal(parsePacmanQo('error: No package owns /nope\n'), null);
  });
});

describe('parseHumanSize', () => {
  it('converts pacman units to bytes', () => {
    assert.equal(parseHumanSize('4.52 MiB'), Math.round(4.52 * 1024 * 1024));
    assert.equal(parseHumanSize('1.00 GiB'), 1024 ** 3);
    assert.equal(parseHumanSize('512 B'), 512);
    assert.equal(parseHumanSize('None'), 0);
    assert.equal(parseHumanSize('garbage'), 0);
  });
});

describe('splitList', () => {
  it('splits dependency lists and drops None', () => {
    assert.deepEqual(splitList('readline  glibc  ncurses'), ['readline', 'glibc', 'ncurses']);
    assert.deepEqual(splitList('None'), []);
    assert.deepEqual(splitList(undefined), []);
  });
});
