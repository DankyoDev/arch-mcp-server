import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.js';

const MAX_BYTES = 5 * 1024 * 1024;
/** Never persist secrets or file contents in the audit trail. */
const SECRET_KEY = /pass|token|key|secret|content|stdout|stderr/i;

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  mode: string;
  decision: 'allow' | 'deny' | 'confirm' | 'preview';
  confirmed: boolean;
  ms: number;
  exit: string;
}

let warned = false;

/** Append one JSONL line, redacting secrets. Never throws into a tool path. */
export function audit(config: Config, entry: AuditEntry): void {
  if (!config.audit) return;
  try {
    mkdirSync(dirname(config.auditPath), { recursive: true });
    rotate(config.auditPath);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: redact(entry.args),
      mode: entry.mode,
      decision: entry.decision,
      confirmed: entry.confirmed,
      ms: entry.ms,
      exit: entry.exit,
    });
    appendFileSync(config.auditPath, `${line}\n`, 'utf8');
  } catch (error) {
    if (!warned) {
      warned = true;
      process.stderr.write(
        `arch-mcp: audit disabled (${error instanceof Error ? error.message : 'cannot write'})\n`,
      );
    }
  }
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item);
  }
  return result;
}

function rotate(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size < MAX_BYTES) return;
  renameSync(path, `${path}.1`);
  for (let index = 2; index >= 1; index -= 1) {
    const from = `${path}.${index}`;
    if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
  }
}
