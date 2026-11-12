import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { err, ok } from '../core/result.js';
import { sanitizeOutput } from '../core/format.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import {
  collapseMounts,
  parseDfInodes,
  parseFindmnt,
  parseFindPrintf,
  parseGrepLines,
  parseNonDirectoryMounts,
  parseRipgrepJson,
  PSEUDO_FSTYPES,
} from '../parse/fs.js';
import { parseSmartctlJson } from '../parse/hw.js';
import { confirmationPayload, consumeConfirmation } from '../policy/confirm.js';
import { defineTool, toolData } from './registry.js';
import { requireFeature, validateAbsolutePath } from './guards.js';
import { isForbiddenWrite, isSensitivePath } from './paths.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MAX_READ_BYTES = 262_144;

export const fsUsageTool = defineTool({
  name: 'fs_usage',
  title: 'Disk usage',
  description:
    'Used space and inode usage per real mount. Pseudo filesystems are excluded unless include_pseudo is set.',
  schema: z.object({
    include_pseudo: z.boolean().default(false).describe('Keep proc, tmpfs, cgroup and similar mounts'),
  }),
  annotations: READ,
  profiles: ['core', 'readonly', 'full'],
  handler: async (input, ctx) => {
    const batch = await runSections(
      ctx.conn,
      [
        {
          key: 'mounts',
          argv: ['findmnt', '-J', '-b', '--output', 'TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%'],
        },
        { key: 'inodes', argv: ['df', '-P', '-i', '-B1'] },
        {
          key: 'nondirs',
          argv: [
            'sh',
            '-c',
            'findmnt -rn -o TARGET | while read -r t; do [ -d "$t" ] || printf "%s\\n" "$t"; done',
          ],
        },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!batch.ok) return batch;

    const mounts = parseFindmnt(batch.data.mounts?.stdout ?? '');
    const inodes = parseDfInodes(batch.data.inodes?.stdout ?? '');
    const nonDirs = parseNonDirectoryMounts(batch.data.nondirs?.stdout ?? '');

    const rows = collapseMounts(
      mounts
        .filter((mount) => input.include_pseudo || !PSEUDO_FSTYPES.has(mount.fstype))
        .filter((mount) => mount.sizeB > 0 && !nonDirs.has(mount.target)),
    )
      .map((mount) => ({
        mount: mount.target,
        fstype: mount.fstype,
        size_b: mount.sizeB,
        used_b: mount.usedB,
        use_pct: mount.usePct,
        ...(inodes.has(mount.target) ? { inodes_pct: inodes.get(mount.target) } : {}),
      }))
      .sort((a, b) => a.mount.localeCompare(b.mount));

    return ok(toolData(rows.slice(0, 100), { total: rows.length }));
  },
});

export const fsLsTool = defineTool({
  name: 'fs_ls',
  title: 'List a directory',
  description:
    'Entries of one directory with type, size and mtime. Use it before reading or searching inside a path.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute directory path'),
    hidden: z.boolean().default(false).describe('Include dotfiles'),
    sort: z.enum(['name', 'size', 'mtime']).default('name').describe('Sort field'),
    limit: z.number().int().min(1).max(200).default(50).describe('Entries per page'),
    cursor: z.string().max(64).optional().describe('Cursor from a previous call'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const path = validateAbsolutePath(input.path);
    if (!path.ok) return path;
    const offset = decodeCursor(input.cursor);
    if (!offset.ok) return offset;

    const result = await runCommand(
      ctx.conn,
      ['find', path.data, '-maxdepth', '1', '-mindepth', '1', '-printf', '%f\t%s\t%T@\t%y\n'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: MAX_READ_BYTES },
    );
    if (!result.ok) return result;
    if (result.data.code !== 0) {
      return err('E_NOTFOUND', `cannot list ${path.data}`, result.data.stderr.trim() || 'check the path');
    }

    let entries = parseFindPrintf(result.data.stdout);
    if (!input.hidden) entries = entries.filter((entry) => !entry.name.startsWith('.'));
    entries.sort((a, b) => {
      if (input.sort === 'size') return b.sizeB - a.sizeB || a.name.localeCompare(b.name);
      if (input.sort === 'mtime') return b.mtime.localeCompare(a.mtime) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });

    const total = entries.length;
    const page = entries.slice(offset.data, offset.data + input.limit);
    const next = offset.data + page.length < total ? encodeCursor(offset.data + page.length) : null;

    return ok(
      toolData(
        page.map((entry) => ({
          name: entry.name,
          type: entry.type,
          size_b: entry.sizeB,
          mtime: entry.mtime,
        })),
        { total, cursor: next },
      ),
    );
  },
});

