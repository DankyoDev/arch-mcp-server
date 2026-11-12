import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import { confirmed, MUTATE, runChecked } from './ops.js';

const TARGET = /^\/[^\0\n]{0,255}$/;
const SOURCE = /^[A-Za-z0-9_=:.,+@%/\\-]{1,256}$/;
const FSTYPE = /^[A-Za-z0-9._-]{1,32}$/;
const OPTIONS = /^[A-Za-z0-9=,._:-]{1,200}$/;

async function mountInfo(ctx: Parameters<typeof runChecked>[0], target: string) {
  const result = await runChecked(ctx, ['findmnt', '-n', '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS', '--target', target], 8192);
  if (!result.ok) return null;
  const line = result.data.stdout.trim();
  if (line === '') return null;
  const parts = line.split(/\s+/);
  return { target: parts[0], source: parts[1], fstype: parts[2], options: parts.slice(3).join(' ') };
}

export const fsMountTool = defineTool({
  name: 'fs_mount',
  title: 'Mount a filesystem',
  description: 'mount source at target (root). The target directory must exist. Two-step confirmation.',
  schema: z.object({
    source: z.string().max(256).regex(SOURCE, 'source contains unsupported characters').describe('/dev/sdb1, UUID=..., server:/export, tmpfs'),
    target: z.string().max(255).regex(TARGET, 'target must be an absolute path').describe('Existing directory, e.g. /mnt/usb'),
    fstype: z.string().max(32).regex(FSTYPE, 'invalid filesystem type').optional().describe('ext4, vfat, nfs...'),
    options: z.string().max(200).regex(OPTIONS, 'options contain unsupported characters').optional().describe('rw,noatime,nofail'),
    dry_run: z.boolean().default(false).describe('Preview without mounting'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.target === '/') return err('E_POLICY', 'refusing to mount over /', 'choose another target');
    const exists = await runCommand(ctx.conn, ['test', '-d', input.target], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 1024,
    });
    if (!exists.ok || exists.data.code !== 0) {
      return err('E_NOTFOUND', `target directory ${input.target} does not exist`, 'create it first with fs_mkdir');
    }
    const preview = {
      source: input.source,
      target: input.target,
      fstype: input.fstype ?? null,
      options: input.options ?? null,
    };
    return confirmed(ctx, 'fs_mount', input as never, preview, async () => {
      const argv = ['mount'];
      if (input.fstype) argv.push('-t', input.fstype);
      if (input.options) argv.push('-o', input.options);
      argv.push(input.source, input.target);
      const mounted = await runChecked(ctx, argv, 16_384, 60_000);
      if (!mounted.ok) return mounted;
      const info = await mountInfo(ctx, input.target);
      return ok(toolData({ mounted: info !== null, ...(info ?? {}) }));
    });
  },
});

export const fsUmountTool = defineTool({
  name: 'fs_umount',
  title: 'Unmount a filesystem',
  description: 'umount a target (root), optionally lazy. Refuses /. Two-step confirmation.',
  schema: z.object({
    target: z.string().max(255).regex(TARGET, 'target must be an absolute path').describe('Mount point, e.g. /mnt/usb'),
    lazy: z.boolean().default(false).describe('umount -l (detach now, clean up later)'),
    dry_run: z.boolean().default(false).describe('Preview without unmounting'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.target === '/') return err('E_POLICY', 'refusing to unmount /', 'this would take the system down');
    return confirmed(ctx, 'fs_umount', input as never, { target: input.target, lazy: input.lazy }, async () => {
      const argv = ['umount'];
      if (input.lazy) argv.push('-l');
      argv.push(input.target);
      const result = await runChecked(ctx, argv, 16_384, 60_000);
      if (!result.ok) return result;
      const info = await mountInfo(ctx, input.target);
      return ok(toolData({ target: input.target, mounted: info !== null }));
    });
  },
});
