import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { confirmationPayload, consumeConfirmation } from '../policy/confirm.js';
import { checkDenylist } from '../policy/denylist.js';
import { readGaps, recordGap, summarizeGaps } from '../policy/gaps.js';
import { detectCommands } from '../parse/script.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { validateAbsolutePath } from './guards.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Daily tools that are safe to run with argv, without a shell. */
const EXEC_ALLOWED = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'fd',
  'fdfind',
  'find',
  'jq',
  'yq',
  'bat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'tee',
  'column',
  'comm',
  'join',
  'diff',
  'patch',
  'cat',
  'ls',
  'tree',
  'du',
  'df',
  'stat',
  'file',
  'ncdu',
  'tar',
  'gzip',
  'gunzip',
  'zstd',
  'unzstd',
  'xz',
  'unxz',
  'bzip2',
  'bunzip2',
  'zip',
  'unzip',
  '7z',
  'curl',
  'wget',
  'rsync',
  'scp',
  'sftp',
  'croc',
  'git',
  'sed',
  'sha256sum',
  'sha512sum',
  'md5sum',
  'b2sum',
  'base64',
  'xxd',
]);

/** Interpreters and wrappers are only reachable through script_run. */
const EXEC_ANY_BLOCKED = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
  'deno',
  'bun',
  'php',
  'lua',
  'rscript',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'xargs',
  'env',
  'nohup',
  'setsid',
  'nice',
  'ionice',
  'timeout',
  'stdbuf',
  'watch',
  'ssh',
  'sshpass',
  'telnet',
  'nc',
  'ncat',
  'socat',
]);

const SCRIPT_LANGUAGES = ['python', 'bash', 'sh', 'node', 'perl', 'ruby'] as const;
type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

/** Languages where the first word of a line is a binary worth reporting. */
const SHELL_LANGUAGES = new Set<ScriptLanguage>(['bash', 'sh']);

const SCRIPT_INTERPRETER: Record<ScriptLanguage, string> = {
  python: 'python3',
  bash: 'bash',
  sh: 'sh',
  node: 'node',
  perl: 'perl',
  ruby: 'ruby',
};

const SCRIPT_EXTENSION: Record<ScriptLanguage, string> = {
  python: 'py',
  bash: 'sh',
  sh: 'sh',
  node: 'mjs',
  perl: 'pl',
  ruby: 'rb',
};

const Argv = z.array(z.string().min(1).max(4096)).min(1).max(64);

function normalize(argv: readonly string[]): { binary: string; argv: string[] } {
  const first = argv[0] ?? '';
  return { binary: basename(first), argv: [basename(first), ...argv.slice(1)] };
}

function validateArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
      return 'arguments must not contain NUL or newlines';
    }
  }
  return null;
}

function preview(argv: readonly string[], timeoutMs: number): Record<string, unknown> {
  return { argv, timeout_ms: timeoutMs, effect: 'runs directly on the host without a shell' };
}

async function runArgv(
  ctx: ToolContext,
  argv: readonly string[],
  timeoutMs: number,
  maxBytes: number,
): Promise<Awaited<ReturnType<typeof runCommand>>> {
  return runCommand(ctx.conn, argv, { timeoutMs, maxBytes });
}

