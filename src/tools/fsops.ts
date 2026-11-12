import { basename, dirname } from 'node:path/posix';
import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, mapCommandError, MUTATE, READ, runChecked } from './ops.js';
import { isForbiddenWrite, isSensitivePath, isSystemRoot, validateSafePath } from './paths.js';

const MODE = /^[0-7]{3,4}$/;
const OWNER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}(:[A-Za-z_][A-Za-z0-9_.-]{0,31})?$/;

const ConfirmInput = {
  dry_run: z.boolean().default(false).describe('Preview without touching the host'),
  token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
};

async function destinationState(
  ctx: ToolContext,
  path: string,
): Promise<{ exists: boolean; directory: boolean }> {
  const result = await runCommand(ctx.conn, ['stat', '-c', '%F', path], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 1024,
  });
  if (!result.ok || result.data.code !== 0) return { exists: false, directory: false };
  return { exists: true, directory: result.data.stdout.trim() === 'directory' };
}

export const fsMkdirTool = defineTool({
  name: 'fs_mkdir',
  title: 'Create a directory',
  description:
    'Create a directory (and parents) with an optional octal mode. Two-step confirmation; refuses system roots.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute directory path'),
    mode: z.string().regex(MODE, 'expected an octal mode like 755').default('755').describe('Directory mode'),
    parents: z.boolean().default(true).describe('Create missing parents'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    if (isForbiddenWrite(path.data)) {
      return err('E_POLICY', 'refusing to write a system or credential path', 'use a user directory');
    }
    return confirmed(ctx, 'fs_mkdir', input as never, { path: path.data, mode: input.mode }, async () => {
      const argv = ['mkdir', ...(input.parents ? ['-p'] : []), '-m', input.mode, path.data];
      const result = await runChecked(ctx, argv);
      if (!result.ok) return result;
      return ok(toolData({ path: path.data, mode: input.mode, parents: input.parents }));
    });
  },
});

