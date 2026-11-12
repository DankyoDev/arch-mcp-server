import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { confirmationPayload, consumeConfirmation } from '../policy/confirm.js';
import { defineTool, toolData } from './registry.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const hostCapabilitiesTool = defineTool({
  name: 'host_capabilities',
  title: 'Host capabilities',
  description:
    'Which tools and features this host has (pacman, journald, sensors, nftables, AUR...), detected once at startup. Use it before calling a tool that may be unsupported.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (_input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;
    return ok(toolData(capabilities.data));
  },
});

/** Escape hatch: only admin + ARCH_MCP_ALLOW_RAW=1, and only allowlisted binaries. */
const RAW_ALLOWED = new Set([
  'systemctl',
  'journalctl',
  'pacman',
  'ip',
  'ss',
  'df',
  'du',
  'find',
  'stat',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'free',
  'uptime',
  'uname',
  'lsblk',
  'findmnt',
  'sensors',
  'lspci',
  'lsusb',
  'getent',
  'hostname',
  'id',
  'whoami',
  'ps',
  'date',
  'nproc',
  'lscpu',
  'sshd',
  'systemd-analyze',
  'bootctl',
  'loginctl',
  'last',
  'lastb',
  'nft',
  'iptables',
  'smartctl',
  'nmcli',
]);

export const rawExecTool = defineTool({
  name: 'raw_exec',
  title: 'Raw command (escape hatch)',
  description:
    'Run one allowlisted binary with argv after two-step confirmation. Off unless ARCH_MCP_ALLOW_RAW=1 and mode=admin; shells and sudo are refused.',
  schema: z.object({
    argv: z.array(z.string().min(1).max(4096)).min(1).max(32).describe('Command and arguments'),
    timeout_ms: z.number().int().min(100).max(300_000).default(15_000).describe('Timeout in milliseconds'),
    dry_run: z.boolean().default(false).describe('Preview without running'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (!ctx.config.allowRaw) {
      return err('E_POLICY', 'raw_exec is disabled', 'set ARCH_MCP_ALLOW_RAW=1 to enable it');
    }
    if (ctx.config.mode !== 'admin') {
      return err('E_POLICY', 'raw_exec requires admin mode', 'set ARCH_MCP_MODE=admin');
    }
    const binary = input.argv[0] ?? '';
    if (!RAW_ALLOWED.has(binary)) {
      return err('E_POLICY', `${binary} is not in the raw_exec allowlist`, 'use a task tool instead');
    }
    if (input.dry_run) {
      return ok(
        toolData({
          argv: input.argv,
          result: 'dry_run',
          ...confirmationPayload('raw_exec', input, ctx.config.confirmTtl),
        }),
      );
    }

    if (input.token === undefined) {
      return ok(
        toolData(
          confirmationPayload('raw_exec', input, ctx.config.confirmTtl, {
            argv: input.argv,
            effect: 'runs directly on the host',
          }),
        ),
      );
    }
    const consumed = consumeConfirmation(input.token, 'raw_exec', input);
    if (!consumed.ok) return consumed;

    const result = await runCommand(ctx.conn, input.argv, {
      timeoutMs: input.timeout_ms,
      maxBytes: 32_768,
    });
    if (!result.ok) return result;
    return ok(
      toolData({
        code: result.data.code,
        stdout: result.data.stdout,
        stderr: result.data.stderr,
        truncated: result.data.truncated,
      }),
    );
  },
});