export const fsFindTool = defineTool({
  name: 'fs_find',
  title: 'Find files',
  description:
    'Find files under a path by name, minimum size or age. Filters run on the host and results are sorted by mtime.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute start path'),
    name: z.string().max(200).optional().describe('Shell glob like *.conf'),
    min_size: z.number().int().min(0).max(1_099_511_627_776).optional().describe('Minimum size in bytes'),
    mtime_days: z.number().int().min(1).max(3650).optional().describe('Modified within this many days'),
    limit: z.number().int().min(1).max(100).default(20).describe('Results per page'),
    cursor: z.string().max(64).optional().describe('Cursor from a previous call'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const path = validateAbsolutePath(input.path);
    if (!path.ok) return path;
    const offset = decodeCursor(input.cursor);
    if (!offset.ok) return offset;
    if (input.name !== undefined && input.name.startsWith('-')) {
      return err('E_POLICY', 'name pattern must not start with a dash', 'use fe*.conf instead of -x');
    }

    const argv = ['find', path.data, '-maxdepth', '6', '-type', 'f'];
    if (input.name !== undefined && input.name !== '') argv.push('-name', input.name);
    argv.push('-printf', '%p\t%s\t%T@\n');

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: MAX_READ_BYTES,
    });
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'find produced too many entries', 'narrow the path or add name');
    }

    let entries = parseFindPrintf(result.data.stdout);
    const minSize = input.min_size;
    if (minSize !== undefined) entries = entries.filter((entry) => entry.sizeB >= minSize);
    if (input.mtime_days !== undefined) {
      const cutoff = new Date(Date.now() - input.mtime_days * 86_400_000).toISOString();
      entries = entries.filter((entry) => entry.mtime >= cutoff);
    }
    entries.sort((a, b) => b.mtime.localeCompare(a.mtime));

    const total = entries.length;
    const page = entries.slice(offset.data, offset.data + input.limit);
    const next = offset.data + page.length < total ? encodeCursor(offset.data + page.length) : null;

    return ok(
      toolData(
        page.map((entry) => ({ path: entry.path, size_b: entry.sizeB, mtime: entry.mtime })),
        { total, cursor: next },
      ),
    );
  },
});

