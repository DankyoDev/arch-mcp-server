import type { AppError } from '../core/types.js';

/**
 * Connection failures are values (AppError) but the transport rejects, so the
 * error travels as a real Error subclass and exec/run maps it back.
 */
export class TransportError extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message);
    this.name = 'TransportError';
  }
}

/** Recognise AppError values that crossed a boundary as thrown objects. */
export function asAppError(error: unknown): AppError | null {
  if (error instanceof TransportError) return error.appError;
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; message?: unknown; hint?: unknown };
  if (
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('E_') &&
    typeof candidate.message === 'string'
  ) {
    const appError: AppError = {
      code: candidate.code as AppError['code'],
      message: candidate.message,
    };
    if (typeof candidate.hint === 'string') appError.hint = candidate.hint;
    return appError;
  }
  return null;
}
