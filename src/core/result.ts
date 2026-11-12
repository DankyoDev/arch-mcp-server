import type { AppError, ErrCode, Result } from './types.js';

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err(code: ErrCode, message: string, hint?: string, data?: unknown): Result<never> {
  const error: AppError = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (data !== undefined) error.data = data;
  return { ok: false, error };
}