export const fsGrepTool = defineTool({
  name: 'fs_grep',
  title: 'Search file contents',
  description:
    'Search text under one directory with ripgrep when available and grep otherwise. Returns path, line and a trimmed text line; filters by glob and case.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute directory or file'),
    pattern: z.string().min(1).max(500).describe('Text or regex to find'),
    glob: z.string().max(200).optional().describe('Only files matching this glob'),
    fixed: z.boolean().default(false).describe('Treat pattern as literal text'),
    ignore_case: z.boolean().default(false).describe('Case-insensitive search'),
    hidden: z.boolean().default(false).describe('Include hidden files and directories'),
    max_results: z.number().int().min(1).max(200).default(50).describe('Matches to return'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const path = validateAbsolutePath(input.path);
    if (!path.ok) return path;

    const capabilities = await ctx.capabilities();
    const useRg = capabilities.ok && capabilities.data.tools.rg !== undefined;
    const argv = useRg
      ? ['rg', '--json', '--no-heading', '--color', 'never', '--max-count', '5']
      : ['grep', '-r', '-n', '-I', '-m', '5', '--color=never'];
    if (input.fixed) argv.push(useRg ? '--fixed-strings' : '-F');
    if (input.ignore_case) argv.push('-i');
    if (input.hidden && useRg) argv.push('--hidden');
    if (!input.hidden && !useRg) argv.push('--exclude-dir=.*');
    if (input.glob !== undefined && input.glob !== '') argv.push(useRg ? '-g' : '--include', input.glob);
    argv.push('--', input.pattern, path.data);

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: MAX_READ_BYTES,
    });
    if (!result.ok) return result;
    if (result.data.truncated) {
      return err('E_TRUNCATED', 'grep output exceeded the read cap', 'narrow the glob or pattern');
    }
    if (result.data.code !== 0 && result.data.code !== 1) {
      return err(
        'E_INTERNAL',
        `${useRg ? 'rg' : 'grep'} failed`,
        result.data.stderr.trim().split('\n')[0] || 'check the path and pattern',
      );
    }

    const matches = useRg ? parseRipgrepJson(result.data.stdout) : parseGrepLines(result.data.stdout);
    const visible = matches.slice(0, input.max_results).map((match) => ({
      path: match.path,
      line: match.line,
      text: sanitizeOutput(match.text).slice(0, 300),
    }));
    return ok(toolData({ total: matches.length, matches: visible }));
  },
});

export const fsReadTool = defineTool({
  name: 'fs_read',
  title: 'Read a text file',
  description:
    'Read a slice of a text file by line range. Refuses binaries and credential stores; returns total_lines so you can page.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute file path'),
    offset: z.number().int().min(0).max(1_000_000).default(0).describe('Lines to skip'),
    lines: z.number().int().min(1).max(500).default(100).describe('Lines to return'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const path = validateAbsolutePath(input.path);
    if (!path.ok) return path;
    if (isSensitivePath(path.data)) {
      return err('E_POLICY', 'refusing to read a credential store', 'use a dedicated tool or read it manually');
    }

    const start = input.offset + 1;
    const end = input.offset + input.lines;
    const batch = await runSections(
      ctx.conn,
      [
        { key: 'head', argv: ['head', '-c', '512', path.data] },
        { key: 'count', argv: ['wc', '-l', path.data] },
        { key: 'slice', argv: ['sed', '-n', `${start},${end}p`, path.data] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: MAX_READ_BYTES },
    );
    if (!batch.ok) return batch;

    const head = batch.data.head;
    if (head === undefined || head.code !== 0) {
      return err('E_NOTFOUND', `cannot read ${path.data}`, 'check the path and permissions');
    }
    if (head.stdout.includes('\0')) {
      return err('E_UNSUPPORTED', 'file looks binary', 'use fs_find/fs_ls or read it on the host');
    }

    const totalLines = Number((batch.data.count?.stdout ?? '').split(/\s+/)[0]);
    const content = sanitizeOutput(batch.data.slice?.stdout ?? '');
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();

    return ok(
      toolData({
        path: path.data,
        lines,
        total_lines: Number.isFinite(totalLines) ? totalLines : 0,
        truncated: batch.data.slice?.code !== 0 || (batch.data.slice?.stdout ?? '').length >= MAX_READ_BYTES,
      }),
    );
  },
});

export { isSensitivePath } from './paths.js';

