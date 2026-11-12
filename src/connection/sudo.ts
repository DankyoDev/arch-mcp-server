import { basename } from 'node:path';
import type { Config } from '../config.js';
import type { Connection, ExecOptions, RawExecResult } from './types.js';

/**
 * Run commands through `sudo -n` while keeping the same SSH user.
 * The remote user needs a NOPASSWD rule for the allowed commands.
 */
export class SudoConnection implements Connection {
  readonly kind: 'ssh' | 'local';

  constructor(
    private readonly inner: Connection,
    private readonly config: Config,
  ) {
    this.kind = inner.kind;
  }

  exec(line: string, opts: ExecOptions = {}): Promise<RawExecResult> {
    // Batched sections are a single shell line with several `env ...` commands;
    // wrap each one so every section runs elevated, not just the first.
    if (this.config.allowSudo && this.config.sudoAllow.length === 0 && line.includes('; env ')) {
      return this.inner.exec(line.replace(/(^|; )env /g, '$1sudo -n env '), opts);
    }
    if (!this.allowed(opts)) return this.inner.exec(line, opts);
    return this.inner.exec(`sudo -n ${line}`, opts);
  }

  close(): void {
    this.inner.close();
  }

  private allowed(opts: ExecOptions): boolean {
    if (!this.config.allowSudo) return false;
    const argv = opts.argv;
    if (argv === undefined || argv.length === 0) return false;
    if (this.config.sudoAllow.length === 0) return true;
    const binary = basename(argv[0] ?? '');
    const joined = `${binary} ${argv.slice(1).join(' ')}`;
    return this.config.sudoAllow.some((entry) => binary === entry || joined.startsWith(entry));
  }
}
