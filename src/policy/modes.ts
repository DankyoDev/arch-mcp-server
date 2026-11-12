export type Mode = 'readonly' | 'write' | 'admin';

export interface ModeAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
}

/**
 * Decide whether a mode allows a tool. Read-only tools always pass. Mutations
 * need `write`; `readonly` never executes anything (E_POLICY, nothing runs).
 */
export function modeAllows(mode: Mode, annotations: ModeAnnotations):
  | { ok: true }
  | { ok: false; error: { code: 'E_POLICY'; message: string; hint: string } } {
  if (annotations.readOnlyHint) return { ok: true };
  if (mode === 'readonly') {
    return {
      ok: false,
      error: {
        code: 'E_POLICY',
        message: 'host is in readonly mode and this tool mutates state',
        hint: 'set ARCH_MCP_MODE=write to allow mutations (a confirmation token is still required)',
      },
    };
  }
  return { ok: true };
}
