import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupErrors, parseBoots, parseJournalLines } from '../src/parse/journal.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseJournalLines', () => {
  it('parses the 50 real entries captured from dante', () => {
    const entries = parseJournalLines(loadFixture('journal-50').stdout);
    assert.equal(entries.length, 50);
    for (const entry of entries) {
      assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'].includes(entry.prio));
    }
    const sshd = entries.filter((entry) => entry.unit === 'sshd.service');
    assert.ok(sshd.length > 0, 'real journal has sshd entries');
    assert.ok(sshd.every((entry) => entry.prio === 'info'));
    assert.ok(entries.some((entry) => entry.msg.includes('Cloudflare DDNS')));
  });

  it('maps every priority number to a name', () => {
    const lines = Array.from({ length: 8 }, (_, prio) =>
      JSON.stringify({ __REALTIME_TIMESTAMP: '1794465973790299', PRIORITY: String(prio), MESSAGE: `m${prio}` }),
    ).join('\n');
    assert.deepEqual(
      parseJournalLines(lines).map((entry) => entry.prio),
      ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'],
    );
  });

  it('renders a binary MESSAGE as <binary>', () => {
    const line = JSON.stringify({
      __REALTIME_TIMESTAMP: '1794465973790299',
      MESSAGE: [0, 1, 2],
    });
    assert.equal(parseJournalLines(line)[0]?.msg, '<binary>');
  });

  it('ignores non-JSON and malformed lines', () => {
    assert.deepEqual(parseJournalLines('-- No entries --\n{bad json}\n'), []);
  });

  it('truncates very long messages', () => {
    const long = JSON.stringify({
      __REALTIME_TIMESTAMP: '1794465973790299',
      MESSAGE: 'x'.repeat(900),
    });
    const entry = parseJournalLines(long)[0];
    assert.ok(entry !== undefined);
    assert.ok(entry.msg.length <= 503);
  });
});

describe('groupErrors', () => {
  it('deduplicates by unit and message and sorts by count', () => {
    const entries = parseJournalLines(loadFixture('journal-errors').stdout);
    const groups = groupErrors(entries);
    assert.equal(entries.length, 200);
    assert.ok(groups.length > 10);
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    assert.equal(total, 200);
    assert.equal(groups[0]?.unit, 'nmb.service');
    for (let index = 1; index < groups.length; index += 1) {
      const previous = groups[index - 1];
      const current = groups[index];
      if (previous === undefined || current === undefined) continue;
      assert.ok(previous.count >= current.count);
    }
  });

  it('returns [] for no entries', () => {
    assert.deepEqual(groupErrors([]), []);
  });
});

describe('parseBoots', () => {
  it('reads the real boot list captured from dante', () => {
    const boots = parseBoots(loadFixture('journal-boots').stdout);
    assert.equal(boots.length, 10);
    assert.match(boots[0]?.id ?? '', /^[0-9a-f]{32}$/);
    assert.equal(boots[0]?.first, '2026-09-01T05:21:36.000Z');
    assert.equal(boots.at(-1)?.last, '2026-11-12T16:54:31.000Z');
  });

  it('also handles the em-dash form used by synthetic fixtures', () => {
    const boots = parseBoots(
      ' -1 4f9c1a2b3c4d5e6f7a8b9c0d1e2f3a4b Wed 2026-11-11 22:10:05 UTC—Thu 2026-11-12 02:59:59 UTC\n',
    );
    assert.equal(boots.length, 1);
    assert.equal(boots[0]?.first, '2026-11-11T22:10:05Z');
    assert.equal(boots[0]?.last, '2026-11-12T02:59:59Z');
  });

  it('returns [] on empty output', () => {
    assert.deepEqual(parseBoots('-- No entries --\n'), []);
  });
});
