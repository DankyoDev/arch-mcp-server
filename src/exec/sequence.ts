import { buildLine } from './quote.js';
import { err, ok } from '../core/result.js';
import { asAppError } from '../connection/errors.js';
import { checkDenylist } from '../policy/denylist.js';
import type { Result } from '../core/types.js';
import type { Connection } from '../connection/types.js';
import { REMOTE_ENV } from './run.js';

const SECTION_MARK = '\u001e';
const CODE_MARK = '\u001f';

export interface SectionSpec {
  key: string;
  argv: readonly string[];
}

export interface SectionOutput {
  stdout: string;
  code: number;
}

/**
 * Run several fixed argv commands in a single SSH round trip. The section list
 * is always static code (never model data): model input only travels inside
 * single-quoted argv elements.
 */
export async function runSections(
  conn: Connection,
  sections: readonly SectionSpec[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Result<Record<string, SectionOutput>>> {
  if (sections.length === 0) return ok({});

  const parts: string[] = [];
  for (const [index, section] of sections.entries()) {
    const denied = checkDenylist(section.argv);
    if (denied !== null) return { ok: false, error: denied };
    parts.push(`printf '\\036${index}\\n'`);
    parts.push(buildLine([...REMOTE_ENV, ...section.argv]));
    parts.push(`printf '\\037%d\\n' "$?"`);
  }

  let raw;
  try {
    raw = await conn.exec(parts.join('; '), opts);
  } catch (error) {
    const appError = asAppError(error);
    if (appError !== null) return { ok: false, error: appError };
    return err(
      'E_INTERNAL',
      error instanceof Error ? error.message : 'connection failed',
      'check the transport and retry',
    );
  }
  if (raw.timedOut) {
    return err('E_TIMEOUT', 'host did not answer in time', 'raise ARCH_MCP_TIMEOUT_MS');
  }
  if (raw.truncated) {
    return err('E_TRUNCATED', 'raw output exceeded the read budget', 'request less data in one call');
  }

  const parsed = parseSections(raw.stdout, sections);
  if (parsed === null) {
    return err('E_PARSE', 'could not split the batched command output', preview(raw.stdout));
  }
  return ok(parsed);
}

function parseSections(
  stdout: string,
  sections: readonly SectionSpec[],
): Record<string, SectionOutput> | null {
  const chunks = stdout.split(SECTION_MARK);
  const result: Record<string, SectionOutput> = {};
  for (const chunk of chunks) {
    if (chunk === '') continue;
    const newline = chunk.indexOf('\n');
    if (newline < 0) continue;
    const index = Number(chunk.slice(0, newline));
    const section = sections[index];
    if (section === undefined) return null;

    const body = chunk.slice(newline + 1);
    const codeAt = body.lastIndexOf(CODE_MARK);
    const text = codeAt >= 0 ? body.slice(0, codeAt) : body;
    const code = codeAt >= 0 ? Number(body.slice(codeAt + 1).trim()) : -1;
    result[section.key] = { stdout: text, code: Number.isFinite(code) ? code : -1 };
  }
  if (Object.keys(result).length !== sections.length) return null;
  return result;
}

function preview(text: string): string {
  return text.slice(0, 200);
}
