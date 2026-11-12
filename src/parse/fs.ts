export interface MountUsage {
  target: string;
  source: string;
  fstype: string;
  sizeB: number;
  usedB: number;
  availB: number;
  usePct: number;
  options?: string;
}

/** Filesystems that are noise for a storage question. */
export const PSEUDO_FSTYPES = new Set([
  'proc',
  'sysfs',
  'devtmpfs',
  'devpts',
  'tmpfs',
  'cgroup',
  'cgroup2',
  'pstore',
  'bpf',
  'debugfs',
  'tracefs',
  'securityfs',
  'configfs',
  'fusectl',
  'mqueue',
  'hugetlbfs',
  'autofs',
  'squashfs',
  'ramfs',
  'efivarfs',
  'binfmt_misc',
  'fuse.lxcfs',
  'nsfs',
]);

interface FindmntNode {
  target?: unknown;
  source?: unknown;
  fstype?: unknown;
  size?: unknown;
  used?: unknown;
  avail?: unknown;
  'use%'?: unknown;
  options?: unknown;
  children?: unknown;
}

/** `findmnt -J -b`: nested filesystems, flatten to a list of mounts. */
export function parseFindmnt(text: string): MountUsage[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const filesystems = (parsed as { filesystems?: unknown }).filesystems;
  if (!Array.isArray(filesystems)) return [];

  const mounts: MountUsage[] = [];
  for (const node of filesystems) walk(node, mounts);
  return mounts;
}

/** `find -printf '%f\t%s\t%T@\t%y\n'` rows. */
export interface FsEntry {
  path: string;
  name: string;
  sizeB: number;
  mtime: string;
  type: 'file' | 'dir' | 'link' | 'other';
}

export function parseFindPrintf(text: string): FsEntry[] {
  const entries: FsEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const path = parts[0];
    const size = parts[1];
    const mtime = parts[2];
    const kind = parts[3] ?? 'f';
    if (path === undefined || size === undefined || mtime === undefined) continue;
    const seconds = Number(mtime);
    if (!Number.isFinite(seconds)) continue;
    const segments = path.split('/');
    entries.push({
      path,
      name: segments[segments.length - 1] ?? path,
      sizeB: Number(size) || 0,
      mtime: new Date(Math.round(seconds * 1000)).toISOString(),
      type: kind === 'd' ? 'dir' : kind === 'l' ? 'link' : kind === 'f' ? 'file' : 'other',
    });
  }
  return entries;
}

/** `df -P -i -B1` inode usage keyed by mount point. */
export function parseDfInodes(text: string): Map<string, number> {
  const usage = new Map<string, number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('Filesystem')) continue;
    const match = /^(\S+)\s+\d+\s+\d+\s+\d+\s+(\d+)%\s+(.+)$/.exec(trimmed);
    if (match === null) continue;
    const pct = Number(match[2]);
    const mount = match[3]?.trim();
    if (mount === undefined || !Number.isInteger(pct)) continue;
    usage.set(mount, pct);
  }
  return usage;
}

/** Mount targets that are single files (Docker/WSL bind mounts). */
export function parseNonDirectoryMounts(text: string): Set<string> {
  const targets = new Set<string>();
  for (const line of text.split('\n')) {
    const target = line.trim();
    if (target.startsWith('/')) targets.add(target);
  }
  return targets;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** `rg --json` match events; other event types are ignored. */
export function parseRipgrepJson(text: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = parsed as { type?: unknown; data?: unknown };
    if (event.type !== 'match' || typeof event.data !== 'object' || event.data === null) continue;
    const data = event.data as {
      path?: { text?: unknown };
      line_number?: unknown;
      lines?: { text?: unknown };
    };
    const path = typeof data.path?.text === 'string' ? data.path.text : undefined;
    const lineNumber = Number(data.line_number);
    const body = typeof data.lines?.text === 'string' ? data.lines.text : undefined;
    if (path === undefined || body === undefined || !Number.isInteger(lineNumber)) continue;
    matches.push({ path, line: lineNumber, text: body.replace(/\r?\n$/, '') });
  }
  return matches;
}

/** `grep -rn` output: path:line:text. */
export function parseGrepLines(text: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of text.split('\n')) {
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    if (match === null) continue;
    const path = match[1];
    const lineNumber = Number(match[2]);
    const body = match[3];
    if (path === undefined || body === undefined || !Number.isInteger(lineNumber)) continue;
    matches.push({ path, line: lineNumber, text: body });
  }
  return matches;
}

/** Collapse bind mounts of the same device, keeping the shortest target. */
export function collapseMounts(rows: readonly MountUsage[]): MountUsage[] {
  const byDevice = new Map<string, MountUsage>();
  for (const row of rows) {
    const key = `${row.source}|${row.sizeB}|${row.usedB}`;
    const existing = byDevice.get(key);
    if (existing === undefined || row.target.length < existing.target.length) {
      byDevice.set(key, row);
    }
  }
  return [...byDevice.values()];
}

function walk(value: unknown, out: MountUsage[]): void {
  if (typeof value !== 'object' || value === null) return;
  const node = value as FindmntNode;
  const target = asString(node.target);
  const fstype = asString(node.fstype);
  if (target !== undefined && fstype !== undefined) {
    const mount: MountUsage = {
      target,
      source: asString(node.source) ?? '',
      fstype,
      sizeB: asNumber(node.size),
      usedB: asNumber(node.used),
      availB: asNumber(node.avail),
      usePct: asNumber(asString(node['use%'])?.replace('%', '')),
    };
    const options = asString(node.options);
    if (options !== undefined) mount.options = options;
    out.push(mount);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, out);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
