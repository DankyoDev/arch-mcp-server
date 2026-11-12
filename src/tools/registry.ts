import { inspect } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config, Profile } from '../config.js';
import { hostLabel } from '../config.js';
import type { Connection } from '../connection/types.js';
import type { HostCapabilities } from '../caps.js';
import { buildEnvelope, buildError } from '../core/envelope.js';
import { err } from '../core/result.js';
import type { Result } from '../core/types.js';
import { asAppError } from '../connection/errors.js';
import { audit } from '../policy/audit.js';
import { modeAllows } from '../policy/modes.js';
import { RateLimiter } from '../policy/rate.js';
import { toolRuntime } from './runtime.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** What a tool returns before the registry wraps it in the envelope. */
export interface ToolPayload {
  data: unknown;
  /** Items available in the full result, when the tool paginated. */
  total?: number;
  /** Opaque cursor for the next page, when there is one. */
  cursor?: string | null;
}

export function toolData(
  data: unknown,
  extra: { total?: number; cursor?: string | null } = {},
): ToolPayload {
  const payload: ToolPayload = { data };
  if (extra.total !== undefined) payload.total = extra.total;
  if (extra.cursor !== undefined) payload.cursor = extra.cursor;
  return payload;
}

export interface ToolContext {
  conn: Connection;
  config: Config;
  capabilities(): Promise<Result<HostCapabilities>>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  profiles: readonly Profile[];
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<Result<ToolPayload>>;
}

interface ToolInput<Schema extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  title: string;
  description: string;
  schema: Schema;
  annotations: ToolAnnotations;
  profiles: readonly Profile[];
  handler: (input: z.output<Schema>, ctx: ToolContext) => Promise<Result<ToolPayload>>;
}

/** Define a tool with typed input; the registry re-parses and enforces policy. */
export function defineTool<Schema extends z.ZodObject<z.ZodRawShape>>(
  input: ToolInput<Schema>,
): ToolDefinition {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    schema: input.schema,
    annotations: input.annotations,
    profiles: input.profiles,
    handler: async (raw, ctx) => input.handler(input.schema.parse(raw), ctx),
  };
}

export function toolsForProfile(
  tools: readonly ToolDefinition[],
  profile: Profile,
): ToolDefinition[] {
  return tools.filter((tool) => tool.profiles.includes(profile));
}

export function registerTool(server: McpServer, definition: ToolDefinition, ctx: ToolContext): void {
  const handler = async (args: unknown): Promise<CallToolResult> => {
    const started = performance.now();
    const host = hostLabel(ctx.config);
    const elapsed = (): number => Math.round(performance.now() - started);

    const parsed = definition.schema.safeParse(args ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
        .join('; ');
      return toCallResult(
        buildError({ code: 'E_INTERNAL', message: 'invalid tool arguments', hint: detail }, host, elapsed()),
      );
    }

    const rawArgs = parsed.data as Record<string, unknown>;
    const rate = rateLimiterFor(ctx.config).take(definition.name === 'raw_exec' ? 2 : 1);
    if (!rate.ok) {
      audit(ctx.config, {
        tool: definition.name,
        args: rawArgs,
        mode: ctx.config.mode,
        decision: 'deny',
        confirmed: false,
        ms: elapsed(),
        exit: rate.error.code,
      });
      return toCallResult(buildError(rate.error, host, elapsed()));
    }

    const policy = modeAllows(ctx.config.mode, definition.annotations);
    if (!policy.ok) {
      audit(ctx.config, {
        tool: definition.name,
        args: rawArgs,
        mode: ctx.config.mode,
        decision: 'deny',
        confirmed: false,
        ms: elapsed(),
        exit: policy.error.code,
      });
      return toCallResult(buildError(policy.error, host, elapsed()));
    }

    let outcome: Result<ToolPayload>;
    toolRuntime.enter();
    try {
      outcome = await definition.handler(parsed.data, ctx);
    } catch (error) {
      if (process.env.ARCH_MCP_DEBUG === '1') {
        const detail = error instanceof Error ? (error.stack ?? error.message) : inspect(error);
        process.stderr.write(`arch-mcp: ${definition.name} threw: ${detail}\n`);
      }
      const appError = asAppError(error);
      outcome =
        appError !== null
          ? { ok: false, error: appError }
          : err('E_INTERNAL', error instanceof Error ? error.message : inspect(error));
    } finally {
      toolRuntime.leave();
    }

    const envelope = outcome.ok
      ? buildEnvelope({
          data: outcome.data.data,
          host,
          ms: elapsed(),
          maxBytes: ctx.config.maxBytes,
          total: outcome.data.total,
          cursor: outcome.data.cursor,
        })
      : buildError(outcome.error, host, elapsed());

    audit(ctx.config, {
      tool: definition.name,
      args: rawArgs,
      mode: ctx.config.mode,
      decision: outcome.ok ? 'allow' : outcome.error.code === 'E_CONFIRM' ? 'confirm' : 'deny',
      confirmed: rawArgs.token !== undefined,
      ms: elapsed(),
      exit: outcome.ok ? 'OK' : outcome.error.code,
    });

    return toCallResult(envelope);
  };

  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema.shape,
      annotations: definition.annotations,
    },
    handler,
  );
}

function toCallResult(envelope: unknown): CallToolResult {
  const okEnvelope = (envelope as { ok: boolean }).ok;
  return {
    // ADR-012: structuredContent plus the same JSON as text for old clients.
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope as Record<string, unknown>,
    isError: !okEnvelope,
  };
}

let sharedLimiter: { limit: number; limiter: RateLimiter } | null = null;

function rateLimiterFor(config: Config): RateLimiter {
  if (sharedLimiter === null || sharedLimiter.limit !== config.rateLimit) {
    sharedLimiter = { limit: config.rateLimit, limiter: new RateLimiter(config.rateLimit) };
  }
  return sharedLimiter.limiter;
}
