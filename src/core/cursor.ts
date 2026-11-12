import { err, ok } from './result.js';
import type { Result } from './types.js';

/** Opaque pagination cursor: base64 of `offset:N`. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Result<number> {
  if (cursor === undefined || cursor === '') return ok(0);
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return err('E_INTERNAL', 'invalid cursor', 'omit cursor to start from the first page');
  }
  const match = /^offset:(\d+)$/.exec(decoded);
  if (match === null) return err('E_INTERNAL', 'invalid cursor', 'omit cursor to start from the first page');
  const offset = Number(match[1]);
  return Number.isInteger(offset) && offset >= 0
    ? ok(offset)
    : err('E_INTERNAL', 'invalid cursor', 'omit cursor to start from the first page');
}
