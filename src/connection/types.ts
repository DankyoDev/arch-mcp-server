export interface RawExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Byte cap for stdout. Defaults to 8192. */
  maxBytes?: number;
  /** Data written to the command's stdin before it is closed. */
  input?: string;
  /** Original argv, used by the sudo wrapper to decide whether to escalate. */
  argv?: readonly string[];
}

export interface Connection {
  readonly kind: 'ssh' | 'local';
  exec(line: string, opts?: ExecOptions): Promise<RawExecResult>;
  close(): void;
}
