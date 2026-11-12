import type { Envelope, Meta, OkEnvelope } from '../core/types.js';

export const HARD_MAX_BYTES = 32_768;

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export type EnvelopeMeta = Omit<Meta, 'truncated'>;

/**
 * Fit `data` into the byte budget. Lists are cut by whole elements, never in
 * the middle of an element; anything else that does not fit becomes E_TRUNCATED.
 */
export function fitEnvelope<T>(data: T, meta: EnvelopeMeta, maxBytes: number): Envelope<T> {
  const budget = Math.min(Math.max(maxBytes, 1024), HARD_MAX_BYTES);
  const fullBytes = jsonBytes(data);

  const build = (payload: unknown, extra: Partial<Meta> = {}): OkEnvelope<unknown> => ({
    ok: true,
    data: payload,
    meta: { ...meta, truncated: false, ...extra },
  });

  if (jsonBytes(build(data)) <= budget) {
    return build(data) as OkEnvelope<T>;
  }

  if (Array.isArray(data) && data.length > 0) {
    let low = 0;
    let high = data.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = build(data.slice(0, mid), {
        truncated: true,
        total: data.length,
        total_b: fullBytes,
      });
      if (jsonBytes(candidate) <= budget) low = mid;
      else high = mid - 1;
    }
    if (low > 0) {
      return build(data.slice(0, low), {
        truncated: true,
        total: data.length,
        total_b: fullBytes,
      }) as OkEnvelope<T>;
    }
  }

  return {
    ok: false,
    error: {
      code: 'E_TRUNCATED',
      message: `response needs ${fullBytes} B, budget is ${budget} B`,
      hint: 'request fewer items, narrow the filter, or raise ARCH_MCP_MAX_BYTES',
    },
    meta: { ...meta, truncated: true },
  };
}

export function errorEnvelope(
  error: { code: EnvelopeErrorCode; message: string; hint?: string; data?: unknown },
  meta: EnvelopeMeta,
): Envelope<never> {
  const envelope: Envelope<never> = {
    ok: false,
    error: { code: error.code, message: error.message },
    meta: { ...meta, truncated: false },
  };
  if (error.hint !== undefined) envelope.error.hint = error.hint;
  if (error.data !== undefined) envelope.data = error.data;
  return envelope;
}

type EnvelopeErrorCode = Extract<Envelope<never>, { ok: false }>['error']['code'];
