import type { AppError } from '../core/types.js';

const SENSITIVE_PATHS = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d/',
  '/boot/',
  '/etc/fstab',
  '/etc/crypttab',
];

const SSH_KEY_PATTERN = /(^|\/)\.ssh\/(authorized_keys|id_[^/]*)$/;

const CRITICAL_UNIT = /^(ssh|sshd|sshd@.*|systemd-.*|dbus|dbus-broker|dbus\.socket|systemd-logind|NetworkManager|network-manager)$/i;

interface DenyRule {
  id: string;
  reason: string;
  hint: string;
  test: (argv: readonly string[], joined: string) => boolean;
}

const RULES: readonly DenyRule[] = [
  {
    id: 'rm-root',
    reason: 'recursive removal of the root filesystem is blocked',
    hint: 'delete specific paths instead',
    test: (argv) =>
      argv[0] === 'rm' &&
      argv.some((arg) => /^-[a-z]*r[a-z]*f|^-[a-z]*f[a-z]*r/.test(arg)) &&
      argv.some((arg) => arg === '/' || arg === '/*' || arg === '--no-preserve-root'),
  },
  {
    id: 'mkfs',
    reason: 'filesystem creation is blocked',
    hint: 'format disks manually outside the MCP',
    test: (argv) => /^mkfs(\.|$)/.test(argv[0] ?? '') || argv[0] === 'wipefs' || argv[0] === 'mkswap',
  },
  {
    id: 'dd-device',
    reason: 'raw writes to block devices are blocked',
    hint: 'use a filesystem tool with confirmation',
    test: (argv) => argv[0] === 'dd' && argv.some((arg) => arg.startsWith('of=/dev/')),
  },
  {
    id: 'power',
    reason: 'power state changes are blocked',
    hint: 'do it from the console',
    test: (argv) =>
      ['shutdown', 'reboot', 'poweroff', 'halt'].includes(argv[0] ?? '') ||
      (argv[0] === 'init' && (argv[1] === '0' || argv[1] === '6')),
  },
  {
    id: 'systemctl-power',
    reason: 'systemctl power/isolate actions are blocked',
    hint: 'use svc_action on an application unit',
    test: (argv) =>
      argv[0] === 'systemctl' &&
      ['poweroff', 'reboot', 'halt', 'isolate', 'kexec'].includes(argv[1] ?? ''),
  },
  {
    id: 'kill-init',
    reason: 'signalling PID 1 is blocked',
    hint: 'restart the machine properly',
    test: (argv) =>
      argv[0] === 'kill' &&
      argv.some((arg) => arg === '-9' || arg === '-KILL' || arg === '-SIGKILL') &&
      argv[argv.length - 1] === '1',
  },
  {
    id: 'fork-bomb',
    reason: 'fork bombs are blocked',
    hint: 'do not run that',
    test: (_argv, joined) => joined.includes(':(){ :|:& };:') || joined.includes('(){ :|:& };:'),
  },
  {
    id: 'containers',
    reason: 'container tools are out of scope for this MCP',
    hint: 'use the homelab MCP; the 2026-11-12 incident came from docker run --privileged',
    test: (argv) => ['docker', 'podman', 'docker-compose', 'nerdctl'].includes(argv[0] ?? ''),
  },
  {
    id: 'container-flags',
    reason: 'privileged or host-namespace container flags are blocked',
    hint: 'never combine --privileged with --cgroupns=host',
    test: (argv) =>
      argv.some((arg) =>
        [
          '--privileged',
          '--cgroupns=host',
          '--pid=host',
          '--net=host',
          '--ipc=host',
          '--uts=host',
        ].includes(arg),
      ),
  },
  {
    id: 'nsenter',
    reason: 'entering PID 1 namespaces is blocked',
    hint: 'use systemd-nspawn or a VM',
    test: (argv) => argv[0] === 'nsenter' && argv.includes('-t') && argv.includes('1'),
  },
  {
    id: 'firewall-flush',
    reason: 'flushing firewall rules is blocked',
    hint: 'edit rules explicitly and apply them by hand',
    test: (argv) =>
      (argv[0] === 'iptables' && [argv[1], argv[2]].includes('-F')) ||
      (argv[0] === 'nft' && argv[1] === 'flush'),
  },
  {
    id: 'network-down',
    reason: 'bringing interfaces down is blocked',
    hint: 'use nmcli or edit the profile',
    test: (argv) => argv[0] === 'ip' && argv[1] === 'link' && argv.includes('down'),
  },
  {
    id: 'critical-unit',
    reason: 'stopping sshd, dbus or systemd units can lock you out',
    hint: 'restart application services only',
    test: (argv) => {
      if (argv[0] !== 'systemctl') return false;
      const action = argv[1];
      if (action === undefined) return false;
      if (!['stop', 'restart', 'disable', 'mask', 'kill'].includes(action)) return false;
      const units = argv.slice(2).filter((arg) => !arg.startsWith('-'));
      return units.some((unit) => CRITICAL_UNIT.test(unit));
    },
  },
  {
    id: 'sensitive-path',
    reason: 'the command touches a credential or boot path',
    hint: 'these paths are off limits for tools',
    test: (argv) =>
      argv.some(
        (arg) =>
          SENSITIVE_PATHS.some((path) => arg === path || arg.startsWith(path)) ||
          SSH_KEY_PATTERN.test(arg),
      ),
  },
  {
    id: 'find-exec',
    reason: 'find -exec can run arbitrary commands',
    hint: 'use fs_find or exec with an explicit binary',
    test: (argv) =>
      argv[0] === 'find' &&
      argv.some((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg)),
  },
  {
    id: 'tar-to-command',
    reason: 'tar --to-command runs an external program',
    hint: 'extract with tar and run the tool separately',
    test: (argv) => argv[0] === 'tar' && argv.some((arg) => arg.startsWith('--to-command')),
  },
  {
    id: 'rsync-shell',
    reason: 'rsync -e can run an arbitrary shell',
    hint: 'use rsync without a custom remote shell',
    test: (argv) =>
      argv[0] === 'rsync' && argv.some((arg) => arg === '-e' || arg.startsWith('--rsh')),
  },
];

const SUDO_BINARIES = new Set(['sudo', 'su', 'doas', 'pkexec']);

export interface DenyOptions {
  allowSudo?: boolean;
  sudoAllow?: readonly string[];
}

/** Evaluate the process denylist on a fully built argv (docs/05-security.md §4). */
export function checkDenylist(argv: readonly string[], options: DenyOptions = {}): AppError | null {
  const head = argv[0] ?? '';
  if (SUDO_BINARIES.has(head)) {
    if (options.allowSudo !== true) {
      return policy('sudo is disabled', 'set ARCH_MCP_ALLOW_SUDO=1 and add the command to ARCH_MCP_SUDO_ALLOW');
    }
    const target = argv.slice(1).join(' ');
    const allowed = (options.sudoAllow ?? []).some((entry) => target.startsWith(entry));
    if (!allowed) {
      return policy('sudo command not in the allowlist', 'add it to ARCH_MCP_SUDO_ALLOW');
    }
  }

  const joined = argv.join(' ').toLowerCase();
  for (const rule of RULES) {
    if (rule.test(argv, joined)) return policy(rule.reason, rule.hint, rule.id);
  }
  return null;
}

function policy(message: string, hint: string, rule?: string): AppError {
  const error: AppError = { code: 'E_POLICY', message, hint };
  if (rule !== undefined) error.data = { rule };
  return error;
}