export const fsCopyTool = defineTool({
  name: 'fs_copy',
  title: 'Copy a file or directory',
  description:
    'Copy one path to another with optional recursive/preserve and explicit overwrite. Two-step confirmation.',
  schema: z.object({
    source: z.string().min(1).max(4096).describe('Absolute source path'),
    destination: z.string().min(1).max(4096).describe('Absolute destination path'),
    recursive: z.boolean().default(false).describe('Copy directories recursively'),
    preserve: z.boolean().default(false).describe('Preserve mode, ownership and timestamps'),
    overwrite: z.boolean().default(false).describe('Replace an existing destination file'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const source = validateSafePath(input.source);
    if (!source.ok) return source;
    const destination = validateSafePath(input.destination);
    if (!destination.ok) return destination;
    if (isSensitivePath(source.data)) {
      return err('E_POLICY', 'refusing to copy a credential store', 'read it manually if you really need it');
    }
    if (isForbiddenWrite(destination.data)) {
      return err('E_POLICY', 'refusing to write a system or credential path', 'choose a user directory');
    }
    return confirmed(
      ctx,
      'fs_copy',
      input as never,
      { source: source.data, destination: destination.data, recursive: input.recursive },
      async () => {
        if (!input.dry_run && !input.overwrite) {
          const state = await destinationState(ctx, destination.data);
          if (state.exists && !state.directory) {
            return err('E_POLICY', 'destination already exists', 'set overwrite=true to replace it');
          }
        }
        const argv = [
          'cp',
          ...(input.recursive ? ['-r'] : []),
          ...(input.preserve ? ['-p'] : []),
          input.overwrite ? '-f' : '-n',
          source.data,
          destination.data,
        ];
        const result = await runChecked(ctx, argv);
        if (!result.ok) return result;
        return ok(toolData({ source: source.data, destination: destination.data, recursive: input.recursive }));
      },
    );
  },
});

export const fsMoveTool = defineTool({
  name: 'fs_move',
  title: 'Move or rename',
  description: 'Move or rename one path with explicit overwrite. Two-step confirmation; refuses system roots.',
  schema: z.object({
    source: z.string().min(1).max(4096).describe('Absolute source path'),
    destination: z.string().min(1).max(4096).describe('Absolute destination path'),
    overwrite: z.boolean().default(false).describe('Replace an existing destination file'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const source = validateSafePath(input.source);
    if (!source.ok) return source;
    const destination = validateSafePath(input.destination);
    if (!destination.ok) return destination;
    if (isSensitivePath(source.data)) {
      return err('E_POLICY', 'refusing to move a credential store', 'do it manually if you really need it');
    }
    if (isForbiddenWrite(destination.data)) {
      return err('E_POLICY', 'refusing to write a system or credential path', 'choose a user directory');
    }
    return confirmed(
      ctx,
      'fs_move',
      input as never,
      { source: source.data, destination: destination.data },
      async () => {
        if (!input.dry_run && !input.overwrite) {
          const state = await destinationState(ctx, destination.data);
          if (state.exists && !state.directory) {
            return err('E_POLICY', 'destination already exists', 'set overwrite=true to replace it');
          }
        }
        const result = await runChecked(ctx, ['mv', input.overwrite ? '-f' : '-n', source.data, destination.data]);
        if (!result.ok) return result;
        return ok(toolData({ source: source.data, destination: destination.data }));
      },
    );
  },
});

export const fsRemoveTool = defineTool({
  name: 'fs_remove',
  title: 'Remove a path',
  description:
    'Remove a file or directory after two-step confirmation. Refuses system roots and credential paths; recursive is explicit.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute path'),
    recursive: z.boolean().default(false).describe('Remove directories recursively'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    if (isSystemRoot(path.data)) {
      return err('E_POLICY', 'refusing to remove a system root', 'remove a specific child path');
    }
    if (isForbiddenWrite(path.data)) {
      return err('E_POLICY', 'refusing to remove a system or credential path', 'do it manually');
    }
    return confirmed(ctx, 'fs_remove', input as never, { path: path.data, recursive: input.recursive }, async () => {
      const result = await runChecked(ctx, ['rm', input.recursive ? '-rf' : '-f', path.data]);
      if (!result.ok) return result;
      return ok(toolData({ path: path.data, recursive: input.recursive }));
    });
  },
});

export const fsChmodTool = defineTool({
  name: 'fs_chmod',
  title: 'Change permissions',
  description: 'Change an octal mode, optionally recursive. Two-step confirmation; refuses system roots and SSH keys.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute path'),
    mode: z.string().regex(MODE, 'expected an octal mode like 644').describe('New mode'),
    recursive: z.boolean().default(false).describe('Apply recursively'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    if (isSystemRoot(path.data) || /(^|\/)\.ssh(\/|$)/.test(path.data)) {
      return err('E_POLICY', 'refusing to chmod a system root or ~/.ssh', 'target a specific file');
    }
    return confirmed(ctx, 'fs_chmod', input as never, { path: path.data, mode: input.mode }, async () => {
      const result = await runChecked(ctx, ['chmod', ...(input.recursive ? ['-R'] : []), input.mode, path.data]);
      if (!result.ok) return result;
      return ok(toolData({ path: path.data, mode: input.mode, recursive: input.recursive }));
    });
  },
});

export const fsSymlinkTool = defineTool({
  name: 'fs_symlink',
  title: 'Create a symbolic link',
  description:
    'Create a symlink to a target after two-step confirmation. Refuses credential targets and system destinations.',
  schema: z.object({
    target: z.string().min(1).max(4096).describe('Absolute target path'),
    link: z.string().min(1).max(4096).describe('Absolute link path'),
    force: z.boolean().default(false).describe('Replace an existing link'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const target = validateSafePath(input.target);
    if (!target.ok) return target;
    const link = validateSafePath(input.link);
    if (!link.ok) return link;
    if (isSensitivePath(target.data)) {
      return err('E_POLICY', 'refusing to link a credential store', 'pick a regular file');
    }
    if (isForbiddenWrite(link.data)) {
      return err('E_POLICY', 'refusing to write a system or credential path', 'choose /tmp or a user directory');
    }
    return confirmed(ctx, 'fs_symlink', input as never, { target: target.data, link: link.data }, async () => {
      const result = await runChecked(ctx, ['ln', ...(input.force ? ['-f'] : []), '-s', target.data, link.data]);
      if (!result.ok) {
        if (/File exists/i.test(result.error.message)) {
          return err('E_POLICY', 'link already exists', 'set force=true to replace it');
        }
        return result;
      }
      return ok(toolData({ target: target.data, link: link.data }));
    });
  },
});

export const fsChownTool = defineTool({  name: 'fs_chown',
  title: 'Change ownership',
  description: 'Change user:group ownership, optionally recursive. Two-step confirmation; refuses system roots and SSH keys.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute path'),
    owner: z.string().regex(OWNER, 'expected user or user:group').describe('New owner'),
    recursive: z.boolean().default(false).describe('Apply recursively'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    if (isSystemRoot(path.data) || /(^|\/)\.ssh(\/|$)/.test(path.data)) {
      return err('E_POLICY', 'refusing to chown a system root or ~/.ssh', 'target a specific file');
    }
    return confirmed(ctx, 'fs_chown', input as never, { path: path.data, owner: input.owner }, async () => {
      const result = await runChecked(ctx, ['chown', ...(input.recursive ? ['-R'] : []), input.owner, path.data]);
      if (!result.ok) return result;
      return ok(toolData({ path: path.data, owner: input.owner, recursive: input.recursive }));
    });
  },
});

export const fsArchiveTool = defineTool({
  name: 'fs_archive',
  title: 'Create or extract a tar archive',
  description: 'Create or extract a .tar/.tar.gz archive after two-step confirmation. Use fs_archive_list to inspect one.',
  schema: z.object({
    action: z.enum(['create', 'extract']).describe('Create a new archive or extract an existing one'),
    archive: z.string().min(1).max(4096).describe('Absolute archive path'),
    source: z.string().min(1).max(4096).optional().describe('Source path for create'),
    destination: z.string().min(1).max(4096).optional().describe('Target directory for extract'),
    format: z.enum(['tar', 'tgz']).default('tar').describe('Archive format'),
    ...ConfirmInput,
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const archive = validateSafePath(input.archive);
    if (!archive.ok) return archive;
    if (isForbiddenWrite(archive.data)) {
      return err('E_POLICY', 'refusing to write a system path', 'choose /tmp or a user directory');
    }
    if (input.action === 'create') {
      if (input.source === undefined) {
        return err('E_POLICY', 'source is required to create an archive', 'pass the file or directory');
      }
      const source = validateSafePath(input.source);
      if (!source.ok) return source;
      if (isSensitivePath(source.data)) {
        return err('E_POLICY', 'refusing to archive a credential store', 'archive a user directory');
      }
      return confirmed(
        ctx,
        'fs_archive',
        input as never,
        { action: 'create', archive: archive.data, source: source.data, format: input.format },
        async () => {
          const argv = [
            'tar',
            input.format === 'tgz' ? '-czf' : '-cf',
            archive.data,
            '-C',
            dirname(source.data),
            basename(source.data),
          ];
          const result = await runChecked(ctx, argv);
          if (!result.ok) return result;
          return ok(toolData({ action: 'create', archive: archive.data, source: source.data }));
        },
      );
    }

    const destination = validateSafePath(input.destination ?? dirname(archive.data));
    if (!destination.ok) return destination;
    if (isForbiddenWrite(destination.data)) {
      return err('E_POLICY', 'refusing to extract into a system path', 'choose /tmp or a user directory');
    }
    return confirmed(
      ctx,
      'fs_archive',
      input as never,
      { action: 'extract', archive: archive.data, destination: destination.data, format: input.format },
      async () => {
        const made = await runChecked(ctx, ['mkdir', '-p', destination.data]);
        if (!made.ok) return made;
        const result = await runChecked(
          ctx,
          ['tar', input.format === 'tgz' ? '-xzf' : '-xf', archive.data, '-C', destination.data],
        );
        if (!result.ok) return result;
        return ok(toolData({ action: 'extract', archive: archive.data, destination: destination.data }));
      },
    );
  },
});

export const fsArchiveListTool = defineTool({
  name: 'fs_archive_list',
  title: 'List archive entries',
  description: 'List the entries of a .tar/.tar.gz archive without extracting it.',
  schema: z.object({
    archive: z.string().min(1).max(4096).describe('Absolute archive path'),
    format: z.enum(['tar', 'tgz']).default('tar').describe('Archive format'),
    limit: z.number().int().min(1).max(500).default(100).describe('Entries to return'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const archive = validateSafePath(input.archive);
    if (!archive.ok) return archive;
    const result = await runChecked(ctx, ['tar', input.format === 'tgz' ? '-tzf' : '-tf', archive.data], 262_144);
    if (!result.ok) return result;
    const all = result.data.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const entries = all.slice(0, input.limit);
    return ok(toolData({ archive: archive.data, entries }, { total: all.length }));
  },
});

const CHECKSUM_ALGORITHM = {
  sha256: 'sha256sum',
  sha512: 'sha512sum',
  md5: 'md5sum',
  b2: 'b2sum',
} as const;

export const fsChecksumTool = defineTool({
  name: 'fs_checksum',
  title: 'Checksum a file',
  description: 'Compute sha256, sha512, md5 or b2 checksum of one file.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute file path'),
    algorithm: z.enum(['sha256', 'sha512', 'md5', 'b2']).default('sha256').describe('Hash algorithm'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    const result = await runChecked(ctx, [CHECKSUM_ALGORITHM[input.algorithm], path.data], 4096);
    if (!result.ok) return result;
    const hash = (result.data.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (!/^[0-9a-f]{32,128}$/.test(hash)) {
      return err('E_PARSE', 'unexpected checksum output', 'check the file and algorithm');
    }
    return ok(toolData({ path: path.data, algorithm: input.algorithm, hash }));
  },
});

export const fsDuTool = defineTool({
  name: 'fs_du',
  title: 'Directory sizes',
  description: 'Sizes of directories below one path, sorted largest first, staying on one filesystem.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute directory path'),
    depth: z.number().int().min(1).max(3).default(1).describe('Depth below path'),
    limit: z.number().int().min(1).max(100).default(20).describe('Entries to return'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const path = validateSafePath(input.path);
    if (!path.ok) return path;
    const result = await runCommand(
      ctx.conn,
      ['du', '-x', '-a', '-d', String(input.depth), '-b', path.data],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;
    if (result.data.code !== 0 && result.data.stdout.trim() === '') {
      return { ok: false, error: mapCommandError(result.data.stderr, 'du failed') };
    }
    const all = result.data.stdout
      .split('\n')
      .map((line) => /^(\d+)\t(.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ size_b: Number(match[1]), path: match[2] ?? '' }))
      .filter((entry) => entry.path !== '' && entry.path !== path.data)
      .sort((a, b) => b.size_b - a.size_b);
    const entries = all.slice(0, input.limit);
    return ok(toolData(entries, { total: all.length }));
  },
});
