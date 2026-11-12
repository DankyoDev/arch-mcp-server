import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCapabilities } from '../src/caps.js';
import { loadFixture } from './helpers/fixtures.js';

describe('buildCapabilities', () => {
  const sections = {
    cmdv: {
      stdout: loadFixture('command-v').stdout,
      code: 0,
    },
    os: { stdout: loadFixture('os-release').stdout, code: 0 },
    kernel: { stdout: loadFixture('uname-kernel').stdout, code: 0 },
    arch: { stdout: loadFixture('uname-arch').stdout, code: 0 },
    systemd: { stdout: loadFixture('systemctl-version').stdout, code: 0 },
  };

  it('detects the captured host', () => {
    const caps = buildCapabilities(sections);
    assert.equal(caps.os.id, 'arch');
    assert.match(caps.os.name, /Arch Linux/);
    assert.match(caps.kernel, /\d/);
    assert.equal(caps.arch, 'x86_64');
    assert.match(caps.systemd ?? '', /262/);
    assert.equal(caps.features.systemd, true);
    assert.equal(caps.features.pacman, true);
    assert.equal(caps.features.journald, true);
    assert.equal(caps.tools.pacman, '/usr/bin/pacman');
    assert.equal(caps.tools.nmcli, undefined);
    assert.equal(caps.features.network_manager, false);
  });

  it('tolerates missing commands and empty output', () => {
    const caps = buildCapabilities({});
    assert.equal(caps.os.id, '');
    assert.equal(caps.features.systemd, false);
    assert.equal(caps.tools.pacman, undefined);
    assert.equal(caps.systemd, undefined);
  });

  it('detects daily tools such as rg, fd and croc', () => {
    const caps = buildCapabilities({
      cmdv: {
        stdout: ['/usr/bin/rg', '/usr/bin/fd', '/usr/bin/croc', '/usr/bin/jq', '/usr/bin/git'].join('\n'),
        code: 0,
      },
    });
    assert.equal(caps.tools.rg, '/usr/bin/rg');
    assert.equal(caps.tools.fd, '/usr/bin/fd');
    assert.equal(caps.tools.croc, '/usr/bin/croc');
    assert.equal(caps.features.ripgrep, true);
    assert.equal(caps.features.fd, true);
    assert.equal(caps.features.croc, true);
    assert.equal(caps.features.jq, true);
    assert.equal(caps.features.git, true);
    assert.equal(caps.features.python3, false);
  });
});
