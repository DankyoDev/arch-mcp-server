export interface DiskUsage {
  filesystem: string;
  sizeB: number;
  usedB: number;
  availB: number;
  usePct: number;
  mount: string;
}

const PSEUDO_MOUNTS = [
  '/dev',
  '/dev/shm',
  '/run',
  '/run/lock',
  '/run/user',
  '/sys',
  '/proc',
  '/sys/fs/cgroup',
];

/** Single files that Docker/WSL bind-mount; never storage worth reporting. */
const FILE_MOUNTS = new Set(['/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/etc/localtime']);

/** Filesystems we report even though their source is not a device path. */
const VIRTUAL_REAL_FS = new Set(['overlay', 'zfs', 'btrfs']);

/** `df -P -B1` columns: fs, 1-blocks, used, available, capacity%, mount. */
export function parseDf(text: string): DiskUsage[] {
  const rows: DiskUsage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('Filesystem')) continue;
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(trimmed);
    if (match === null) continue;
    const [, filesystem, size, used, avail, pct, mount] = match;
    if (filesystem === undefined || mount === undefined) continue;
    rows.push({
      filesystem,
      sizeB: Number(size ?? 0),
      usedB: Number(used ?? 0),
      availB: Number(avail ?? 0),
      usePct: Number(pct ?? 0),
      mount: mount.trim(),
    });
  }
  return rows;
}

/** Keep real filesystems: drop pseudo mounts and collapse bind mounts per device. */
export function realMounts(rows: readonly DiskUsage[]): DiskUsage[] {
  const byFilesystem = new Map<string, DiskUsage>();
  for (const row of rows) {
    if (row.sizeB === 0) continue;
    if (PSEUDO_MOUNTS.some((prefix) => row.mount === prefix || row.mount.startsWith(`${prefix}/`))) {
      continue;
    }
    if (row.filesystem === 'tmpfs' || row.filesystem === 'devtmpfs' || row.filesystem === 'shm') {
      continue;
    }
    if (!row.filesystem.startsWith('/') && !VIRTUAL_REAL_FS.has(row.filesystem)) continue;
    if (FILE_MOUNTS.has(row.mount)) continue;
    // Docker's overlay layers are mounted under the data-root and are never
    // host storage. Keep an overlay only when it is the root filesystem.
    if (row.filesystem === 'overlay' && row.mount !== '/') continue;
    // Docker bind mounts and btrfs subvolumes repeat the same device: keep the
    // shortest mount point (normally the real one) so the snapshot stays small.
    const existing = byFilesystem.get(row.filesystem);
    if (existing === undefined || row.mount.length < existing.mount.length) {
      byFilesystem.set(row.filesystem, row);
    }
  }
  return [...byFilesystem.values()];
}
