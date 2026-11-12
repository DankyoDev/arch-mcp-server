import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBlame, parseBootctl, parsePackageVersions, parseSystemdAnalyze } from '../src/parse/boot.js';
import { parseLast, parseLoginctlSessions } from '../src/parse/usr.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseSystemdAnalyze', () => {
  it('reads the captured userspace-only boot', () => {
    const phases = parseSystemdAnalyze(loadFixture('systemd-analyze').stdout);
    assert.ok((phases.userspace_ms ?? 0) > 0);
    assert.equal(phases.total_ms, phases.userspace_ms);
    assert.equal(phases.firmware_ms, undefined);
  });

  it('parses all four phases and minutes', () => {
    const phases = parseSystemdAnalyze(
      'Startup finished in 1.5s (firmware) + 2.25s (loader) + 3s (kernel) + 1min 4.5s (userspace) = 1min 11.25s',
    );
    assert.equal(phases.firmware_ms, 1500);
    assert.equal(phases.loader_ms, 2250);
    assert.equal(phases.kernel_ms, 3000);
    assert.equal(phases.userspace_ms, 64_500);
    assert.equal(phases.total_ms, 71_250);
  });

  it('returns {} for arbitrary text', () => {
    assert.deepEqual(parseSystemdAnalyze('nope'), {});
  });
});

describe('parseBlame', () => {
  it('sorts by duration and applies the limit', () => {
    const entries = parseBlame(loadFixture('systemd-analyze-blame').stdout, 5);
    assert.equal(entries.length, 5);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous === undefined || current === undefined) continue;
      assert.ok(previous.ms >= current.ms);
    }
    assert.ok(entries.every((entry) => entry.unit.length > 0 && entry.ms >= 0));
  });

  it('parses milliseconds and minutes', () => {
    const entries = parseBlame('  123ms foo.service\n1min 2s bar.service\n', 10);
    assert.deepEqual(entries, [
      { unit: 'bar.service', ms: 62_000 },
      { unit: 'foo.service', ms: 123 },
    ]);
  });
});

describe('parsePackageVersions', () => {
  it('reads pacman -Q lines', () => {
    assert.deepEqual(parsePackageVersions('linux 7.0.14.arch1-1\nlinux-lts 6.12.3-1\n'), [
      { name: 'linux', version: '7.0.14.arch1-1' },
      { name: 'linux-lts', version: '6.12.3-1' },
    ]);
  });

  it('returns [] for empty output', () => {
    assert.deepEqual(parsePackageVersions(''), []);
  });
});

describe('parseBootctl', () => {
  it('detects that the host did not boot with EFI', () => {
    const boot = parseBootctl(loadFixture('bootctl').stdout);
    assert.equal(boot.efi, false);
    assert.equal(boot.bootloader, undefined);
  });

  it('reads the loader name from an EFI host', () => {
    const boot = parseBootctl('System:\n      Firmware: UEFI\nCurrent Boot Loader:\n      Product: systemd-boot 256\n');
    assert.equal(boot.efi, true);
    assert.match(boot.bootloader ?? '', /systemd-boot/);
  });
});

describe('parseLoginctlSessions', () => {
  it('parses a table', () => {
    const sessions = parseLoginctlSessions(
      'SESSION  UID USER SEAT  TTY\n      1 1000 root seat0 tty1\n      2 1000 root -     pts/0\n',
    );
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0], { id: '1', user: 'root', tty: 'tty1', seat: 'seat0' });
    assert.equal(sessions[1]?.seat, undefined);
  });

  it('returns [] when logind is unavailable', () => {
    assert.deepEqual(parseLoginctlSessions(loadFixture('loginctl-sessions').stdout), []);
  });
});

describe('parseLast', () => {
  it('reads the captured boot records', () => {
    const entries = parseLast(loadFixture('last').stdout);
    assert.ok(entries.length >= 2);
    assert.ok(entries.every((entry) => entry.user === 'reboot' && entry.tty === 'system boot'));
    assert.match(entries[0]?.at ?? '', /^Thu Nov 12 \d{2}:\d{2}:\d{2} 2026$/);
  });

  it('reads user logins and ignores the header line', () => {
    const entries = parseLast(
      'root     pts/0        192.0.2.10       Thu Nov 12 14:30:00 2026   still logged in\n' +
        '\nwtmp begins Thu Nov 12 06:46:12 2026\n',
    );
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      user: 'root',
      tty: 'pts/0',
      from: '192.0.2.10',
      at: 'Thu Nov 12 14:30:00 2026',
      status: 'still logged in',
    });
  });

  it('returns [] for an empty btmp', () => {
    assert.deepEqual(parseLast(loadFixture('lastb').stdout), []);
  });
});
