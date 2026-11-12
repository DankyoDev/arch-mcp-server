import { createHash, randomBytes } from 'node:crypto';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';

interface PendingConfirmation {
  tool: string;
  argsHash: string;
  expiresAt: number;
  used: boolean;
}

const pending = new Map<string, PendingConfirmation>();
const MAX_PENDING = 128;

export interface Confirmation {
  token: string;
  expiresInS: number;
}

/**
 * Two-step confirmation (ADR-006): the first call gets a token bound to the
 * tool and its arguments; the second call must present it. Tokens are short,
 * expiring and single use.
 */
export function createConfirmation(
  tool: string,
  args: Record<string, unknown>,
  ttlS: number,
): Confirmation {
  prune();
  const nonce = randomBytes(16).toString('hex');
  const argsHash = argsFingerprint(args);
  const token = createHash('sha256').update(`${tool}|${argsHash}|${nonce}`).digest('hex').slice(0, 8);
  pending.set(token, {
    tool,
    argsHash,
    expiresAt: Date.now() + ttlS * 1000,
    used: false,
  });
  return { token, expiresInS: ttlS };
}

export function consumeConfirmation(
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Result<true> {
  const entry = pending.get(token);
  if (entry === undefined) {
    return err('E_CONFIRM', 'unknown or expired confirmation token', 'call the tool again without token to get a fresh preview');
  }
  if (entry.used) {
    return err('E_CONFIRM', 'confirmation token already used', 'call the tool again without token to get a fresh preview');
  }
  if (Date.now() > entry.expiresAt) {
    pending.delete(token);
    return err('E_CONFIRM', 'confirmation token expired', 'call the tool again without token to get a fresh preview');
  }
  if (entry.tool !== tool || entry.argsHash !== argsFingerprint(args)) {
    return err('E_CONFIRM', 'token does not match this tool or these arguments', 'repeat the exact call with a token from the same arguments');
  }
  entry.used = true;
  pending.delete(token);
  return ok(true);
}

/** Test hook. */
export function resetConfirmations(): void {
  pending.clear();
}

export function pendingCount(): number {
  return pending.size;
}

/** Arguments are fingerprinted without the token itself, in a stable order. */
export function argsFingerprint(args: Record<string, unknown>): string {
  const { token: _token, ...rest } = args;
  return createHash('sha256').update(stableStringify(rest)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function prune(): void {
  const now = Date.now();
  for (const [token, entry] of pending) {
    if (entry.used || entry.expiresAt < now) pending.delete(token);
  }
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}
