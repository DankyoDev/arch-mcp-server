/**
 * Call every tool through the real MCP server and report status + bytes.
 * Read tools run normally; mutations run with dry_run so nothing changes.
 *
 * Usage: ARCH_MCP_HOST=... ARCH_MCP_PORT=... ARCH_MCP_USER=... ARCH_MCP_KEY=... pnpm audit:tools
 */
import { startMcp } from '../test/helpers/mcp-client.js';
import type { ToolEnvelope } from '../test/helpers/mcp-client.js';

interface AuditCall {
  tool: string;
  args: Record<string, unknown>;
  /** Error codes that are a valid answer for this call (e.g. E_UNSUPPORTED). */
  allowedCodes?: string[];
}

const CALLS: readonly AuditCall[] = [
  { tool: 'sys_info', args: {} },
  { tool: 'sys_status', args: {} },
  { tool: 'sys_status', args: { detail: 'detailed' } },
  { tool: 'sys_metrics', args: { window_ms: 400 } },
  { tool: 'proc_list', args: { limit: 3 } },
  { tool: 'proc_renice', args: { pid: 1, nice: 5, dry_run: true } },
  { tool: 'sys_services_summary', args: {} },
  { tool: 'svc_list', args: { limit: 5 } },
  { tool: 'svc_status', args: { unit: 'sshd.service' } },
  { tool: 'svc_failed', args: {} },
  { tool: 'svc_timers', args: {} },
  { tool: 'svc_unit_file', args: { unit: 'sshd.service' } },
  { tool: 'svc_action', args: { unit: 'sshd.service', action: 'restart', dry_run: true }, allowedCodes: ['E_POLICY'] },
  { tool: 'svc_action', args: { unit: 'nginx.service', action: 'restart', dry_run: true } },
  { tool: 'svc_daemon_reload', args: { dry_run: true } },
  {
    tool: 'svc_unit_write',
    args: {
      unit: 'arch-mcp-audit.service',
      content: '[Service]\nExecStart=/bin/true\n',
      enable: false,
      dry_run: true,
    },
  },
  { tool: 'svc_unit_delete', args: { unit: 'arch-mcp-audit.service', dry_run: true } },
  { tool: 'log_query', args: { limit: 3 } },
  { tool: 'log_query', args: { since: '-1h', limit: 3 } },
  { tool: 'log_errors', args: {} },
  { tool: 'log_boots', args: {} },
  { tool: 'log_unit_tail', args: { unit: 'sshd.service', lines: 3 } },
  { tool: 'pkg_status', args: {} },
  { tool: 'pkg_search', args: { query: 'bash', limit: 3 } },
  { tool: 'pkg_info', args: { name: 'bash' } },
  { tool: 'pkg_owns', args: { path: '/usr/bin/bash' } },
  { tool: 'pkg_update', args: { dry_run: true } },
  { tool: 'pkg_install', args: { names: ['htop'], dry_run: true } },
  { tool: 'pkg_remove', args: { names: ['htop'], dry_run: true } },
  { tool: 'net_status', args: {} },
  { tool: 'net_ports', args: { limit: 5 } },
  { tool: 'net_conns', args: {} },
  { tool: 'net_check', args: { target: '127.0.0.1:22', timeout_ms: 2000 } },
  { tool: 'net_dns', args: { name: 'localhost' } },
  { tool: 'net_wifi', args: {}, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'net_firewall', args: {} },
  { tool: 'fs_usage', args: {} },
  { tool: 'fs_ls', args: { path: '/etc', limit: 5 } },
  { tool: 'fs_find', args: { path: '/etc', name: '*.conf', limit: 3 } },
  { tool: 'fs_read', args: { path: '/etc/pacman.conf', lines: 5 } },
  { tool: 'fs_grep', args: { path: '/etc', pattern: 'PermitRootLogin', max_results: 3 } },
  { tool: 'fs_mkdir', args: { path: '/tmp/arch-mcp-audit-dir', dry_run: true } },
  { tool: 'fs_copy', args: { source: '/etc/hostname', destination: '/tmp/arch-mcp-audit-copy', dry_run: true } },
  { tool: 'fs_move', args: { source: '/tmp/arch-mcp-audit-a', destination: '/tmp/arch-mcp-audit-b', dry_run: true } },
  { tool: 'fs_remove', args: { path: '/tmp/arch-mcp-audit-remove', dry_run: true } },
  { tool: 'fs_chmod', args: { path: '/tmp/arch-mcp-audit-chmod', mode: '600', dry_run: true } },
  { tool: 'fs_chown', args: { path: '/tmp/arch-mcp-audit-chown', owner: 'root:root', dry_run: true } },
  { tool: 'fs_symlink', args: { target: '/etc/hostname', link: '/tmp/arch-mcp-audit-link', dry_run: true } },
  { tool: 'fs_archive', args: { action: 'create', archive: '/tmp/arch-mcp-audit.tar', source: '/etc/hostname', dry_run: true } },
  { tool: 'fs_archive_list', args: { archive: '/etc/hostname' }, allowedCodes: ['E_NOTFOUND', 'E_INTERNAL'] },
  { tool: 'fs_checksum', args: { path: '/etc/hostname', algorithm: 'sha256' } },
  { tool: 'fs_du', args: { path: '/etc', depth: 1, limit: 3 } },
  { tool: 'fetch_url', args: { url: 'http://example.com', path: '/tmp/arch-mcp-audit-download', dry_run: true } },
  {
    tool: 'http_check',
    args: { url: 'http://127.0.0.1:22', timeout_ms: 2000 },
    allowedCodes: ['E_CONN', 'E_INTERNAL', 'E_TIMEOUT'],
  },
  { tool: 'net_ping', args: { host: '127.0.0.1', count: 2, timeout_ms: 3000 } },
  {
    tool: 'net_dns_set',
    args: { interface: 'eth0', servers: ['1.1.1.1'], dry_run: true },
    allowedCodes: ['E_UNSUPPORTED', 'E_INTERNAL'],
  },
  { tool: 'net_route', args: { action: 'add', destination: '203.0.113.0/24', dev: 'lo', dry_run: true } },
  { tool: 'fw_rule', args: { action: 'allow', port: 8080, dry_run: true }, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'usr_action', args: { action: 'create', name: 'archmcpaudit', dry_run: true } },
  { tool: 'fs_write', args: { path: '/tmp/arch-mcp-audit.txt', content: 'x', dry_run: true } },
  { tool: 'fs_smart', args: { device: '/dev/vda' }, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'fs_mounts', args: { limit: 5 } },
  { tool: 'hw_summary', args: {} },
  { tool: 'hw_sensors', args: {}, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'hw_gpu', args: {} },
  { tool: 'hw_pci', args: { limit: 3 }, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'hw_usb', args: {}, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'hw_power', args: {} },
  { tool: 'boot_info', args: {} },
  { tool: 'boot_time', args: {} },
  { tool: 'boot_blame', args: { limit: 3 } },
  { tool: 'usr_sessions', args: {} },
  { tool: 'usr_logins', args: { limit: 3 } },
  { tool: 'sec_audit', args: {} },
  { tool: 'sec_ssh_config', args: { key: 'permitrootlogin' } },
  { tool: 'job_status', args: { job_id: 'deadbeef' }, allowedCodes: ['E_NOTFOUND'] },
  { tool: 'host_capabilities', args: {} },
  { tool: 'exec', args: { argv: ['cat', '/etc/hostname'], dry_run: true } },
  { tool: 'exec_gaps', args: { limit: 10 } },
  { tool: 'exec_any', args: { argv: ['croc', '--version'], dry_run: true }, allowedCodes: ['E_POLICY'] },
  {
    tool: 'script_run',
    args: { language: 'python', source: 'print(1)', dry_run: true },
    allowedCodes: ['E_POLICY'],
  },
  { tool: 'gap_report', args: { binary: 'croc', note: 'audit', dry_run: true } },
  { tool: 'pkg_files', args: { name: 'bash', limit: 5 } },
  { tool: 'pkg_clean', args: { dry_run: true } },
  { tool: 'pkg_sync', args: { dry_run: true } },
  { tool: 'aur_search', args: { query: 'yay', limit: 3 }, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'aur_install', args: { name: 'yay', dry_run: true }, allowedCodes: ['E_UNSUPPORTED'] },
  { tool: 'mod_list', args: { limit: 5 } },
  { tool: 'mod_info', args: { name: 'ext4' } },
  { tool: 'mod_load', args: { name: 'loop', dry_run: true } },
  { tool: 'mod_unload', args: { name: 'loop', dry_run: true } },
  { tool: 'mod_blacklist', args: { name: 'pcspkr', dry_run: true } },
  { tool: 'sysctl_get', args: { key: 'vm.swappiness' } },
  { tool: 'sysctl_set', args: { key: 'vm.swappiness', value: '60', dry_run: true } },
  { tool: 'kernel_log', args: { lines: 3 } },
  { tool: 'fs_mount', args: { source: '/dev/sda1', target: '/mnt', dry_run: true } },
  { tool: 'fs_umount', args: { target: '/mnt', dry_run: true } },
  { tool: 'coredump_list', args: { limit: 3 } },
  { tool: 'coredump_info', args: { pid: 1 }, allowedCodes: ['E_NOTFOUND', 'E_INTERNAL'] },
  { tool: 'journal_vacuum', args: { max_size: '1G', dry_run: true } },
  { tool: 'usr_list', args: { limit: 5 } },
];

