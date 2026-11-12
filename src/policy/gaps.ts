import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import { hostLabel } from '../config.js';

const MAX_BYTES = 5 * 1024 * 1024;
const SECRET_FLAG = /^(-p|--password|--pass|--token|--secret|--api-key|--apikey)$/i;
const SECRET_ASSIGN = /^-{0,2}[A-Za-z0-9_-]*(pass|password|token|secret|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*=/i;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i;

export interface GapEntry {
  ts: string;
  host: string;
  binary: string;
  argv: string[];
  exit: number;
  ms: number;
  stdout_b: number;
  native: boolean;
  reason: string;
  /** Binaries the script called, when the fallback was script_run. */
  commands?: string[];
}

export interface GapSummary {
  binary: string;
  count: number;
  first: string;
  last: string;
  hosts: string[];
  reasons: string[];
  examples: string[][];
  /** `script_run` when the binary was detected inside an inline script. */
  via?: string;
}

/** Record a fallback command locally and, if configured, on the central collector. */
export function recordGap(config: Config, entry: Omit<GapEntry, 'ts' | 'host'>): void {
  const full: GapEntry = {
    ts: new Date().toISOString(),
    host: hostLabel(config),
    ...entry,
    argv: redactArgv(entry.argv),
  };
  appendLocal(config.gapLog, full);
  void sendRemote(config, full);
}

/** Read the local gap log; malformed lines are ignored. */
export function readGaps(config: Config): GapEntry[] {
  if (!existsSync(config.gapLog)) return [];
  const entries: GapEntry[] = [];
  for (const line of readFileSync(config.gapLog, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as GapEntry;
      if (typeof parsed.binary === 'string' && parsed.binary !== '') entries.push(parsed);
    } catch {
      // A truncated line (process killed mid-write) must not break the tool.
    }
  }
  return entries;
}

export function summarizeGaps(entries: readonly GapEntry[], limit = 50): GapSummary[] {
  const groups = new Map<string, GapSummary & { hostSet: Set<string>; reasonSet: Set<string> }>();
  for (const entry of entries) {
    // A script hides the binaries it calls; expand them so the promotion rule
    // (ADR-021) sees "docker" instead of a single "script:bash" bucket.
    const rows: Array<{ binary: string; via?: string }> =
      entry.commands !== undefined && entry.commands.length > 0
        ? entry.commands.map((command) => ({ binary: command, via: 'script_run' }))
        : [{ binary: entry.binary }];
    for (const row of rows) {
      const key = `${row.via ?? ''}|${row.binary}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        const summary: GapSummary & { hostSet: Set<string>; reasonSet: Set<string> } = {
          binary: row.binary,
          count: 1,
          first: entry.ts,
          last: entry.ts,
          hosts: [entry.host],
          reasons: [entry.reason],
          examples: [entry.argv],
          hostSet: new Set([entry.host]),
          reasonSet: new Set([entry.reason]),
        };
        if (row.via !== undefined) summary.via = row.via;
        groups.set(key, summary);
        continue;
      }
      existing.count += 1;
      if (entry.ts < existing.first) existing.first = entry.ts;
      if (entry.ts > existing.last) existing.last = entry.ts;
      if (!existing.hostSet.has(entry.host)) {
        existing.hostSet.add(entry.host);
        existing.hosts.push(entry.host);
      }
      if (!existing.reasonSet.has(entry.reason)) {
        existing.reasonSet.add(entry.reason);
        existing.reasons.push(entry.reason);
      }
      if (existing.examples.length < 3 && !existing.examples.some((example) => sameArgv(example, entry.argv))) {
        existing.examples.push(entry.argv);
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, limit)
    .map(({ hostSet: _hosts, reasonSet: _reasons, ...summary }) => summary);
}

export function redactArgv(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  let hideNext = false;
  for (const arg of argv) {
    if (hideNext) {
      redacted.push('[redacted]');
      hideNext = false;
      continue;
    }
    if (SECRET_FLAG.test(arg)) {
      redacted.push(arg);
      hideNext = true;
      continue;
    }
    if (SECRET_ASSIGN.test(arg)) {
      redacted.push(`${arg.slice(0, arg.indexOf('=') + 1)}[redacted]`);
      continue;
    }
    redacted.push(arg.replace(URL_USERINFO, '$1[redacted]@'));
  }
  return redacted;
}

function appendLocal(path: string, entry: GapEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotate(path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(
      `arch-mcp: gap log disabled (${error instanceof Error ? error.message : 'cannot write'})\n`,
    );
  }
}

async function sendRemote(config: Config, entry: GapEntry): Promise<void> {
  const endpoint = config.gapEndpoint;
  if (endpoint === undefined) return;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.gapToken !== undefined) headers.authorization = `Bearer ${config.gapToken}`;
    await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // The collector is best-effort: never fail a tool because it is down.
  }
}

function rotate(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size < MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
