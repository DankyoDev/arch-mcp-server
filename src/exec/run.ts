import { buildLine } from './quote.js';
import { err, ok } from '../core/result.js';
import { asAppError } from '../connection/errors.js';
import { checkDenylist } from '../policy/denylist.js';
import type { Result } from '../core/types.js';
import type { Connection } from '../connection/types.js';

/** Stable remote environment, always applied (docs/08-conventions.md §6). */
export const REMOTE_ENV = [
  'env',
  'LANG=C',
  'LC_ALL=C',
  'SYSTEMD_COLORS=0',
  'SYSTEMD_PAGER=cat',
] as const;

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ms: number;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
  /** Native docker tools only: lets argv[0] be a container CLI (ADR-025). */
  allowContainers?: boolean;
}

/** Run one argv vector remotely. Callers never pass a command string. */
export async function runCommand(
  conn: Connection,
  argv: readonly string[],
  opts: RunOptions = {},
): Promise<Result<CommandOutput>> {
  let line: string;
  try {
    line = buildLine([...REMOTE_ENV, ...argv]);
  } catch (error) {
    return err('E_INTERNAL', 'invalid command arguments', error instanceof Error ? error.message : undefined);
  }

  const denied = checkDenylist(argv, { allowContainers: opts.allowContainers === true });
  if (denied !== null) return { ok: false, error: denied };

  let raw;
  try {
    raw = await conn.exec(line, { ...opts, argv });
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
    return err(
      'E_TIMEOUT',
      `command timed out after ${opts.timeoutMs ?? 'default'} ms`,
      'raise ARCH_MCP_TIMEOUT_MS or move long work to a job',
    );
  }
  if (
    raw.code !== 0 &&
    /sudo:.*(password is required|not in the sudoers|no tty|a terminal is required)/i.test(raw.stderr)
  ) {
    return err(
      'E_PERM',
      'sudo needs a NOPASSWD rule for this MCP user',
      'add the command to sudoers with NOPASSWD, or run the MCP as root',
    );
  }
  return ok({
    code: raw.code,
    stdout: raw.stdout,
    stderr: raw.stderr,
    truncated: raw.truncated,
    ms: raw.ms,
  });
}
