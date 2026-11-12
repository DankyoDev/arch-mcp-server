import type { AppError, Envelope } from './types.js';
import { errorEnvelope, fitEnvelope } from '../exec/budget.js';

export interface OkEnvelopeInput<T> {
  data: T;
  host: string;
  ms: number;
  maxBytes: number;
  total?: number;
  cursor?: string | null;
}

export function buildEnvelope<T>(input: OkEnvelopeInput<T>): Envelope<T> {
  const meta: Parameters<typeof fitEnvelope>[1] = { host: input.host, ms: input.ms };
  if (input.total !== undefined) meta.total = input.total;
  if (input.cursor !== undefined) meta.cursor = input.cursor;
  return fitEnvelope(input.data, meta, input.maxBytes);
}

export function buildError(error: AppError, host: string, ms: number): Envelope<never> {
  return errorEnvelope(error, { host, ms });
}
