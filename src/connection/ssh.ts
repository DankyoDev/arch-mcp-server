import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Config } from '../config.js';
import type { AppError } from '../core/types.js';
import { TransportError } from './errors.js';
import type { Connection, ExecOptions, RawExecResult } from './types.js';

const DEFAULT_MAX_BYTES = 8192;
const STDERR_MAX_BYTES = 2048;

interface MappedError {
  appError: AppError;
  retryable: boolean;
}

export class SshConnection implements Connection {
  readonly kind = 'ssh' as const;
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();
  #warnedHostKey = false;

  constructor(private readonly config: Config) {}

  exec(line: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    const run = this.#queue.then(() => this.#execWithRetry(line, opts));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    this.#closed = true;
    this.#client?.end();
    this.#client = null;
  }

  async #execWithRetry(line: string, opts: ExecOptions): Promise<RawExecResult> {
    const client = await this.#connect();
    const first = await this.#execOnce(client, line, opts);
    if (first.ok) return first.result;

    // Retry once only when nothing was received: a mutation may have run
    // remotely even if the channel died, so partial output is never replayed.
    if (!first.error.retryable || first.receivedBytes > 0) throw new TransportError(first.error.appError);
    this.#client = null;
    const fresh = await this.#connect();
    const second = await this.#execOnce(fresh, line, opts);
    if (second.ok) return second.result;
    throw new TransportError(second.error.appError);
  }

  #connect(): Promise<Client> {
    if (this.#closed) {
      return Promise.reject(new TransportError(appError('E_CONN', 'connection is closed', 'restart arch-mcp')));
    }
    if (this.#client !== null) return Promise.resolve(this.#client);
    if (this.#connecting !== null) return this.#connecting;

    this.#connecting = new Promise<Client>((resolve, reject) => {
      const client = new Client();
      const connectConfig: ConnectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        readyTimeout: 10_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
      };

      if (this.config.key !== undefined) {
        try {
          connectConfig.privateKey = readFileSync(this.config.key);
        } catch (error) {
          reject(new TransportError(appError('E_AUTH', `cannot read private key at ${this.config.key}`, describe(error))));
          return;
        }
        if (this.config.passphrase !== undefined) connectConfig.passphrase = this.config.passphrase;
      } else if (this.config.password !== undefined) {
        connectConfig.password = this.config.password;
      }

      const expected = this.config.hostKey;
      connectConfig.hostVerifier = (key: Buffer): boolean => {
        const actual = fingerprint(key);
        if (expected !== undefined) return actual === expected;
        if (!this.#warnedHostKey) {
          this.#warnedHostKey = true;
          process.stderr.write(`arch-mcp: TOFU host key ${actual} for ${this.config.host}\n`);
        }
        return true;
      };

      client.once('ready', () => {
        this.#client = client;
        resolve(client);
      });
      client.once('error', (error: Error) => {
        reject(new TransportError(mapConnectionError(error, this.config)));
      });
      client.on('close', () => {
        if (this.#client === client) this.#client = null;
      });
      client.connect(connectConfig);
    }).finally(() => {
      this.#connecting = null;
    });

    return this.#connecting;
  }

  #execOnce(
    client: Client,
    line: string,
    opts: ExecOptions,
  ): Promise<
    { ok: true; result: RawExecResult } | { ok: false; error: MappedError; receivedBytes: number }
  > {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
    const started = performance.now();

    return new Promise((resolve) => {
      client.exec(line, (error, stream) => {
        if (error) {
          resolve({
            ok: false,
            error: { appError: appError('E_CONN', 'cannot open SSH channel', describe(error)), retryable: true },
            receivedBytes: 0,
          });
          return;
        }

        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let truncated = false;
        let timedOut = false;
        let receivedBytes = 0;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          stream.close();
        }, timeoutMs);

        stream.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
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

        stream.stderr.on('data', (chunk: Buffer) => {
          if (errBytes >= STDERR_MAX_BYTES) return;
          const room = STDERR_MAX_BYTES - errBytes;
          const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
          errOut.push(slice);
          errBytes += slice.length;
        });

        stream.on('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: true,
            result: {
              code: code ?? -1,
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(errOut).toString('utf8'),
              ms: Math.round(performance.now() - started),
              timedOut,
              truncated,
            },
          });
        });

        if (opts.input !== undefined) stream.end(opts.input);
        else stream.end();

        stream.on('error', (streamError: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: false,
            error: {
              appError: appError('E_CONN', 'SSH channel failed', describe(streamError)),
              retryable: true,
            },
            receivedBytes,
          });
        });
      });
    });
  }
}

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function mapConnectionError(error: Error, config: Config): AppError {
  const code = (error as Error & { code?: string }).code;
  const level = (error as Error & { level?: string }).level;
  if (level === 'client-authentication' || code === 'EAI_AGAIN') {
    return appError('E_AUTH', `SSH authentication failed for ${config.user}@${config.host}`, 'check ARCH_MCP_KEY / ARCH_MCP_PASSWORD');
  }
  if (code === 'ETIMEDOUT') {
    return appError('E_TIMEOUT', `SSH connection to ${config.host}:${config.port} timed out`, 'check the network or raise ARCH_MCP_TIMEOUT_MS');
  }
  return appError('E_CONN', `cannot connect to ${config.host}:${config.port}`, describe(error));
}

function appError(code: AppError['code'], message: string, hint?: string): AppError {
  const error: AppError = { code, message };
  if (hint !== undefined) error.hint = hint;
  return error;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
