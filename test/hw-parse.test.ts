import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseIptablesRules,
  parseNmcliWifi,
  parseNftRuleset,
  parseSshdT,
} from '../src/parse/net.js';
import {
  parseLspciDrivers,
  parseLspciMm,
  parseLsblk,
  parseLsusb,
  parseSensorsJson,
  parseSmartctlJson,
} from '../src/parse/hw.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseLsblk', () => {
  it('keeps real disks and skips loop/nbd devices', () => {
    const devices = parseLsblk(loadFixture('lsblk').stdout);
    assert.ok(devices.length > 0);
    assert.ok(devices.every((device) => !/^(loop|nbd|ram|sr)/.test(device.name)));
    assert.ok(devices.some((device) => device.name === 'vda'));
    for (const device of devices) assert.ok(device.sizeB >= 0);
  });

  it('returns [] for invalid input', () => {
    assert.deepEqual(parseLsblk(''), []);
    assert.deepEqual(parseLsblk('{}'), []);
  });
});

describe('parseLspciMm', () => {
  it('reads slot, class, vendor and device without the numeric ids', () => {
    const devices = parseLspciMm(loadFixture('lspci').stdout);
    assert.ok(devices.length > 0);
    const first = devices[0];
    assert.equal(first?.slot, '00:01.0');
    assert.equal(first?.class, 'SCSI storage controller');
    assert.equal(first?.vendor, 'Red Hat, Inc.');
    assert.equal(first?.device, 'Virtio 1.0 block device');
  });

  it('ignores lines that are not devices', () => {
    assert.deepEqual(parseLspciMm('garbage\n'), []);
  });
});

describe('parseLspciDrivers', () => {
  it('maps slots to kernel drivers', () => {
    const drivers = parseLspciDrivers(loadFixture('lspci-k').stdout);
    assert.ok(drivers.size > 0);
    assert.ok([...drivers.keys()].every((slot) => /^[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i.test(slot)));
  });
});

describe('parseSensorsJson', () => {
  it('normalises chips, sensors and units', () => {
    const readings = parseSensorsJson(loadFixture('sensors-data').stdout);
    assert.ok(readings.length >= 5);
    const packageTemp = readings.find((reading) => reading.sensor === 'Package id 0');
    assert.equal(packageTemp?.chip, 'coretemp-isa-0000');
    assert.equal(packageTemp?.value, 48);
    assert.equal(packageTemp?.unit, 'C');
    assert.ok(readings.some((reading) => reading.unit === 'RPM'));
  });

  it('returns [] for the empty sensors output of a container', () => {
    assert.deepEqual(parseSensorsJson(loadFixture('sensors').stdout), []);
  });
});

describe('parseLsusb', () => {
  it('reads bus, id and description', () => {
    const devices = parseLsusb(loadFixture('lsusb-data').stdout);
    assert.equal(devices.length, 3);
    assert.deepEqual(devices[1], {
      bus: '001',
      id: '046d:c52b',
      desc: 'Logitech, Inc. Unifying Receiver',
    });
  });

  it('reads the two root hubs of the captured container', () => {
    const devices = parseLsusb(loadFixture('lsusb').stdout);
    assert.equal(devices.length, 2);
    assert.deepEqual(
      devices.map((device) => device.id),
      ['1d6b:0002', '1d6b:0003'],
    );
    assert.match(devices[0]?.desc ?? '', /root hub/);
  });
});

describe('parseSmartctlJson', () => {
  it('reads health, temperature and hours', () => {
    const health = parseSmartctlJson(loadFixture('smartctl-data').stdout, '/dev/nvme0n1');
    assert.equal(health.health, 'passed');
    assert.equal(health.tempC, 41);
    assert.equal(health.hours, 12873);
    assert.match(health.model ?? '', /Samsung/);
    assert.equal(health.error, undefined);
  });

  it('surfaces smartctl errors when the device is not supported', () => {
    const health = parseSmartctlJson(loadFixture('smartctl-vda').stdout, '/dev/vda');
    assert.equal(health.health, 'unknown');
    assert.match(health.error ?? '', /Unable to detect device type/);
  });

  it('returns unknown for empty output', () => {
    assert.deepEqual(parseSmartctlJson('', '/dev/sda'), { device: '/dev/sda', health: 'unknown' });
  });
});

describe('parseNmcliWifi', () => {
  it('reads the in-use network', () => {
    const wifi = parseNmcliWifi(loadFixture('nmcli-wifi').stdout);
    assert.deepEqual(wifi, {
      connected: true,
      ssid: 'HomeNet',
      signal: 72,
      rate: '130 Mbit/s',
      security: 'WPA2',
    });
  });

  it('returns null when nothing is connected', () => {
    assert.equal(parseNmcliWifi(':Other:10:1 Mbit/s:WPA2\n'), null);
  });
});

describe('parseNftRuleset', () => {
  it('counts rules and detects the backend', () => {
    const summary = parseNftRuleset(loadFixture('nft-ruleset').stdout);
    assert.equal(summary.backend, 'nftables');
    assert.equal(summary.active, true);
    assert.ok(summary.rules_count > 0);
    assert.ok(summary.sample.length > 0);
    // The captured ruleset only has NAT chains: no input hook, no policy.
    assert.equal(summary.default_policy, undefined);
  });

  it('reads the input policy when the chain defines it', () => {
    const summary = parseNftRuleset(
      JSON.stringify({
        nftables: [
          { table: { family: 'inet', name: 'filter' } },
          { chain: { family: 'inet', table: 'filter', name: 'input', hook: 'input', policy: 'drop' } },
          { rule: { family: 'inet', table: 'filter', chain: 'input', handle: 4 } },
        ],
      }),
    );
    assert.equal(summary.default_policy, 'drop');
    assert.equal(summary.rules_count, 1);
  });

  it('handles empty output', () => {
    assert.deepEqual(parseNftRuleset(''), {
      backend: 'nftables',
      active: false,
      rules_count: 0,
      sample: [],
    });
  });
});

describe('parseIptablesRules', () => {
  it('reads the INPUT policy and counts rules', () => {
    const summary = parseIptablesRules(
      '-P INPUT DROP\n-P FORWARD DROP\n-A INPUT -i lo -j ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT\n',
    );
    assert.equal(summary.backend, 'iptables');
    assert.equal(summary.default_policy, 'drop');
    assert.equal(summary.rules_count, 2);
    assert.equal(summary.active, true);
  });
});

describe('parseSshdT', () => {
  it('reads effective sshd settings', () => {
    const config = parseSshdT(loadFixture('sshd-T').stdout);
    assert.equal(config.get('permitrootlogin'), 'prohibit-password');
    assert.equal(config.get('passwordauthentication'), 'no');
    assert.equal(config.get('port'), '22');
  });

  it('ignores empty lines and comments', () => {
    const config = parseSshdT('# comment\n\nPort 2222\n');
    assert.equal(config.size, 1);
    assert.equal(config.get('port'), '2222');
  });
});
