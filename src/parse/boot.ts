export interface BootPhases {
  firmware_ms?: number;
  loader_ms?: number;
  kernel_ms?: number;
  userspace_ms?: number;
  total_ms?: number;
}

/** `systemd-analyze`: optional per-phase durations and the total after "=". */
export function parseSystemdAnalyze(text: string): BootPhases {
  const phases: BootPhases = {};
  const segment = /(?:(\d+)min\s*)?([\d.]+)s\s*\((firmware|loader|kernel|userspace)\)/g;
  for (const match of text.matchAll(segment)) {
    const minutes = Number(match[1] ?? 0);
    const seconds = Number(match[2]);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
    const ms = Math.round((minutes * 60 + seconds) * 1000);
    const phase = match[3];
    if (phase === 'firmware') phases.firmware_ms = ms;
    else if (phase === 'loader') phases.loader_ms = ms;
    else if (phase === 'kernel') phases.kernel_ms = ms;
    else if (phase === 'userspace') phases.userspace_ms = ms;
  }
  const total = /=\s*(?:(\d+)min\s*)?([\d.]+)s!?/.exec(text);
  if (total !== null) {
    const minutes = Number(total[1] ?? 0);
    const seconds = Number(total[2]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      phases.total_ms = Math.round((minutes * 60 + seconds) * 1000);
    }
  } else {
    const sum =
      (phases.firmware_ms ?? 0) +
      (phases.loader_ms ?? 0) +
      (phases.kernel_ms ?? 0) +
      (phases.userspace_ms ?? 0);
    if (sum > 0) phases.total_ms = sum;
  }
  return phases;
}

export interface BlameEntry {
  unit: string;
  ms: number;
}

/** `systemd-analyze blame`: "1.234s unit.service". */
export function parseBlame(text: string, limit: number): BlameEntry[] {
  const entries: BlameEntry[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:(\d+)min\s*)?([\d.]+)(ms|s)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const minutes = Number(match[1] ?? 0);
    const amount = Number(match[2]);
    const unit = match[4];
    if (!Number.isFinite(minutes) || !Number.isFinite(amount) || unit === undefined) continue;
    const ms = match[3] === 'ms' ? Math.round(amount) : Math.round((minutes * 60 + amount) * 1000);
    entries.push({ unit, ms });
  }
  entries.sort((a, b) => b.ms - a.ms);
  return entries.slice(0, limit);
}

/** `pacman -Q ...`: "linux 7.0.14.arch1-1". */
export function parsePackageVersions(text: string): Array<{ name: string; version: string }> {
  const packages: Array<{ name: string; version: string }> = [];
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s*$/.exec(line.trim());
    if (match === null) continue;
    const [, name, version] = match;
    if (name === undefined || version === undefined) continue;
    packages.push({ name, version });
  }
  return packages;
}

/** `bootctl status` text: loader name and EFI presence. */
export function parseBootctl(text: string): { efi: boolean; bootloader?: string } {
  if (/Not booted with EFI/i.test(text)) return { efi: false };
  const loader = /^\s*(?:Current Boot Loader|Loader):\s*(.+)$/im.exec(text);
  const efi = /EFI variables are not supported|Not booted with EFI/i.test(text)
    ? false
    : /System:\s*\n?\s*Firmware/i.test(text) || /Boot Loader/i.test(text);
  const result: { efi: boolean; bootloader?: string } = { efi };
  if (loader?.[1] !== undefined) result.bootloader = loader[1].trim();
  return result;
}
