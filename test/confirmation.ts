import assert from 'node:assert/strict';
import type { Result } from '../src/core/types.js';
import type { ToolPayload } from '../src/tools/registry.js';

interface ConfirmationData {
  confirm_required?: boolean;
  token?: string;
  expires_in_s?: number;
  result?: string;
}

function payloadOf(result: Result<ToolPayload>): ConfirmationData {
  if (!result.ok) throw new Error(`expected a successful response, got ${result.error.code}`);
  return (result.data.data as ConfirmationData | undefined) ?? {};
}

/**
 * Token from the "confirmation required" response. Since ADR-024 that response
 * is a success with `confirm_required: true`, not an E_CONFIRM error.
 */
export function tokenOf(result: Result<ToolPayload>): string {
  const data = payloadOf(result);
  assert.equal(data.confirm_required, true, 'expected a confirmation request');
  assert.equal(typeof data.token, 'string');
  return data.token as string;
}

/** True when the call asked for a token instead of running. */
export function needsConfirmation(result: Result<ToolPayload>): boolean {
  if (!result.ok) return false;
  return payloadOf(result).confirm_required === true;
}

/** True when the call was a dry run preview. */
export function isPreview(result: Result<ToolPayload>): boolean {
  if (!result.ok) return false;
  return payloadOf(result).result === 'dry_run';
}
