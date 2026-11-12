import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDenylist } from '../src/policy/denylist.js';

const DENIED: Array<{ argv: string[]; rule?: string }> = [
  { argv: ['rm', '-rf', '/'], rule: 'rm-root' },
  { argv: ['rm', '-rf', '/*'], rule: 'rm-root' },
  { argv: ['rm', '-fr', '--no-preserve-root', '/'], rule: 'rm-root' },
  { argv: ['mkfs.ext4', '/dev/sda1'], rule: 'mkfs' },
  { argv: ['wipefs', '-a', '/dev/sda'], rule: 'mkfs' },
  { argv: ['mkswap', '/dev/sda2'], rule: 'mkfs' },
  { argv: ['dd', 'if=/dev/zero', 'of=/dev/sda'], rule: 'dd-device' },
  { argv: ['shutdown', '-h', 'now'], rule: 'power' },
  { argv: ['reboot'], rule: 'power' },
  { argv: ['poweroff'], rule: 'power' },
  { argv: ['halt'], rule: 'power' },
  { argv: ['systemctl', 'poweroff'], rule: 'systemctl-power' },
  { argv: ['systemctl', 'reboot'], rule: 'systemctl-power' },
  { argv: ['systemctl', 'isolate', 'rescue.target'], rule: 'systemctl-power' },
  { argv: ['init', '0'], rule: 'power' },
  { argv: ['init', '6'], rule: 'power' },
  { argv: ['kill', '-9', '1'], rule: 'kill-init' },
  { argv: ['kill', '-KILL', '1'], rule: 'kill-init' },
  { argv: ['sh', '-c', ':(){ :|:& };:'], rule: 'fork-bomb' },
  { argv: ['docker', 'run', '--privileged', 'archlinux'], rule: 'containers' },
  { argv: ['podman', 'run', 'archlinux'], rule: 'containers' },
  { argv: ['docker', 'run', '--cgroupns=host', 'archlinux'], rule: 'containers' },
  { argv: ['docker', 'run', '--pid=host', 'archlinux'], rule: 'containers' },
  { argv: ['docker', 'run', '--net=host', 'archlinux'], rule: 'containers' },
  { argv: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p'], rule: 'nsenter' },
  { argv: ['iptables', '-F'], rule: 'firewall-flush' },
  { argv: ['nft', 'flush', 'ruleset'], rule: 'firewall-flush' },
  { argv: ['ip', 'link', 'set', 'eth0', 'down'], rule: 'network-down' },
  { argv: ['systemctl', 'stop', 'sshd'], rule: 'critical-unit' },
  { argv: ['systemctl', 'restart', 'systemd-logind'], rule: 'critical-unit' },
  { argv: ['systemctl', 'stop', 'NetworkManager'], rule: 'critical-unit' },
  { argv: ['cat', '/etc/shadow'], rule: 'sensitive-path' },
  { argv: ['tee', '/root/.ssh/authorized_keys'], rule: 'sensitive-path' },
  { argv: ['cat', '/root/.ssh/id_ed25519'], rule: 'sensitive-path' },
  { argv: ['cp', 'x', '/etc/sudoers.d/site'], rule: 'sensitive-path' },
  { argv: ['sudo', 'systemctl', 'restart', 'nginx'] },
  { argv: ['su', '-'] },
  { argv: ['somebin', '--privileged'] },
];

const ALLOWED: string[][] = [
  ['systemctl', 'restart', 'nginx'],
  ['systemctl', 'status', 'nginx.service'],
  ['systemctl', 'list-units', '--failed'],
  ['journalctl', '-u', 'nginx', '-n', '20'],
  ['pacman', '-Qu'],
  ['pacman', '-Syu', '--noconfirm'],
  ['ip', '-j', 'addr'],
  ['ip', 'route'],
  ['ss', '-tulnpH'],
  ['df', '-P', '-B1'],
  ['find', '/etc', '-maxdepth', '1'],
  ['cat', '/etc/pacman.conf'],
  ['uname', '-r'],
  ['systemd-analyze', 'blame'],
  ['sh', '-c', 'echo hi'],
  ['btrfs', 'scrub', 'start', '/dev/nvme0n1'],
];

describe('checkDenylist', () => {
  it('blocks every dangerous family from docs/05-security.md §4', () => {
    for (const testCase of DENIED) {
      const result = checkDenylist(testCase.argv);
      assert.notEqual(result, null, `should deny: ${testCase.argv.join(' ')}`);
      assert.equal(result?.code, 'E_POLICY');
      assert.ok((result?.hint ?? '').length > 0);
      if (testCase.rule !== undefined) {
        const rule = (result?.data as { rule?: string } | undefined)?.rule;
        assert.equal(rule, testCase.rule, `wrong rule for ${testCase.argv.join(' ')}`);
      }
    }
  });

  it('allows normal read and service operations', () => {
    for (const argv of ALLOWED) {
      assert.equal(checkDenylist(argv), null, `should allow: ${argv.join(' ')}`);
    }
  });

  it('honours the sudo allowlist when enabled', () => {
    assert.equal(checkDenylist(['sudo', 'pacman', '-Syu'], { allowSudo: true, sudoAllow: ['pacman'] }), null);
    const denied = checkDenylist(['sudo', 'pacman', '-Syu'], { allowSudo: true, sudoAllow: ['systemctl'] });
    assert.equal(denied?.code, 'E_POLICY');
  });
});
