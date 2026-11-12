import { isoFromUs } from '../core/format.js';

export interface SystemdUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export interface SystemdTimer {
  unit: string;
  next?: string;
  last?: string;
  activates?: string;
}

/** `systemctl list-units --output=json` (fields we keep only). */
export function parseUnitsJson(text: string): SystemdUnit[] {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const units: SystemdUnit[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const unit = asString(record.unit);
    if (unit === undefined) continue;
    units.push({
      unit,
      load: asString(record.load) ?? '',
      active: asString(record.active) ?? '',
      sub: asString(record.sub) ?? '',
      description: asString(record.description) ?? '',
    });
  }
  return units;
}

/** `systemctl show <unit>` key=value output. */
export function parseShowProperties(text: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    properties[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return properties;
}

/** `systemctl show <unit1> <unit2>` separates unit blocks with a blank line. */
export function parseShowBlocks(text: string): Array<Record<string, string>> {
  const blocks: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (Object.keys(current).length > 0) {
        blocks.push(current);
        current = {};
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    current[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  if (Object.keys(current).length > 0) blocks.push(current);
  return blocks;
}

/** `systemctl list-timers --output=json`; times are microseconds. */
export function parseTimersJson(text: string): SystemdTimer[] {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const timers: SystemdTimer[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const unit = asString(record.unit);
    if (unit === undefined) continue;
    const timer: SystemdTimer = { unit };
    const next = isoFromUs(typeof record.next === 'number' ? record.next : '');
    const last = isoFromUs(typeof record.last === 'number' ? record.last : '');
    if (next !== undefined) timer.next = next;
    if (last !== undefined) timer.last = last;
    const activates = asString(record.activates);
    if (activates !== undefined && activates !== '') timer.activates = activates;
    timers.push(timer);
  }
  return timers;
}

export interface FailedUnitDetail {
  unit: string;
  since?: string;
  exit?: string;
}

/** Extract the useful fields of one failed unit's `systemctl show` block. */
export function failedDetailFromBlock(block: Record<string, string>): FailedUnitDetail | null {
  const unit = block.Id ?? block.Unit ?? block.Names;
  if (unit === undefined || unit === '') return null;
  const detail: FailedUnitDetail = { unit };
  const since = block.StateChangeTimestamp ?? block.InactiveEnterTimestamp;
  if (since !== undefined) {
    const iso = toIso(since);
    if (iso !== undefined) detail.since = iso;
  }
  const status = block.ExecMainStatus;
  const result = block.Result;
  if (status !== undefined || result !== undefined) {
    detail.exit = `${result ?? 'unknown'}/${status ?? '?'}`;
  }
  return detail;
}

function toIso(stamp: string): string | undefined {
  const match = /^\w{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(stamp.trim());
  return match === null ? undefined : `${match[1]}T${match[2]}Z`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
