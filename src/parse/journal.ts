import { isoFromSystemdStamp, isoFromUs } from '../core/format.js';

export interface JournalEntry {
  ts: string;
  prio: string;
  msg: string;
  unit?: string;
  pid?: number;
  boot?: string;
}

const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] as const;
const MAX_MESSAGE = 500;

/** `journalctl --output=json` yields one JSON object per line. */
export function parseJournalLines(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
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
    const record = parsed as Record<string, unknown>;

    const entry: JournalEntry = {
      ts: isoFromUs(asScalar(record.__REALTIME_TIMESTAMP) ?? 0) ?? new Date(0).toISOString(),
      prio: priorityName(record.PRIORITY),
      msg: messageText(record.MESSAGE),
    };
    const unit = asScalar(record._SYSTEMD_UNIT);
    if (unit !== undefined && unit !== '') entry.unit = unit;
    const pid = Number(asScalar(record._PID));
    if (Number.isInteger(pid) && pid > 0) entry.pid = pid;
    const boot = asScalar(record._BOOT_ID);
    if (boot !== undefined && boot !== '') entry.boot = boot;
    entries.push(entry);
  }
  return entries;
}

export interface BootRecord {
  id: string;
  first: string;
  last: string;
}

/** One `journalctl --list-boots` row: index, 32-hex boot id, first and last stamps. */
const BOOT_LINE = /^\s*(-?\d+)\s+([0-9a-f]{32})\s+(.+?)\s*$/;
const BOOT_STAMP = /[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Z]{2,5}|[+-]\d{2})?/g;

/** `journalctl --list-boots` text output. */
export function parseBoots(text: string): BootRecord[] {
  const boots: BootRecord[] = [];
  for (const line of text.split('\n')) {
    const match = BOOT_LINE.exec(line);
    if (match === null) continue;
    const id = match[2];
    const rest = match[3];
    if (id === undefined || rest === undefined) continue;
    // Real output separates the two dates with a space (and a timezone), the
    // synthetic one used an em dash; extracting stamps handles both.
    const stamps = rest.match(BOOT_STAMP) ?? [];
    const firstRaw = stamps[0];
    const lastRaw = stamps[1];
    if (firstRaw === undefined || lastRaw === undefined) continue;
    boots.push({
      id,
      first: isoFromSystemdStamp(firstRaw) ?? firstRaw.trim(),
      last: isoFromSystemdStamp(lastRaw) ?? lastRaw.trim(),
    });
  }
  return boots;
}

export interface ErrorGroup {
  count: number;
  unit: string;
  msg: string;
  last_ts: string;
}

/** Deduplicate by (unit, msg) and count, newest last_ts wins. */
export function groupErrors(entries: readonly JournalEntry[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const entry of entries) {
    const unit = entry.unit ?? '-';
    const key = `${unit}\u0000${entry.msg}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { count: 1, unit, msg: entry.msg, last_ts: entry.ts });
    } else {
      existing.count += 1;
      if (entry.ts > existing.last_ts) existing.last_ts = entry.ts;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last_ts.localeCompare(a.last_ts));
}

function priorityName(value: unknown): string {
  const text = asScalar(value);
  const index = text === undefined ? Number.NaN : Number(text);
  if (Number.isInteger(index) && index >= 0 && index < PRIORITIES.length) {
    return PRIORITIES[index] ?? 'info';
  }
  return text === undefined || text === '' ? 'info' : text;
}

function messageText(value: unknown): string {
  if (Array.isArray(value)) {
    const bytes = value.filter((item): item is number => typeof item === 'number');
    if (bytes.length === value.length && bytes.length > 0) {
      const decoded = Buffer.from(bytes).toString('utf8');
      const printable = decoded.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      if (printable === '' || printable.includes('\uFFFD')) return '<binary>';
      return printable.slice(0, MAX_MESSAGE);
    }
    return '<binary>';
  }
  const text = asScalar(value) ?? '';
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}...` : text;
}

function asScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
