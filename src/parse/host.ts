export interface OsRelease {
  id: string;
  name: string;
  prettyName: string;
  versionId?: string;
}

export interface MemInfo {
  totalB: number;
  availB: number;
  swapTotalB: number;
  swapFreeB: number;
}

export interface CpuInfo {
  cores?: number;
  model?: string;
}

/** key=value lines from /etc/os-release, values optionally quoted. */
export function parseOsRelease(text: string): OsRelease {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    values.set(key, unquote(trimmed.slice(eq + 1)));
  }
  const release: OsRelease = {
    id: values.get('ID') ?? '',
    name: values.get('NAME') ?? '',
    prettyName: values.get('PRETTY_NAME') ?? values.get('NAME') ?? '',
  };
  const versionId = values.get('VERSION_ID');
  if (versionId !== undefined && versionId !== '') release.versionId = versionId;
  return release;
}

/** /proc/meminfo: values are kB. Convert to bytes here, once. */
export function parseMeminfo(text: string): MemInfo {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_()0-9]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    values.set(key, Number(raw));
  }
  const kb = (name: string): number => (values.get(name) ?? 0) * 1024;
  return {
    totalB: kb('MemTotal'),
    availB: kb('MemAvailable'),
    swapTotalB: kb('SwapTotal'),
    swapFreeB: kb('SwapFree'),
  };
}

/** First field of /proc/uptime is seconds as a float. */
export function parseUptimeSeconds(text: string): number {
  const first = text.trim().split(/\s+/)[0];
  if (first === undefined) return 0;
  const seconds = Number(first);
  return Number.isFinite(seconds) ? Math.floor(seconds) : 0;
}

/** `lscpu -J` is a flat list of {field, data} entries (children tolerated). */
export function parseLscpuJson(text: string): CpuInfo {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!isLscpuDocument(parsed)) return {};

  const info: CpuInfo = {};
  for (const entry of parsed.lscpu) {
    if (typeof entry.field !== 'string') continue;
    const field = entry.field.replace(/:$/, '').trim();
    if (field === 'CPU(s)' && typeof entry.data === 'string') {
      const cores = Number(entry.data);
      if (Number.isInteger(cores) && cores > 0) info.cores = cores;
    }
    if (field === 'Model name' && typeof entry.data === 'string') {
      info.model = entry.data.trim();
    }
  }
  return info;
}

function isLscpuDocument(value: unknown): value is { lscpu: Array<{ field?: unknown; data?: unknown }> } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { lscpu?: unknown };
  if (!Array.isArray(record.lscpu)) return false;
  return record.lscpu.every(
    (entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

/**
 * Max plausible thermal reading in Celsius. ACPI often reports 127 °C as a
 * sentinel ("unknown"), so anything at or above 120 is discarded.
 */
export function parseThermalMax(text: string, maxC = 120): number | null {
  const values = text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((milli) => Number.isFinite(milli) && milli > 0 && milli < maxC * 1000)
    .map((milli) => Math.round(milli / 1000));
  return values.length > 0 ? Math.max(...values) : null;
}