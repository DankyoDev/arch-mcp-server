export type ErrCode =
  | 'E_CONN'
  | 'E_AUTH'
  | 'E_TIMEOUT'
  | 'E_NOTFOUND'
  | 'E_PERM'
  | 'E_POLICY'
  | 'E_CONFIRM'
  | 'E_UNSUPPORTED'
  | 'E_PARSE'
  | 'E_TRUNCATED'
  | 'E_INTERNAL';

export interface AppError {
  code: ErrCode;
  message: string;
  hint?: string;
  /** Extra machine-readable detail (e.g. the confirmation token). */
  data?: unknown;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export interface Meta {
  host: string;
  ms: number;
  truncated: boolean;
  /** Number of items in the untruncated list, when known. */
  total?: number;
  /** Bytes of the untruncated payload, set only when truncated. */
  total_b?: number;
  cursor?: string | null;
}

export interface OkEnvelope<T> {
  ok: true;
  data: T;
  meta: Meta;
}

export interface ErrEnvelope {
  ok: false;
  error: AppError;
  data?: unknown;
  meta: Meta;
}

export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;
