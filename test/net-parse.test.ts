import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseGetentHosts,
  parseIpAddr,
  parseIpRoute,
  parseResolvConf,
  parseSsConns,
  parseSsPorts,
  splitAddress,
} from '../src/parse/net.js';
import { loadFixture } from './helpers/fixtures.js';

describe('parseIpAddr', () => {
  it('reads interfaces and addresses from the captured fixture', () => {
    const ifaces = parseIpAddr(loadFixture('ip-addr').stdout);
    assert.ok(ifaces.length >= 2);
    const eth0 = ifaces.find((iface) => iface.name === 'eth0');
    assert.ok(eth0 !== undefined);
    assert.equal(eth0.state, 'UP');
    assert.ok(eth0.addrs.some((addr) => addr.ip === '172.18.0.3' && addr.prefix === 16));
    assert.ok(eth0.mac !== undefined);
  });

  it('returns [] for invalid JSON', () => {
    assert.deepEqual(parseIpAddr('not json'), []);
    assert.deepEqual(parseIpAddr(''), []);
  });
});

describe('parseIpRoute', () => {
  it('finds the default route', () => {
    assert.deepEqual(parseIpRoute(loadFixture('ip-route').stdout), {
      dev: 'eth0',
      gateway: '172.18.0.1',
    });
  });

  it('returns null without a default route', () => {
    assert.equal(parseIpRoute('[{"dst":"10.0.0.0/8","dev":"eth0"}]'), null);
  });
});

describe('parseSsPorts', () => {
  it('reads listening ports and processes', () => {
    const ports = parseSsPorts(loadFixture('ss-ports').stdout);
    assert.ok(ports.length >= 2);
    const ssh = ports.find((port) => port.port === 22 && port.proto === 'tcp');
    assert.ok(ssh !== undefined);
    assert.equal(ssh.proc, 'sshd');
    assert.ok(ssh.pid !== undefined && ssh.pid > 0);
    const resolver = ports.find((port) => port.proto === 'udp' && port.port === 5353);
    assert.equal(resolver?.proc, 'systemd-resolve');
  });

  it('strips zone ids and brackets', () => {
    const ports = parseSsPorts(
      'udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n' +
        'tcp LISTEN 0 128 [::]:22 [::]:*\n',
    );
    assert.equal(ports[0]?.addr, '127.0.0.53');
    assert.equal(ports[0]?.port, 53);
    assert.equal(ports[1]?.addr, '::');
    assert.equal(ports[1]?.port, 22);
  });
});

describe('parseSsConns', () => {
  it('reads established connections (state column is omitted by ss)', () => {
    const rows = parseSsConns(loadFixture('ss-conns').stdout);
    assert.ok(rows.length >= 1);
    assert.ok((rows[0]?.proc ?? '').startsWith('sshd'));
    assert.match(rows[0]?.peer ?? '', /:\d+$/);
  });
});

describe('parseResolvConf', () => {
  it('reads nameservers and deduplicates', () => {
    assert.deepEqual(parseResolvConf(loadFixture('resolv-conf').stdout), ['127.0.0.11']);
    assert.deepEqual(parseResolvConf('nameserver 1.1.1.1\nnameserver 1.1.1.1\n'), ['1.1.1.1']);
    assert.deepEqual(parseResolvConf(''), []);
  });
});

describe('parseGetentHosts', () => {
  it('reads addresses without duplicates', () => {
    const answers = parseGetentHosts(loadFixture('getent-localhost').stdout);
    assert.ok(answers.includes('127.0.0.1'));
    assert.equal(new Set(answers).size, answers.length);
  });
});

describe('splitAddress', () => {
  it('splits host and port forms', () => {
    assert.deepEqual(splitAddress('0.0.0.0:5353'), { host: '0.0.0.0', port: 5353 });
    assert.deepEqual(splitAddress('[::]:22'), { host: '::', port: 22 });
    assert.deepEqual(splitAddress('127.0.0.53%lo:53'), { host: '127.0.0.53', port: 53 });
    assert.equal(splitAddress('nonsense'), null);
  });
});