async function main(): Promise<void> {
  const client = await startMcp({
    ARCH_MCP_PROFILE: 'full',
    ARCH_MCP_MODE: 'write',
    ARCH_MCP_RATE_LIMIT: '600',
  });

  const failures: string[] = [];
  const rows: string[] = [];

  try {
    const tools = await client.listTools();
    for (const call of CALLS) {
      const args = Object.keys(call.args).length === 0 ? '{}' : JSON.stringify(call.args);
      if (!tools.includes(call.tool)) {
        failures.push(`${call.tool}: not registered`);
        rows.push(`! ${call.tool.padEnd(22)} MISSING`);
        continue;
      }
      const envelope: ToolEnvelope = await client.call(call.tool, call.args);
      const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
      const status = envelope.ok ? 'ok' : (envelope.error?.code ?? 'error');
      const tolerated = call.allowedCodes?.includes(status) === true;
      if (!envelope.ok && !tolerated) {
        failures.push(`${call.tool}: ${status} ${envelope.error?.message ?? ''}`);
        rows.push(`! ${call.tool.padEnd(22)} ${status.padEnd(14)} ${bytes} B  ${args}`);
        rows.push(`    ${envelope.error?.message ?? ''} ${envelope.error?.hint ?? ''}`);
        continue;
      }
      rows.push(`  ${call.tool.padEnd(22)} ${status.padEnd(14)} ${bytes} B  ${args}`);
    }
  } finally {
    client.close();
  }

  console.log(rows.join('\n'));
  console.log(`\n${CALLS.length} calls, ${failures.length} unexpected failure(s)`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  }
}

await main();
