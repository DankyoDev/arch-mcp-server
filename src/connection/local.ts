import { spawn } from 'node:child_process';
import type { AppError } from '../core/types.js';
import { TransportError } from './errors.js';
import type { ExecOptions, Connection, RawExecResult } from './types.js';

const DEFAULT_MAX_BYTES = 8192;
const STDERR_MAX_BYTES = 2048;

/**
 * Local mode: `sh -c` with the same contract as SSH. Only enabled with
 * ARCH_MCP_LOCAL=1 (ADR-017); the MCP itself is cross-platform but the target
 * must be a POSIX system with /bin/sh.
 */
export class LocalConnection implements Connection {
  readonly kind = 'local' as const;
  #queue: Promise<unknown> = Promise.resolve();

  exec(line: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    const run = this.#queue.then(() => this.#execOnce(line, opts));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    // Nothing persistent to close.
  }

  #execOnce(line: string, opts: ExecOptions): Promise<RawExecResult> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const started = performance.now();

    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', line], {
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (outBytes >= maxBytes) {
          truncated = true;
          return;
        }
        const room = maxBytes - outBytes;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (chunk.length > room) truncated = true;
        out.push(slice);
        outBytes += slice.length;
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (errBytes >= STDERR_MAX_BYTES) return;
        const room = STDERR_MAX_BYTES - errBytes;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        errOut.push(slice);
        errBytes += slice.length;
      });

      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new TransportError(localError(error)));
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          ms: Math.round(performance.now() - started),
          timedOut,
          truncated,
        });
      });

      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  }
}

function localError(error: Error): AppError {
  const code = (error as Error & { code?: string }).code;
  if (code === 'ENOENT') {
    return {
      code: 'E_UNSUPPORTED',
      message: 'local mode needs /bin/sh on this machine',
      hint: 'use SSH (ARCH_MCP_HOST + ARCH_MCP_PORT) or run arch-mcp on a POSIX host',
    };
  }
  return { code: 'E_INTERNAL', message: `local command failed: ${error.message}` };
}
