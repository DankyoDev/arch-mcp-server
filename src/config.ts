import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type Mode = 'readonly' | 'write' | 'admin';
export type Profile = 'core' | 'readonly' | 'full';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/** Env booleans accept 1/0, true/false, yes/no, on/off. */
const envBool = z.preprocess((value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return value;
}, z.boolean());

const RawConfig = z.object({
  host: z.string().min(1).default('localhost'),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  user: z.string().min(1).default(defaultUser()),
  password: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  passphrase: z.string().optional(),
  hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/=]+$/, 'expected SHA256:<base64>').optional(),
  mode: z.enum(['readonly', 'write', 'admin']).default('readonly'),
  profile: z.enum(['core', 'readonly', 'full']).default('core'),
  allowSudo: envBool.default(false),
  /** Empty means every command; otherwise binary or "binary subcommand" prefixes. */
  sudoAllow: z.preprocess(
    (value: unknown) =>
      typeof value === 'string'
        ? value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
        : value,
    z.array(z.string().min(1).max(200)).default([]),
  ),
  allowRaw: envBool.default(false),
  maxBytes: z.coerce.number().int().min(1024).max(32768).default(8192),
  timeoutMs: z.coerce.number().int().min(500).max(600_000).default(15_000),
  rateLimit: z.coerce.number().int().min(1).max(600).default(30),
  audit: envBool.default(true),
  auditPath: z.string().min(1).default(defaultAuditPath()),
  confirmTtl: z.coerce.number().int().min(10).max(3600).default(120),
  /** Bearer token for the optional HTTP transport (ADR-020). */
  httpToken: z.string().min(16).max(512).optional(),
  /** Allow arbitrary binaries through `exec_any` (admin only, ADR-021). */
  allowAnyExec: envBool.default(false),
  /** Allow running scripts with an interpreter (admin only, ADR-021). */
  allowScripts: envBool.default(false),
  /** Local JSONL where fallback commands are recorded. */
  gapLog: z.string().min(1).default(defaultGapPath()),
  /** Optional central collector for gap reports. */
  gapEndpoint: z.string().url().optional(),
  gapToken: z.string().optional(),
  /** Explicit opt-in only: never inferred from the host name (ADR-017). */
  local: envBool.default(false),
});

export type Config = z.output<typeof RawConfig>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigResult {
  config: Config;
  warnings: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return loadConfigDetailed(env).config;
}

export function loadConfigDetailed(env: NodeJS.ProcessEnv = process.env): LoadConfigResult {
  const source: Record<string, unknown> = {
    host: env.ARCH_MCP_HOST,
    port: env.ARCH_MCP_PORT,
    user: env.ARCH_MCP_USER,
    password: env.ARCH_MCP_PASSWORD,
    key: env.ARCH_MCP_KEY,
    passphrase: env.ARCH_MCP_PASSPHRASE,
    hostKey: env.ARCH_MCP_HOST_KEY,
    mode: env.ARCH_MCP_MODE,
    profile: env.ARCH_MCP_PROFILE,
    allowSudo: env.ARCH_MCP_ALLOW_SUDO,
    sudoAllow: env.ARCH_MCP_SUDO_ALLOW,
    allowRaw: env.ARCH_MCP_ALLOW_RAW,
    maxBytes: env.ARCH_MCP_MAX_BYTES,
    timeoutMs: env.ARCH_MCP_TIMEOUT_MS,
    rateLimit: env.ARCH_MCP_RATE_LIMIT,
    audit: env.ARCH_MCP_AUDIT,
    auditPath: env.ARCH_MCP_AUDIT_PATH,
    confirmTtl: env.ARCH_MCP_CONFIRM_TTL,
    httpToken: env.ARCH_MCP_HTTP_TOKEN,
    allowAnyExec: env.ARCH_MCP_ALLOW_ANY_EXEC,
    allowScripts: env.ARCH_MCP_ALLOW_SCRIPTS,
    gapLog: env.ARCH_MCP_GAP_LOG,
    gapEndpoint: env.ARCH_MCP_GAP_ENDPOINT,
    gapToken: env.ARCH_MCP_GAP_TOKEN,
    local: env.ARCH_MCP_LOCAL,
  };

  const parsed = RawConfig.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`invalid configuration: ${detail}`);
  }

  const config = parsed.data;
  const warnings: string[] = [];
  if (config.password !== undefined && config.key !== undefined) {
    warnings.push('both ARCH_MCP_KEY and ARCH_MCP_PASSWORD set; key takes precedence');
  }
  if (config.allowSudo) {
    warnings.push(
      'ARCH_MCP_ALLOW_SUDO=1: commands run through sudo -n; the SSH user needs NOPASSWD rules',
    );
  }
  if (config.allowRaw) {
    warnings.push('ARCH_MCP_ALLOW_RAW=1: raw_exec is exposed (admin mode only)');
  }
  if (config.allowAnyExec) {
    warnings.push('ARCH_MCP_ALLOW_ANY_EXEC=1: exec_any can run any non-blocked binary (admin mode only)');
  }
  if (config.allowScripts) {
    warnings.push('ARCH_MCP_ALLOW_SCRIPTS=1: script_run can execute arbitrary code (admin mode only)');
  }
  if (config.gapEndpoint !== undefined && config.gapToken === undefined) {
    warnings.push('ARCH_MCP_GAP_ENDPOINT set without ARCH_MCP_GAP_TOKEN');
  }
  return { config, warnings };
}

function defaultUser(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'root';
}

function defaultAuditPath(): string {
  return join(homedir(), '.local', 'state', 'arch-mcp', 'audit.jsonl');
}

function defaultGapPath(): string {
  return join(homedir(), '.local', 'state', 'arch-mcp', 'gaps.jsonl');
}

/** Label used in `meta.host` and log lines. */
export function hostLabel(config: Config): string {
  if (config.local) return 'localhost';
  return config.port === 22 ? config.host : `${config.host}:${config.port}`;
}
