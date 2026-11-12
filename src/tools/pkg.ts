import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import type { SectionSpec } from '../exec/sequence.js';
import {
  parseHumanSize,
  parsePacmanInfo,
  parsePacmanQo,
  parsePacmanQu,
  parsePacmanSs,
  splitList,
} from '../parse/pacman.js';
import { defineTool, toolData } from './registry.js';
import { requireFeature } from './guards.js';
import { createConfirmation, consumeConfirmation } from '../policy/confirm.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const PKG_TIMEOUT_MS = 300_000;

const PACKAGE_NAME = /^[A-Za-z0-9@._+-]{1,200}$/;

export const pkgStatusTool = defineTool({
  name: 'pkg_status',
  title: 'Package status',
  description:
    'Pending updates, orphans, sync age and cache size. Works without checkupdates; AUR updates are counted when yay or paru exists.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (_input, ctx) => {
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch) or use a distro-specific tool');
    if (!guard.ok) return guard;

    const sections: SectionSpec[] = [
      { key: 'updates', argv: ['pacman', '-Qu'] },
      { key: 'orphans', argv: ['pacman', '-Qdtq'] },
      { key: 'sync', argv: ['stat', '-c', '%Y', '/var/lib/pacman/sync'] },
      { key: 'cache', argv: ['du', '-sb', '/var/cache/pacman/pkg'] },
    ];

    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;
    const aurHelper = capabilities.data.tools.yay !== undefined
      ? 'yay'
      : capabilities.data.tools.paru !== undefined
        ? 'paru'
        : undefined;
    if (aurHelper !== undefined) sections.push({ key: 'aur', argv: [aurHelper, '-Qua'] });

    const batch = await runSections(ctx.conn, sections, {
      timeoutMs: PKG_TIMEOUT_MS,
      maxBytes: 262_144,
    });
    if (!batch.ok) return batch;

    const updates = parsePacmanQu(batch.data.updates?.stdout ?? '');
    const orphanLines = (batch.data.orphans?.stdout ?? '').trim();
    const syncSeconds = Number((batch.data.sync?.stdout ?? '').trim());
    const cache = /^(\d+)/.exec((batch.data.cache?.stdout ?? '').trim());

    const data: Record<string, unknown> = {
      updates: updates.slice(0, 50),
      orphans: orphanLines === '' ? 0 : orphanLines.split('\n').length,
      cache_b: cache?.[1] !== undefined ? Number(cache[1]) : 0,
    };
    if (Number.isFinite(syncSeconds) && syncSeconds > 0) {
      data.last_sync = new Date(syncSeconds * 1000).toISOString();
    }
    if (batch.data.aur !== undefined) {
      const aur = (batch.data.aur.stdout ?? '').trim();
      data.aur = aur === '' ? 0 : aur.split('\n').length;
    }
    return ok(toolData(data, { total: updates.length }));
  },
});

export const pkgSearchTool = defineTool({
  name: 'pkg_search',
  title: 'Search packages',
  description:
    'Search packages in the configured repositories or AUR. Returns name, version, repo and description; descriptions are trimmed.',
  schema: z.object({
    query: z.string().min(1).max(100).describe('Search term'),
    source: z.enum(['repo', 'aur']).default('repo').describe('Where to search'),
    limit: z.number().int().min(1).max(50).default(10).describe('Results per page'),
  }),
  annotations: OPEN,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch) or use a distro-specific tool');
    if (!guard.ok) return guard;

    let argv: string[];
    if (input.source === 'aur') {
      const capabilities = await ctx.capabilities();
      if (!capabilities.ok) return capabilities;
      const helper = capabilities.data.tools.yay !== undefined
        ? 'yay'
        : capabilities.data.tools.paru !== undefined
          ? 'paru'
          : undefined;
      if (helper === undefined) {
        return err('E_UNSUPPORTED', 'no AUR helper found', 'install yay or paru, or search source=repo');
      }
      argv = [helper, '-Ss', '--aur', input.query];
    } else {
      argv = ['pacman', '-Ss', input.query];
    }

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: PKG_TIMEOUT_MS,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;

    const found = parsePacmanSs(result.data.stdout).slice(0, input.limit);
    return ok(toolData(found, { total: found.length }));
  },
});