export const execTool = defineTool({
  name: 'exec',
  title: 'Run a daily tool',
  description:
    'Run one allowlisted binary with argv (no shell) after two-step confirmation. For rg, fd, jq, tar, rsync, curl, git, croc and similar daily tools; use a native tool first.',
  schema: z.object({
    argv: Argv.describe('Binary and arguments, e.g. ["rg","TODO","src"]'),
    timeout_ms: z.number().int().min(100).max(300_000).default(30_000).describe('Timeout'),
    max_bytes: z.number().int().min(1024).max(131_072).default(16_384).describe('stdout cap'),
    dry_run: z.boolean().default(false).describe('Preview without running'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const normalized = normalize(input.argv);
    const problem = validateArgv(normalized.argv);
    if (problem !== null) return err('E_POLICY', problem, 'pass plain arguments');
    if (!EXEC_ALLOWED.has(normalized.binary)) {
      return err(
        'E_POLICY',
        `${normalized.binary} is not in the exec allowlist`,
        ctx.config.allowAnyExec
          ? 'use exec_any in admin mode, or add it to EXEC_ALLOWED'
          : 'use a native tool or add it to EXEC_ALLOWED',
      );
    }
    const denied = checkDenylist(normalized.argv);
    if (denied !== null) return { ok: false, error: denied };
    if (input.dry_run) {
      return ok(toolData({ ...preview(normalized.argv, input.timeout_ms), result: 'dry_run' }));
    }
    if (input.token === undefined) {
      return ok(
        toolData(confirmationPayload('exec', input, ctx.config.confirmTtl, preview(normalized.argv, input.timeout_ms))),
      );
    }
    const consumed = consumeConfirmation(input.token, 'exec', input);
    if (!consumed.ok) return consumed;

    const started = performance.now();
    const result = await runArgv(ctx, normalized.argv, input.timeout_ms, input.max_bytes);
    const ms = Math.round(performance.now() - started);
    recordGap(ctx.config, {
      binary: normalized.binary,
      argv: normalized.argv,
      exit: result.ok ? result.data.code : -1,
      ms,
      stdout_b: result.ok ? Buffer.byteLength(result.data.stdout) : 0,
      native: false,
      reason: 'exec fallback (allowlisted)',
    });
    if (!result.ok) return result;
    return ok(
      toolData({
        code: result.data.code,
        stdout: result.data.stdout,
        stderr: result.data.stderr,
        truncated: result.data.truncated,
        ms,
      }),
    );
  },
});

export const execAnyTool = defineTool({
  name: 'exec_any',
  title: 'Run any binary (admin)',
  description:
    'Run any non-blocked binary with argv (no shell) after two-step confirmation. Requires ARCH_MCP_ALLOW_ANY_EXEC=1 and admin mode; interpreters are refused.',
  schema: z.object({
    argv: Argv.describe('Binary and arguments'),
    timeout_ms: z.number().int().min(100).max(300_000).default(30_000).describe('Timeout'),
    max_bytes: z.number().int().min(1024).max(131_072).default(16_384).describe('stdout cap'),
    dry_run: z.boolean().default(false).describe('Preview without running'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (!ctx.config.allowAnyExec) {
      return err('E_POLICY', 'exec_any is disabled', 'set ARCH_MCP_ALLOW_ANY_EXEC=1 to enable it');
    }
    if (ctx.config.mode !== 'admin') {
      return err('E_POLICY', 'exec_any requires admin mode', 'set ARCH_MCP_MODE=admin');
    }
    const normalized = normalize(input.argv);
    const problem = validateArgv(normalized.argv);
    if (problem !== null) return err('E_POLICY', problem, 'pass plain arguments');
    if (EXEC_ANY_BLOCKED.has(normalized.binary)) {
      return err(
        'E_POLICY',
        `${normalized.binary} is an interpreter or wrapper`,
        'use script_run for code, or a native tool',
      );
    }
    const denied = checkDenylist(normalized.argv);
    if (denied !== null) return { ok: false, error: denied };
    if (input.dry_run) {
      return ok(toolData({ ...preview(normalized.argv, input.timeout_ms), result: 'dry_run' }));
    }
    if (input.token === undefined) {
      return ok(
        toolData(confirmationPayload('exec_any', input, ctx.config.confirmTtl, preview(normalized.argv, input.timeout_ms))),
      );
    }
    const consumed = consumeConfirmation(input.token, 'exec_any', input);
    if (!consumed.ok) return consumed;

    const started = performance.now();
    const result = await runArgv(ctx, normalized.argv, input.timeout_ms, input.max_bytes);
    const ms = Math.round(performance.now() - started);
    recordGap(ctx.config, {
      binary: normalized.binary,
      argv: normalized.argv,
      exit: result.ok ? result.data.code : -1,
      ms,
      stdout_b: result.ok ? Buffer.byteLength(result.data.stdout) : 0,
      native: false,
      reason: 'exec_any fallback',
    });
    if (!result.ok) return result;
    return ok(
      toolData({
        code: result.data.code,
        stdout: result.data.stdout,
        stderr: result.data.stderr,
        truncated: result.data.truncated,
        ms,
      }),
    );
  },
});

export const scriptRunTool = defineTool({
  name: 'script_run',
  title: 'Write and run a script',
  description:
    'Run inline code or an existing script with python3, bash, sh, node, perl or ruby after two-step confirmation. Requires ARCH_MCP_ALLOW_SCRIPTS=1 and admin mode.',
  schema: z.object({
    language: z.enum(SCRIPT_LANGUAGES).default('python').describe('Interpreter'),
    source: z.string().min(1).max(65_536).optional().describe('Inline source code'),
    path: z.string().min(1).max(4096).optional().describe('Existing absolute script path'),
    args: z.array(z.string().max(4096)).max(32).default([]).describe('Arguments after the script'),
    timeout_ms: z.number().int().min(100).max(300_000).default(60_000).describe('Timeout'),
    max_bytes: z.number().int().min(1024).max(131_072).default(32_768).describe('stdout cap'),
    keep: z.boolean().default(false).describe('Keep the generated script in /tmp'),
    dry_run: z.boolean().default(false).describe('Preview without writing or running'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (!ctx.config.allowScripts) {
      return err('E_POLICY', 'script_run is disabled', 'set ARCH_MCP_ALLOW_SCRIPTS=1 to enable it');
    }
    if (ctx.config.mode !== 'admin') {
      return err('E_POLICY', 'script_run requires admin mode', 'set ARCH_MCP_MODE=admin');
    }
    const hasSource = input.source !== undefined;
    const hasPath = input.path !== undefined;
    if (hasSource === hasPath) {
      return err('E_POLICY', 'provide exactly one of source or path', 'inline code or an existing file');
    }
    if (input.path !== undefined) {
      const path = validateAbsolutePath(input.path);
      if (!path.ok) return path;
    }
    const interpreter = SCRIPT_INTERPRETER[input.language];
    const commands = SHELL_LANGUAGES.has(input.language) ? detectCommands(input.source) : [];
    const previewData = {
      interpreter,
      source_bytes: input.source === undefined ? 0 : Buffer.byteLength(input.source),
      path: input.path ?? null,
      args: input.args,
      keep: input.keep,
      commands,
      effect: 'writes the script to /tmp and executes it as the SSH user',
    };
    if (input.dry_run) {
      return ok(
        toolData({ ...previewData, result: 'dry_run', ...confirmationPayload('script_run', input, ctx.config.confirmTtl) }),
      );
    }
    if (input.token === undefined) {
      return ok(toolData(confirmationPayload('script_run', input, ctx.config.confirmTtl, previewData)));
    }
    const consumed = consumeConfirmation(input.token, 'script_run', input);
    if (!consumed.ok) return consumed;

    let scriptPath = input.path;
    let temporary = false;
    if (input.source !== undefined) {
      scriptPath = `/tmp/arch-mcp-${randomUUID()}.${SCRIPT_EXTENSION[input.language]}`;
      const written = await runCommand(ctx.conn, ['sh', '-c', 'cat > "$1"', '_', scriptPath], {
        timeoutMs: ctx.config.timeoutMs,
        maxBytes: 4096,
        input: input.source,
      });
      if (!written.ok) return written;
      if (written.data.code !== 0) {
        return err('E_PERM', `cannot write ${scriptPath}`, written.data.stderr.trim() || 'check /tmp');
      }
      temporary = true;
    }
    if (scriptPath === undefined) {
      return err('E_INTERNAL', 'script path was not resolved', 'retry with source or path');
    }

    const argv = [interpreter, scriptPath, ...input.args];
    const started = performance.now();
    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: input.timeout_ms,
      maxBytes: input.max_bytes,
    });
    const ms = Math.round(performance.now() - started);
    if (temporary && !input.keep) {
      await runCommand(ctx.conn, ['rm', '-f', scriptPath], { timeoutMs: 5000, maxBytes: 1024 });
    }
    recordGap(ctx.config, {
      binary: `script:${interpreter}`,
      argv: [interpreter, temporary && !input.keep ? '<temp>' : scriptPath, ...input.args],
      exit: result.ok ? result.data.code : -1,
      ms,
      stdout_b: result.ok ? Buffer.byteLength(result.data.stdout) : 0,
      native: false,
      reason: 'script_run',
      commands,
    });
    if (!result.ok) return result;
    return ok(
      toolData({
        code: result.data.code,
        stdout: result.data.stdout,
        stderr: result.data.stderr,
        truncated: result.data.truncated,
        interpreter,
        path: input.keep ? scriptPath : undefined,
        ms,
      }),
    );
  },
});

export const execGapsTool = defineTool({
  name: 'exec_gaps',
  title: 'Fallback command report',
  description:
    'List the binaries the agent had to run through the fallback, grouped by binary and count, so the top ones can become native tools.',
  schema: z.object({
    limit: z.number().int().min(1).max(200).default(50).describe('Binaries to return'),
    binary: z.string().max(200).optional().describe('Only this binary'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const entries = readGaps(ctx.config);
    const filtered =
      input.binary === undefined ? entries : entries.filter((entry) => entry.binary === input.binary);
    const binaries = summarizeGaps(filtered, input.limit);
    return ok(toolData({ total: filtered.length, path: ctx.config.gapLog, binaries }));
  },
});

export const gapReportTool = defineTool({
  name: 'gap_report',
  title: 'Report an out-of-band command',
  description:
    'Record a command the agent ran outside the MCP (for example via plain SSH) so it appears in exec_gaps and can become a native tool.',
  schema: z.object({
    binary: z.string().min(1).max(200).describe('Binary or tool name'),
    argv: z.array(z.string().max(4096)).max(64).optional().describe('Full argv if known'),
    note: z.string().max(500).optional().describe('Why it was needed'),
    exit: z.number().int().min(-1).max(255).default(-1).describe('Exit code, if known'),
    dry_run: z.boolean().default(false).describe('Preview without recording'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.dry_run) {
      return ok(toolData({ binary: input.binary, argv: input.argv ?? [input.binary], result: 'dry_run' }));
    }
    recordGap(ctx.config, {
      binary: input.binary,
      argv: input.argv ?? [input.binary],
      exit: input.exit,
      ms: 0,
      stdout_b: 0,
      native: false,
      reason: input.note ?? 'reported outside MCP',
    });
    return ok(toolData({ reported: input.binary, path: ctx.config.gapLog }));
  },
});
