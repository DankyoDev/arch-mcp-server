import { z } from 'zod';
import { ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import type { SectionSpec } from '../exec/sequence.js';
import { parseBlame, parseBootctl, parsePackageVersions, parseSystemdAnalyze } from '../parse/boot.js';
import { defineTool, toolData } from './registry.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const bootInfoTool = defineTool({
  name: 'boot_info',
  title: 'Boot and kernel info',
  description:
    'Running kernel, installed kernels, bootloader, EFI and secure boot state. Use it before kernel or bootloader work.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;

    const sections: SectionSpec[] = [
      { key: 'kernel', argv: ['uname', '-r'] },
      { key: 'cmdline', argv: ['cat', '/proc/cmdline'] },
      { key: 'efi', argv: ['test', '-d', '/sys/firmware/efi'] },
      { key: 'bootctl', argv: ['bootctl', 'status'] },
      {
        key: 'kernels',
        argv: ['sh', '-c', "pacman -Q 2>/dev/null | grep -E '^linux(-lts|-zen|-hardened)? '"],
      },
    ];
    if (capabilities.data.features.mokutil === true) {
      sections.push({ key: 'secure', argv: ['mokutil', '--sb-state'] });
    }

    const batch = await runSections(ctx.conn, sections, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!batch.ok) return batch;

    const bootctl = parseBootctl(batch.data.bootctl?.stdout ?? '');
    const cmdline = (batch.data.cmdline?.stdout ?? '').trim();
    const data: Record<string, unknown> = {
      running_kernel: (batch.data.kernel?.stdout ?? '').trim(),
      installed: parsePackageVersions(batch.data.kernels?.stdout ?? ''),
      cmdline: cmdline.length > 300 ? `${cmdline.slice(0, 300)}...` : cmdline,
      efi: batch.data.efi?.code === 0 || bootctl.efi,
    };
    if (bootctl.bootloader !== undefined) data.bootloader = bootctl.bootloader;
    const secure = parseSecureBoot(batch.data.secure?.stdout ?? '');
    if (secure !== undefined) data.secure_boot = secure;
    return ok(toolData(data));
  },
});

export const bootTimeTool = defineTool({
  name: 'boot_time',
  title: 'Boot duration',
  description:
    'Firmware, loader, kernel and userspace boot times in milliseconds. Use it to see where boot time goes.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const result = await runCommand(ctx.conn, ['systemd-analyze'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;
    return ok(toolData(parseSystemdAnalyze(result.data.stdout)));
  },
});

export const bootBlameTool = defineTool({
  name: 'boot_blame',
  title: 'Slowest boot units',
  description:
    'The N slowest units at boot. Use it after boot_time when userspace is the slow phase.',
  schema: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe('Units to return'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(ctx.conn, ['systemd-analyze', 'blame'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;
    return ok(toolData(parseBlame(result.data.stdout, input.limit)));
  },
});

function parseSecureBoot(text: string): boolean | undefined {
  if (/SecureBoot enabled/i.test(text)) return true;
  if (/SecureBoot disabled/i.test(text)) return false;
  return undefined;
}
