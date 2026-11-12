export interface PackageUpdate {
  name: string;
  from: string;
  to: string;
}

export interface PackageSearchResult {
  name: string;
  version: string;
  repo: string;
  desc: string;
}

/** `pacman -Qu`: "pkg old -> new" one per line. */
export function parsePacmanQu(text: string): PackageUpdate[] {
  const updates: PackageUpdate[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line.trim());
    if (match === null) continue;
    const [, name, from, to] = match;
    if (name === undefined || from === undefined || to === undefined) continue;
    updates.push({ name, from, to });
  }
  return updates;
}

/** `pacman -Qi` / `-Si`: "Key : value" lines. */
export function parsePacmanInfo(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9 ()/-]*?)\s+:\s(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key !== undefined && value !== undefined) fields[key] = value;
  }
  return fields;
}

/** `pacman -Ss`: "repo/name version" followed by an indented description. */
export function parsePacmanSs(text: string): PackageSearchResult[] {
  const results: PackageSearchResult[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^(\S+)\/(\S+)\s+(\S+)(?:\s+\[.*\])?\s*$/.exec(lines[index]?.trim() ?? '');
    if (header === null) continue;
    const [, repo, name, version] = header;
    if (repo === undefined || name === undefined || version === undefined) continue;
    let desc = '';
    const rawNext = lines[index + 1] ?? '';
    if (/^\s{2,}\S/.test(rawNext)) desc = rawNext.trim();
    results.push({ name, version, repo, desc });
  }
  return results;
}

/** `pacman -Qo <path>`: "/usr/bin/bash is owned by bash 5.3.20-1". */
export function parsePacmanQo(text: string): { package: string; version: string } | null {
  const match = /is owned by (\S+) (\S+)/.exec(text);
  if (match === null) return null;
  const [, name, version] = match;
  if (name === undefined || version === undefined) return null;
  return { package: name, version };
}

const UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

/** "4.52 MiB" -> bytes. Returns 0 for "None" or unknown formats. */
export function parseHumanSize(value: string): number {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(value.trim());
  if (match === null) return 0;
  const amount = Number(match[1]);
  const unit = (match[2] ?? '').toUpperCase();
  const factor = UNITS[unit];
  if (!Number.isFinite(amount) || factor === undefined) return 0;
  return Math.round(amount * factor);
}

export function splitList(value: string | undefined): string[] {
  if (value === undefined || value === '' || value === 'None') return [];
  return value
    .split(/\s{2,}|\s+/)
    .map((item) => item.trim())
    .filter((item) => item !== '' && item !== 'None');
}