export const pkgInfoTool = defineTool({
  name: 'pkg_info',
  title: 'Package details',
  description:
    'Details of an installed or remote package: version, size, dependencies and what requires it. Tries pacman -Qi, then -Si.',
  schema: z.object({
    name: z.string().max(200).regex(PACKAGE_NAME, 'not a valid package name').describe('Package name'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch) or use a distro-specific tool');
    if (!guard.ok) return guard;

    const installed = await runCommand(ctx.conn, ['pacman', '-Qi', input.name], {
      timeoutMs: PKG_TIMEOUT_MS,
      maxBytes: 65_536,
    });
    if (installed.ok && installed.data.code === 0) {
      const info = parsePacmanInfo(installed.data.stdout);
      if (info.Name !== undefined) {
        return ok(toolData(installedPayload(info, true)));
      }
    }

    const remote = await runCommand(ctx.conn, ['pacman', '-Si', input.name], {
      timeoutMs: PKG_TIMEOUT_MS,
      maxBytes: 65_536,
    });
    if (remote.ok && remote.data.code === 0) {
      const info = parsePacmanInfo(remote.data.stdout);
      if (info.Name !== undefined) {
        return ok(toolData(installedPayload(info, false)));
      }
    }

    return err('E_NOTFOUND', `package ${input.name} not found`, 'search it with pkg_search');
  },
});

export const pkgOwnsTool = defineTool({
  name: 'pkg_owns',
  title: 'Who owns a path',
  description:
    'Which package owns a file path. Use it before editing or deleting a system file.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute file path'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    if (!input.path.startsWith('/')) {
      return err('E_POLICY', 'path must be absolute', 'use a path starting with /');
    }
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch) or use a distro-specific tool');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['pacman', '-Qo', input.path], {
      timeoutMs: PKG_TIMEOUT_MS,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;

    const owner = parsePacmanQo(result.data.stdout);
    if (owner === null || result.data.code !== 0) {
      return err('E_NOTFOUND', `no package owns ${input.path}`, 'it may belong to another package manager');
    }
    return ok(toolData({ path: input.path, package: owner.package, version: owner.version }));
  },
});

function installedPayload(info: Record<string, string>, installed: boolean): Record<string, unknown> {
  const sizeText = info['Installed Size'] ?? info['Download Size'] ?? '';
  const payload: Record<string, unknown> = {
    name: info.Name ?? '',
    version: info.Version ?? '',
    size_b: parseHumanSize(sizeText),
    deps: splitList(info['Depends On']),
    required_by: splitList(info['Required By']),
    installed,
  };
  if (info.Repository !== undefined) payload.repo = info.Repository;
  return payload;
}

const PACKAGE_LIST = z
  .array(z.string().max(200).regex(PACKAGE_NAME, 'not a valid package name'))
  .min(1)
  .max(20);

