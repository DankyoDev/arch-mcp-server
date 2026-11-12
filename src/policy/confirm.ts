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
 * Body merged into a successful response when a mutation still needs a token.
 * It is not an error: the call was understood and nothing ran (ADR-024).
 */
export interface ConfirmationPayload {
  confirm_required: true;
  token: string;
  expires_in_s: number;
  preview?: unknown;
}

/**
 * Two-step confirmation (ADR-006): the first call gets a token bound to the
 * tool and its arguments; the second call must present it. Tokens are short,
 * expiring and single use.
 */
export function createConfirmation(tool: string, args: object, ttlS: number): Confirmation {
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

/** Payload for "here is what would run, send this token back to run it". */
export function confirmationPayload(
  tool: string,
  args: object,
  ttlS: number,
  preview?: unknown,
): ConfirmationPayload {
  const confirmation = createConfirmation(tool, args, ttlS);
  const payload: ConfirmationPayload = {
    confirm_required: true,
    token: confirmation.token,
    expires_in_s: confirmation.expiresInS,
  };
  if (preview !== undefined) payload.preview = preview;
  return payload;
}

export function consumeConfirmation(token: string, tool: string, args: object): Result<true> {
  const entry = pending.get(token);
  if (entry === undefined) {
    return err('E_CONFIRM', 'unknown or expired confirmation token', 'call the tool again without token to get a fresh token');
  }
  if (entry.used) {
    return err('E_CONFIRM', 'confirmation token already used', 'call the tool again without token to get a fresh token');
  }
  if (Date.now() > entry.expiresAt) {
    pending.delete(token);
    return err('E_CONFIRM', 'confirmation token expired', 'call the tool again without token to get a fresh token');
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

/**
 * Keys that hold a script or a file body. Whitespace that no interpreter or
 * editor cares about is dropped before hashing, so re-emitting the same code
 * with a trailing newline or CRLF does not invalidate the token.
 */
const NORMALIZED_KEYS = ['source', 'content'] as const;

/** Trailing spaces per line, line endings and edge blank lines are noise. */
export function normalizeBody(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * Arguments are fingerprinted without the token (it is the answer, not the
 * question) and without `dry_run`, so a preview token authorizes the real call.
 */
export function argsFingerprint(args: object): string {
  const { token: _token, dry_run: _dryRun, ...rest } = args as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...rest };
  for (const key of NORMALIZED_KEYS) {
    const value = normalized[key];
    if (typeof value === 'string') normalized[key] = normalizeBody(value);
  }
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
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
