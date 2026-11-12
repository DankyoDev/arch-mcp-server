import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collapseMounts,
  parseDfInodes,
  parseFindmnt,
  parseFindPrintf,
  parseGrepLines,
  parseNonDirectoryMounts,
  parseRipgrepJson,
  PSEUDO_FSTYPES,
} from '../src/parse/fs.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseFindmnt', () => {
  it('flattens nested filesystems from the captured fixture', () => {
    const mounts = parseFindmnt(loadFixture('findmnt').stdout);
    assert.ok(mounts.length > 1);
    const root = mounts.find((mount) => mount.target === '/');
    assert.ok(root !== undefined);
    assert.equal(root.fstype, 'overlay');
    assert.ok(root.sizeB > 0);
    // /tmp is a child node in the JSON, so it must appear after flattening.
    assert.ok(mounts.some((mount) => mount.target === '/tmp' && mount.fstype === 'tmpfs'));
  });

  it('reads the use percentage', () => {
    const mounts = parseFindmnt(loadFixture('findmnt').stdout);
    const root = mounts.find((mount) => mount.target === '/');
    assert.equal(root?.usePct, 1);
  });

  it('returns [] for empty or invalid JSON', () => {
    assert.deepEqual(parseFindmnt(''), []);
    assert.deepEqual(parseFindmnt('nope'), []);
  });
});

describe('PSEUDO_FSTYPES', () => {
  it('flags the noise filesystems from the cookbook', () => {
    for (const fstype of ['proc', 'sysfs', 'tmpfs', 'cgroup2', 'squashfs']) {
      assert.equal(PSEUDO_FSTYPES.has(fstype), true, fstype);
    }
    assert.equal(PSEUDO_FSTYPES.has('overlay'), false);
    assert.equal(PSEUDO_FSTYPES.has('ext4'), false);
  });
});

describe('parseFindPrintf', () => {
  it('reads directory entries with type and ISO mtime', () => {
    const entries = parseFindPrintf(loadFixture('find-etc').stdout);
    assert.ok(entries.length > 5);
    const passwd = entries.find((entry) => entry.name === 'passwd');
    assert.ok(passwd !== undefined);
    assert.equal(passwd.type, 'file');
    assert.ok(passwd.sizeB > 0);
    assert.match(passwd.mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(entries.some((entry) => entry.type === 'dir'));
  });

  it('reads file paths for fs_find', () => {
    const entries = parseFindPrintf(loadFixture('find-etc-conf').stdout);
    assert.ok(entries.length > 3);
    assert.ok(entries.every((entry) => entry.path.startsWith('/etc/')));
    assert.ok(entries.every((entry) => entry.path.endsWith('.conf')));
  });

  it('ignores malformed lines', () => {
    assert.deepEqual(parseFindPrintf('garbage\n'), []);
  });
});

describe('parseDfInodes', () => {
  it('maps mount points to inode usage', () => {
    const usage = parseDfInodes(loadFixture('df-inodes').stdout);
    assert.equal(usage.get('/'), 1);
    assert.ok(usage.size >= 3);
  });

  it('returns an empty map for empty input', () => {
    assert.equal(parseDfInodes('').size, 0);
  });
});

describe('parseNonDirectoryMounts + collapseMounts', () => {
  it('identifies file bind mounts', () => {
    const targets = parseNonDirectoryMounts(loadFixture('mount-nondirs').stdout);
    assert.ok(targets.has('/etc/hosts'));
    assert.ok(targets.has('/keys/id_test.pub'));
  });

  it('collapses bind mounts of the same device keeping the shortest target', () => {
    const mounts = parseFindmnt(loadFixture('findmnt').stdout);
    const real = collapseMounts(
      mounts.filter((mount) => !PSEUDO_FSTYPES.has(mount.fstype) && mount.sizeB > 0),
    );
    const targets = real.map((mount) => mount.target).sort();
    assert.deepEqual(targets, ['/', '/etc/hostname', '/etc/hosts', '/etc/resolv.conf', '/keys/id_test.pub']);
  });

  it('drops file mounts before collapsing', () => {
    const mounts = parseFindmnt(loadFixture('findmnt').stdout);
    const nonDirs = parseNonDirectoryMounts(loadFixture('mount-nondirs').stdout);
    const real = collapseMounts(
      mounts.filter(
        (mount) => !PSEUDO_FSTYPES.has(mount.fstype) && mount.sizeB > 0 && !nonDirs.has(mount.target),
      ),
    );
    assert.deepEqual(
      real.map((mount) => mount.target),
      ['/'],
    );
  });
});

describe('parseRipgrepJson', () => {
  it('reads match events and ignores begin/summary noise', () => {
    const text = [
      '{"type":"begin","data":{"path":{"text":"src/a.ts"}}}',
      '{"type":"match","data":{"path":{"text":"src/a.ts"},"lines":{"text":"const TODO = 1;\\n"},"line_number":3,"absolute_offset":20,"submatches":[]}}',
      '{"type":"end","data":{"path":{"text":"src/a.ts"},"binary_offset":null,"stats":{}}}',
      '{"type":"summary","data":{"elapsed_total":{"human":"0.001s"}}}',
    ].join('\n');
    assert.deepEqual(parseRipgrepJson(text), [
      { path: 'src/a.ts', line: 3, text: 'const TODO = 1;' },
    ]);
  });

  it('ignores malformed lines', () => {
    assert.deepEqual(parseRipgrepJson('not json\n{"type":"match"}\n'), []);
  });
});

describe('parseGrepLines', () => {
  it('reads path:line:text rows', () => {
    assert.deepEqual(parseGrepLines('/etc/a.conf:12:hello: world\n/etc/b.conf:1:x\n'), [
      { path: '/etc/a.conf', line: 12, text: 'hello: world' },
      { path: '/etc/b.conf', line: 1, text: 'x' },
    ]);
  });

  it('returns [] for empty or non-matching output', () => {
    assert.deepEqual(parseGrepLines(''), []);
    assert.deepEqual(parseGrepLines('grep: /nope: No such file or directory\n'), []);
  });
});