const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const pkgUpdateTool = defineTool({
  name: 'pkg_update',
  title: 'Update packages',
  description:
    'Full system update. With dry_run=true (default) it only lists pending updates; to apply it, repeat with dry_run=false and a token.',
  schema: z.object({
    dry_run: z.boolean().default(true).describe('Only list pending updates'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch)');
    if (!guard.ok) return guard;

    if (input.dry_run) {
      const result = await runCommand(ctx.conn, ['pacman', '-Qu'], {
        timeoutMs: PKG_TIMEOUT_MS,
        maxBytes: 65_536,
      });
      if (!result.ok) return result;
      const updates = parsePacmanQu(result.data.stdout);
      return ok(toolData({ updates: updates.length, packages: updates.slice(0, 50) }));
    }

    if (input.token === undefined) {
      const confirmation = createConfirmation('pkg_update', input as unknown as Record<string, unknown>, ctx.config.confirmTtl);
      return err('E_CONFIRM', 'confirmation required', 'repeat with dry_run=false and token', {
        token: confirmation.token,
        expires_in_s: confirmation.expiresInS,
        preview: { effect: 'pacman -Syu --noconfirm' },
      });
    }
    const consumed = consumeConfirmation(input.token, 'pkg_update', input as unknown as Record<string, unknown>);
    if (!consumed.ok) return consumed;

    const started = performance.now();
    const result = await runCommand(ctx.conn, ['pacman', '-Syu', '--noconfirm'], {
      timeoutMs: PKG_TIMEOUT_MS,
      maxBytes: 32_768,
    });
    if (!result.ok) return result;
    if (result.data.code !== 0) return pkgFailure(result.data.stderr, 'pacman -Syu failed');
    return ok(
      toolData({
        ok: true,
        ms: Math.round(performance.now() - started),
        output: result.data.stdout.slice(-1000),
      }),
    );
  },
});

export const pkgInstallTool = defineTool({
  name: 'pkg_install',
  title: 'Install packages',
  description:
    'Install packages from the configured repositories after two-step confirmation. Use dry_run to see the resolved argv.',
  schema: z.object({
    names: PACKAGE_LIST.describe('Package names'),
    dry_run: z.boolean().default(false).describe('Preview without installing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch)');
    if (!guard.ok) return guard;

    const argv = ['pacman', '-S', '--needed', '--noconfirm', ...input.names];
    if (input.dry_run) return ok(toolData({ argv, result: 'dry_run' }));
    if (input.token === undefined) {
      const confirmation = createConfirmation('pkg_install', input as unknown as Record<string, unknown>, ctx.config.confirmTtl);
      return err('E_CONFIRM', 'confirmation required', 'repeat the call with token', {
        token: confirmation.token,
        expires_in_s: confirmation.expiresInS,
        preview: { names: input.names, effect: 'installs packages and dependencies' },
      });
    }
    const consumed = consumeConfirmation(input.token, 'pkg_install', input as unknown as Record<string, unknown>);
    if (!consumed.ok) return consumed;

    const started = performance.now();
    const result = await runCommand(ctx.conn, argv, { timeoutMs: PKG_TIMEOUT_MS, maxBytes: 32_768 });
    if (!result.ok) return result;
    if (result.data.code !== 0) return pkgFailure(result.data.stderr, 'pacman -S failed');
    return ok(
      toolData({ installed: input.names, ms: Math.round(performance.now() - started) }),
    );
  },
});

export const pkgRemoveTool = defineTool({
  name: 'pkg_remove',
  title: 'Remove packages',
  description:
    'Remove packages without touching dependencies after two-step confirmation. Use dry_run to preview the argv.',
  schema: z.object({
    names: PACKAGE_LIST.describe('Package names'),
    dry_run: z.boolean().default(false).describe('Preview without removing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'pacman', 'install pacman (Arch)');
    if (!guard.ok) return guard;

    const argv = ['pacman', '-R', '--noconfirm', ...input.names];
    if (input.dry_run) return ok(toolData({ argv, result: 'dry_run' }));
    if (input.token === undefined) {
      const confirmation = createConfirmation('pkg_remove', input as unknown as Record<string, unknown>, ctx.config.confirmTtl);
      return err('E_CONFIRM', 'confirmation required', 'repeat the call with token', {
        token: confirmation.token,
        expires_in_s: confirmation.expiresInS,
        preview: { names: input.names, effect: 'removes the packages only' },
      });
    }
    const consumed = consumeConfirmation(input.token, 'pkg_remove', input as unknown as Record<string, unknown>);
    if (!consumed.ok) return consumed;

    const result = await runCommand(ctx.conn, argv, { timeoutMs: PKG_TIMEOUT_MS, maxBytes: 32_768 });
    if (!result.ok) return result;
    if (result.data.code !== 0) return pkgFailure(result.data.stderr, 'pacman -R failed');
    return ok(toolData({ removed: input.names }));
  },
});

/** Map pacman failures to the closest contract code instead of always E_PERM. */
function pkgFailure(stderr: string, fallback: string) {
  const text = stderr.trim();
  const line = (text.split('\n')[0] ?? fallback).slice(0, 200);
  if (/target not found|no such package|package .* was not found/i.test(text)) {
    return err('E_NOTFOUND', line, 'search it with pkg_search');
  }
  if (/access denied|permission|not permitted|requires root/i.test(text)) {
    return err('E_PERM', line, 'run with a user allowed to use pacman');
  }
  if (/database is locked|unable to lock database/i.test(text)) {
    return err('E_INTERNAL', line, 'another pacman process is running; retry later');
  }
  return err('E_INTERNAL', line !== '' ? line : fallback, 'check the pacman output');
}
