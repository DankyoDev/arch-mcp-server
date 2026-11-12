import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, MUTATE, READ, runChecked } from './ops.js';

const PKG = /^[a-z0-9@._+-]{1,128}$/i;

async function cacheBytes(ctx: ToolContext): Promise<number> {
  const result = await runCommand(ctx.conn, ['du', '-sb', '/var/cache/pacman/pkg'], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 4096,
  });
  if (!result.ok) return 0;
  return Number(result.data.stdout.trim().split(/\s+/)[0] ?? 0) || 0;
}

export const pkgFilesTool = defineTool({
  name: 'pkg_files',
  title: 'Files installed by a package',
  description: 'List the files owned by an installed package (pacman -Ql), bounded.',
  schema: z.object({
    name: z.string().max(128).regex(PKG, 'not a valid package name').describe('Installed package, e.g. openssh'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runChecked(ctx, ['pacman', '-Ql', input.name], 65_536);
    if (!result.ok) return result;
    const files = result.data.stdout
      .split('\n')
      .filter((line) => line.includes(' '))
      .map((line) => line.slice(line.indexOf(' ') + 1))
      .filter((path) => path !== '' && !path.endsWith('/'));
    return ok(
      toolData(
        { package: input.name, files: files.slice(0, input.limit) },
        { total: files.length },
      ),
    );
  },
});

export const pkgCleanTool = defineTool({
  name: 'pkg_clean',
  title: 'Clean the pacman cache',
  description: 'Remove cached packages that are no longer installed (pacman -Sc). Two-step confirmation.',
  schema: z.object({
    dry_run: z.boolean().default(false).describe('Preview the cache size without cleaning'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const before = await cacheBytes(ctx);
    return confirmed(ctx, 'pkg_clean', input as never, { cache_b: before, action: 'pacman -Sc' }, async () => {
      const cleaned = await runChecked(ctx, ['pacman', '-Sc', '--noconfirm'], 16_384, 180_000);
      if (!cleaned.ok) return cleaned;
      const after = await cacheBytes(ctx);
      return ok(toolData({ cache_before_b: before, cache_after_b: after, freed_b: Math.max(0, before - after) }));
    });
  },
});

export const pkgSyncTool = defineTool({
  name: 'pkg_sync',
  title: 'Refresh pacman databases',
  description: 'Download fresh package databases (pacman -Sy). Does not upgrade anything. Two-step confirmation.',
  schema: z.object({
    dry_run: z.boolean().default(false).describe('Preview without refreshing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    return confirmed(ctx, 'pkg_sync', input as never, { action: 'pacman -Sy' }, async () => {
      const result = await runChecked(ctx, ['pacman', '-Sy', '--noconfirm'], 32_768, 300_000);
      if (!result.ok) return result;
      return ok(toolData({ synced: true }));
    });
  },
});

export const aurSearchTool = defineTool({
  name: 'aur_search',
  title: 'Search the AUR',
  description: 'Search AUR packages through the installed helper (yay/paru). Read-only.',
  schema: z.object({
    query: z.string().min(1).max(120).describe('Search term'),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  annotations: { ...READ, openWorldHint: true },
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const caps = await ctx.capabilities();
    const helper = caps.ok && caps.data.features.aur ? 'yay' : null;
    if (helper === null) {
      return err('E_UNSUPPORTED', 'no AUR helper (yay/paru) installed', 'install yay or paru to manage AUR packages');
    }
    const result = await runChecked(ctx, [helper, '-Ss', input.query], 65_536, 60_000);
    if (!result.ok) return result;
    const entries: Array<{ name: string; version: string; description: string }> = [];
    let current: { name: string; version: string; description: string } | null = null;
    for (const line of result.data.stdout.split('\n')) {
      const header = /^(?:aur|community|extra|core)\/(\S+)\s+(\S+)/.exec(line.trim());
      if (header) {
        if (current) entries.push(current);
        current = { name: header[1] ?? '', version: header[2] ?? '', description: '' };
      } else if (current && line.trim() !== '' && current.description === '') {
        current.description = line.trim().slice(0, 160);
      }
      if (entries.length >= input.limit) break;
    }
    if (current) entries.push(current);
    return ok(toolData(entries.slice(0, input.limit), { total: entries.length }));
  },
});

export const aurInstallTool = defineTool({
  name: 'aur_install',
  title: 'Install an AUR package',
  description:
    'Build and install an AUR package with yay (makepkg needs base-devel). Long: prefer job_* when available. Two-step confirmation.',
  schema: z.object({
    name: z.string().max(128).regex(PKG, 'not a valid package name').describe('AUR package name, e.g. visual-studio-code-bin'),
    dry_run: z.boolean().default(false).describe('Preview without building'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const caps = await ctx.capabilities();
    if (!caps.ok || caps.data.features.aur !== true) {
      return err('E_UNSUPPORTED', 'no AUR helper (yay/paru) installed', 'install yay or paru first');
    }
    return confirmed(ctx, 'aur_install', input as never, { package: input.name, action: 'yay -S --noconfirm' }, async () => {
      const result = await runChecked(ctx, ['yay', '-S', '--noconfirm', input.name], 65_536, 900_000);
      if (!result.ok) return result;
      return ok(toolData({ package: input.name, installed: true, via: 'yay' }));
    });
  },
});