export const fsWriteTool = defineTool({
  name: 'fs_write',
  title: 'Write a file',
  description:
    'Write a text file after two-step confirmation. Refuses /etc, /boot, /usr and ~/.ssh; content goes over stdin, never through the shell.',
  schema: z.object({
    path: z.string().min(1).max(4096).describe('Absolute file path'),
    content: z.string().max(32_768).describe('File content (max 32 KiB)'),
    mode: z.string().regex(/^[0-7]{3,4}$/, 'expected an octal mode like 644').optional().describe('chmod mode'),
    dry_run: z.boolean().default(false).describe('Validate and preview without writing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = validateAbsolutePath(input.path);
    if (!path.ok) return path;
    if (isForbiddenWrite(path.data)) {
      return err('E_POLICY', 'refusing to write system or credential paths', 'edit them by hand on the host');
    }
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (input.dry_run) {
      return ok(
        toolData({
          path: path.data,
          bytes,
          mode: input.mode,
          result: 'dry_run',
          ...confirmationPayload('fs_write', input, ctx.config.confirmTtl),
        }),
      );
    }
    if (input.token === undefined) {
      return ok(
        toolData(
          confirmationPayload('fs_write', input, ctx.config.confirmTtl, {
            path: path.data,
            bytes,
            mode: input.mode ?? null,
            effect: 'overwrites the file',
          }),
        ),
      );
    }
    const consumed = consumeConfirmation(input.token, 'fs_write', input);
    if (!consumed.ok) return consumed;

    const written = await runCommand(ctx.conn, ['sh', '-c', 'cat > "$1"', '_', path.data], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
      input: input.content,
    });
    if (!written.ok) return written;
    if (written.data.code !== 0) {
      return err('E_PERM', `cannot write ${path.data}`, written.data.stderr.trim() || 'check the directory');
    }
    if (input.mode !== undefined) {
      const chmod = await runCommand(ctx.conn, ['chmod', input.mode, path.data], {
        timeoutMs: ctx.config.timeoutMs,
      });
      if (!chmod.ok) return chmod;
      if (chmod.data.code !== 0) {
        return err('E_PERM', `wrote ${path.data} but chmod failed`, chmod.data.stderr.trim());
      }
    }
    return ok(toolData({ path: path.data, bytes, mode: input.mode }));
  },
});

const DEVICE_PATTERN = /^\/dev\/[A-Za-z0-9/_.-]{1,100}$/;

export const fsSmartTool = defineTool({
  name: 'fs_smart',
  title: 'Disk health',
  description:
    'SMART health, temperature and power-on hours of a disk via smartctl. Requires root and smartmontools.',
  schema: z.object({
    device: z.string().max(120).regex(DEVICE_PATTERN, 'expected /dev/<device>').describe('Block device'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'smartctl', 'install smartmontools');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['smartctl', '-j', '-H', '-A', input.device], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;
    if (result.data.stdout.trim() === '') {
      return err('E_PERM', `smartctl could not read ${input.device}`, result.data.stderr.trim() || 'requires root');
    }
    const health = parseSmartctlJson(result.data.stdout, input.device);
    if (health.health === 'unknown') {
      return err(
        'E_UNSUPPORTED',
        `SMART data unavailable for ${input.device}`,
        health.error ?? 'the device may be virtual or not expose SMART attributes',
      );
    }
    return ok(toolData(health));
  },
});

export const fsMountsTool = defineTool({
  name: 'fs_mounts',
  title: 'Mount table',
  description:
    'Mounts with source, filesystem type and options, optionally filtered by fstype. Use it when you need the raw mount table.',
  schema: z.object({
    fstype: z.string().max(32).optional().describe('Only this filesystem type'),
    limit: z.number().int().min(1).max(200).default(100).describe('Mounts per page'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const result = await runCommand(
      ctx.conn,
      ['findmnt', '-J', '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS'],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!result.ok) return result;

    let mounts = parseFindmnt(result.data.stdout);
    if (input.fstype !== undefined && input.fstype !== '') {
      mounts = mounts.filter((mount) => mount.fstype === input.fstype);
    }
    mounts.sort((a, b) => a.target.localeCompare(b.target));
    return ok(
      toolData(
        mounts.slice(0, input.limit).map((mount) => ({
          target: mount.target,
          source: mount.source,
          fstype: mount.fstype,
          options:
            mount.options !== undefined && mount.options.length > 120
              ? `${mount.options.slice(0, 120)}...`
              : mount.options,
        })),
        { total: mounts.length },
      ),
    );
  },
});
