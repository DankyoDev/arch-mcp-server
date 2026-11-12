import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDf, realMounts } from '../src/parse/df.js';
import {
  parseDiskstats,
  parseLoadavg,
  parseNetDev,
  parseProcStat,
  parsePsOutput,
  parseTopOutput,
} from '../src/parse/proc.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parsePsOutput', () => {
  it('reads the captured process table', () => {
    const rows = parsePsOutput(loadFixture('ps-table').stdout);
    assert.ok(rows.length >= 5);
    for (const row of rows) {
      assert.ok(row.pid > 0);
      assert.equal(row.rssB % 1024, 0);
      assert.ok(row.cmd.length > 0);
    }
    const systemd = rows.find((row) => row.pid === 1);
    assert.ok(systemd !== undefined);
    assert.ok(systemd.cmd.startsWith('/usr/lib/systemd/systemd'));
  });

  it('handles commands with spaces and unusual users', () => {
    const line = '  110     1 systemd+      1.5  0.2  9496 Ss  3600 sshd: /usr/bin/sshd -D [listener] 0 of 10-100 startups\n';
    const [row] = parsePsOutput(line);
    assert.ok(row !== undefined);
    assert.equal(row.pid, 110);
    assert.equal(row.ppid, 1);
    assert.equal(row.user, 'systemd+');
    assert.equal(row.cpuPct, 1.5);
    assert.equal(row.rssB, 9496 * 1024);
    assert.equal(row.uptimeS, 3600);
    assert.equal(row.cmd, 'sshd: /usr/bin/sshd -D [listener] 0 of 10-100 startups');
  });

  it('ignores garbage lines', () => {
    assert.deepEqual(parsePsOutput('not a process\n'), []);
  });
});

describe('parseTopOutput', () => {
  it('reads the captured top list', () => {
    const rows = parseTopOutput(loadFixture('ps-top').stdout);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.ok(row.name.length > 0);
      assert.ok(row.cpuPct >= 0);
    }
  });
});

describe('parseProcStat', () => {
  it('reads totals and per-core counters', () => {
    const sample = parseProcStat(loadFixture('proc-stat').stdout);
    assert.ok(sample.total > 0);
    assert.ok(sample.idle > 0);
    assert.ok(sample.idle < sample.total);
    assert.ok(sample.cores.length > 0);
    assert.ok(sample.cores.every((core) => core.total >= core.idle));
  });

  it('returns zeros for empty input', () => {
    assert.deepEqual(parseProcStat(''), { total: 0, idle: 0, cores: [] });
  });
});

describe('parseDiskstats', () => {
  it('sums whole devices and ignores partitions and loops', () => {
    const stats = parseDiskstats(loadFixture('proc-diskstats').stdout);
    assert.ok(stats.readB >= 0);
    assert.ok(stats.writeB >= 0);
    assert.equal(stats.readB % 512, 0);
    assert.equal(stats.writeB % 512, 0);
  });

  it('counts one device once', () => {
    const line =
      '   7       0 loop0 1 0 100 0 2 0 200 0 0 0 0\n' +
      ' 259       0 nvme0n1 10 0 1000 5 20 0 2000 6 0 0 0\n' +
      ' 259       1 nvme0n1p1 10 0 500 5 20 0 1000 6 0 0 0\n';
    assert.deepEqual(parseDiskstats(line), { readB: 1000 * 512, writeB: 2000 * 512 });
  });
});

describe('parseNetDev', () => {
  it('sums non-loopback interfaces', () => {
    const stats = parseNetDev(loadFixture('proc-net-dev').stdout);
    assert.ok(stats.rxB > 0);
    assert.ok(stats.txB > 0);
  });

  it('skips lo', () => {
    const text =
      'Inter-|   Receive                                                |  Transmit\n' +
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
      '    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n' +
      '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n';
    assert.deepEqual(parseNetDev(text), { rxB: 1000, txB: 2000 });
  });
});

describe('parseLoadavg', () => {
  it('reads three load values', () => {
    const load = parseLoadavg(loadFixture('proc-loadavg').stdout);
    assert.equal(load.length, 3);
    assert.ok(load.every((value) => value >= 0));
  });

  it('tolerates empty input', () => {
    assert.deepEqual(parseLoadavg(''), [0, 0, 0]);
  });
});

describe('parseDf + realMounts', () => {
  it('reads the captured table and keeps the real root mount', () => {
    const rows = parseDf(loadFixture('df').stdout);
    assert.ok(rows.length > 0);
    const mounts = realMounts(rows);
    assert.deepEqual(
      mounts.map((row) => row.mount),
      ['/'],
    );
  });

  it('parses mount points with spaces', () => {
    const rows = parseDf(
      'Filesystem 1-blocks Used Available Capacity Mounted on\noverlay 100 40 60 40% /var/lib/my data\n',
    );
    assert.equal(rows[0]?.mount, '/var/lib/my data');
    assert.equal(rows[0]?.usePct, 40);
  });
});
