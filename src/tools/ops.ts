import { ok } from '../core/result.js';
import type { AppError, Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import type { CommandOutput } from '../exec/run.js';
import { confirmationPayload, consumeConfirmation } from '../policy/confirm.js';
import { toolData } from './registry.js';
import type { ToolContext, ToolPayload } from './registry.js';

export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export async function runChecked(
  ctx: ToolContext,
  argv: readonly string[],
  maxBytes = 16_384,
  timeoutMs?: number,
): Promise<Result<CommandOutput>> {
  const result = await runCommand(ctx.conn, argv, {
    timeoutMs: timeoutMs ?? ctx.config.timeoutMs,
    maxBytes,
  });
  if (!result.ok) return result;
  if (result.data.code !== 0) {
    return { ok: false, error: mapCommandError(result.data.stderr, `${argv[0]} failed`) };
  }
  return ok(result.data);
}

export function mapCommandError(stderr: string, fallback: string): AppError {
  const text = stderr.trim();
  const line = (text.split('\n')[0] ?? fallback).slice(0, 200);
  if (/no such (file|container|object|image|network|volume|service|project)|cannot stat|cannot remove|cannot open|not found/i.test(text)) {
    return { code: 'E_NOTFOUND', message: line || fallback, hint: 'check the path or the name' };
  }
  if (/Permission denied|Operation not permitted|not permitted/i.test(text)) {
    return {
      code: 'E_PERM',
      message: line || fallback,
      hint: 'the SSH user cannot perform this operation',
    };
  }
  return { code: 'E_INTERNAL', message: line || fallback, hint: 'check the command output' };
}

export async function confirmed(
  ctx: ToolContext,
  toolName: string,
  input: Record<string, unknown> & { dry_run: boolean; token?: string },
  preview: Record<string, unknown>,
  run: () => Promise<Result<ToolPayload>>,
): Promise<Result<ToolPayload>> {
  if (input.dry_run) {
    return ok(
      toolData({ ...preview, result: 'dry_run', ...confirmationPayload(toolName, input, ctx.config.confirmTtl) }),
    );
  }
  if (input.token === undefined) {
    return ok(toolData(confirmationPayload(toolName, input, ctx.config.confirmTtl, preview)));
  }
  const consumed = consumeConfirmation(input.token, toolName, input);
  if (!consumed.ok) return consumed;
  return run();
}
