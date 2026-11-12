import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../core/cursor.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import { parseDockerInspect, parseDockerPs } from '../parse/docker.js';
import { requireFeature, validateAbsolutePath } from './guards.js';
import { confirmed, mapCommandError, MUTATE, READ } from './ops.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';

/** Container, image or project names never start with a dash. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,200}$/;
/** Compose file name inside the project directory, never a path. */
const FILE = /^[A-Za-z0-9_.-]{1,64}$/;
/** `--since` accepts a relative duration or a timestamp, nothing else. */
const SINCE = /^(?:[0-9]{1,9}[smhd]|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]+)?)$/;

const PS_BYTES = 131_072;
const LOG_BYTES = 65_536;
const INSPECT_BYTES = 32_768;

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const dockerHint = 'install docker on the host, or use script_run for this';

export const dockerPsTool = defineTool({
  name: 'docker_ps',
  title: 'List containers',
  description:
    'Containers with image, state, publish ports and Compose project. Use it before docker_logs or docker_inspect, and to check the result of docker_compose.',
  schema: z.object({
    all: z.boolean().default(true).describe('Include stopped containers'),
    project: z.string().max(64).optional().describe('Only this Compose project'),
    name: z.string().max(200).optional().describe('Substring of the container name'),
    limit: z.number().int().min(1).max(200).default(50).describe('Containers per page'),
    cursor: z.string().max(64).optional().describe('Cursor from a previous call'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'docker', dockerHint);
    if (!guard.ok) return guard;
    const offset = decodeCursor(input.cursor);
    if (!offset.ok) return offset;

    const argv = ['docker', 'ps'];
    if (input.all) argv.push('-a');
    argv.push('--format', '{{json .}}');

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: PS_BYTES,
      allowContainers: true,
    });
    if (!result.ok) return result;
    if (result.data.code !== 0) return { ok: false, error: mapCommandError(result.data.stderr, 'docker ps failed') };

    let rows = parseDockerPs(result.data.stdout);
    if (input.project !== undefined) rows = rows.filter((row) => row.project === input.project);
    if (input.name !== undefined) {
      const needle = input.name.toLowerCase();
      rows = rows.filter((row) => row.name.toLowerCase().includes(needle));
    }

    const page = rows.slice(offset.data, offset.data + input.limit);
    const next = offset.data + input.limit;
    const cursor = next < rows.length ? encodeCursor(next) : null;
    return ok(toolData(page, { total: rows.length, cursor }));
  },
});

export const dockerLogsTool = defineTool({
  name: 'docker_logs',
  title: 'Container logs',
  description:
    'Last lines of one container, filtered by substring. Container stdout and stderr arrive separately: most servers log to stderr, so read both.',
  schema: z.object({
    name: z.string().min(1).max(200).describe('Container name or id'),
    tail: z.number().int().min(1).max(5000).default(100).describe('Lines to ask docker for'),
    since: z.string().max(32).optional().describe('Relative window such as 30m or 2h, or a timestamp'),
    timestamps: z.boolean().default(false).describe('Prefix every line with its timestamp'),
    contains: z.string().max(200).optional().describe('Keep only lines containing this text'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'docker', dockerHint);
    if (!guard.ok) return guard;
    if (!NAME.test(input.name)) {
      return err('E_POLICY', 'invalid container name', 'pass a name or id without leading dashes');
    }
    if (input.since !== undefined && !SINCE.test(input.since)) {
      return err('E_POLICY', 'invalid since value', 'use 30m, 2h, 1d or a timestamp');
    }

    const argv = ['docker', 'logs', '--tail', String(input.tail)];
    if (input.timestamps) argv.push('--timestamps');
    if (input.since !== undefined) argv.push('--since', input.since);
    argv.push(input.name);

    const result = await runCommand(ctx.conn, argv, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: LOG_BYTES,
      allowContainers: true,
    });
    if (!result.ok) return result;

    if (result.data.code !== 0) {
      return { ok: false, error: mapCommandError(result.data.stderr, `docker logs ${input.name} failed`) };
    }

    const needle = input.contains?.toLowerCase();
    const keep = (line: string): boolean => needle === undefined || line.toLowerCase().includes(needle);
    const stdout = splitLines(result.data.stdout).filter(keep);
    const stderr = splitLines(result.data.stderr).filter(keep);
    return ok(
      toolData({
        name: input.name,
        tail: input.tail,
        stdout,
        stderr,
        truncated: result.data.truncated,
      }),
    );
  },
});

export const dockerInspectTool = defineTool({
  name: 'docker_inspect',
  title: 'Inspect a container',
  description:
    'State, restart policy, health, published ports, networks and mounts of one container. Labels and environment values are not returned.',
  schema: z.object({
    name: z.string().min(1).max(200).describe('Container name or id'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'docker', dockerHint);
    if (!guard.ok) return guard;
    if (!NAME.test(input.name)) {
      return err('E_POLICY', 'invalid container name', 'pass a name or id without leading dashes');
    }

    const result = await runCommand(ctx.conn, ['docker', 'inspect', '--format', '{{json .}}', input.name], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: INSPECT_BYTES,
      allowContainers: true,
    });
    if (!result.ok) return result;
    if (result.data.code !== 0) {
      return { ok: false, error: mapCommandError(result.data.stderr, `docker inspect ${input.name} failed`) };
    }

    const summary = parseDockerInspect(result.data.stdout);
    if (summary === null) {
      return err('E_PARSE', 'docker inspect returned no usable container', 'check the name with docker_ps');
    }
    return ok(toolData(summary));
  },
});

export const dockerComposeTool = defineTool({
  name: 'docker_compose',
  title: 'Run a Compose command in a project',
  description:
    'up, down, restart, stop or pull one Compose project from its directory, with two-step confirmation. Only detached `up -d` is used; verify afterwards with docker_ps and docker_logs.',
  schema: z.object({
    dir: z.string().min(1).max(4096).describe('Absolute directory that holds the compose file'),
    action: z.enum(['up', 'down', 'restart', 'stop', 'pull']).describe('What to do'),
    file: z.string().max(64).optional().describe('Compose file name inside dir; detected when omitted'),
    services: z.array(z.string().max(200)).max(20).default([]).describe('Limit the action to these services'),
    build: z.boolean().default(false).describe('Pass --build to up'),
    remove_orphans: z.boolean().default(false).describe('Pass --remove-orphans to up and down'),
    timeout_ms: z.number().int().min(1000).max(300_000).default(120_000).describe('Timeout'),
    dry_run: z.boolean().default(false).describe('Preview without running'),
    token: z.string().max(32).optional().describe('Confirmation token from the preview'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'docker', dockerHint);
    if (!guard.ok) return guard;

    const dir = validateAbsolutePath(input.dir);
    if (!dir.ok) return dir;
    if (dir.data === '/') return err('E_POLICY', 'use the project directory, not /', 'point dir at the app folder');
    if (input.file !== undefined && !FILE.test(input.file)) {
      return err('E_POLICY', 'invalid compose file name', 'pass a file name, not a path');
    }
    for (const service of input.services) {
      if (!NAME.test(service)) {
        return err('E_POLICY', `invalid service name: ${service}`, 'use the service names from the compose file');
      }
    }

    const resolved = await resolveComposeFile(ctx, dir.data, input.file);
    if (!resolved.ok) return resolved;

    const argv = [
      'docker',
      'compose',
      '--project-directory',
      dir.data,
      '-f',
      resolved.data,
      input.action,
    ];
    if (input.action === 'up') {
      argv.push('-d');
      if (input.build) argv.push('--build');
    }
    if (input.remove_orphans && (input.action === 'up' || input.action === 'down')) {
      argv.push('--remove-orphans');
    }
    argv.push(...input.services);

    const preview = {
      dir: dir.data,
      file: resolved.data,
      argv,
      effect: `docker compose ${input.action} in ${dir.data}`,
    };

    return confirmed(ctx, 'docker_compose', input, preview, async () => {
      const started = Date.now();
      const result = await runCommand(ctx.conn, argv, {
        timeoutMs: input.timeout_ms,
        maxBytes: 16_384,
        allowContainers: true,
      });
      const ms = Date.now() - started;
      if (!result.ok) return result;
      const tail = (text: string): string => text.trim().split('\n').slice(-40).join('\n');
      if (result.data.code !== 0) {
        return err(
          'E_INTERNAL',
          `docker compose ${input.action} failed`,
          tail(result.data.stderr) || 'check the compose file and the daemon',
        );
      }
      return ok(
        toolData({
          dir: dir.data,
          action: input.action,
          services: input.services,
          code: result.data.code,
          stdout: tail(result.data.stdout),
          stderr: tail(result.data.stderr),
          truncated: result.data.truncated,
          ms,
        }),
      );
    });
  },
});

/** Detect the compose file in one round trip instead of guessing four times. */
async function resolveComposeFile(
  ctx: ToolContext,
  dir: string,
  file: string | undefined,
): Promise<Result<string>> {
  if (file !== undefined) return ok(`${dir}/${file}`);
  const sections = COMPOSE_FILES.map((candidate, index) => ({
    key: `f${index}`,
    argv: ['test', '-f', `${dir}/${candidate}`],
  }));
  const probe = await runSections(ctx.conn, sections, { timeoutMs: ctx.config.timeoutMs, maxBytes: 4096 });
  if (!probe.ok) return probe;
  const index = COMPOSE_FILES.findIndex((_candidate, position) => probe.data[`f${position}`]?.code === 0);
  if (index < 0) {
    return err(
      'E_NOTFOUND',
      `no compose file in ${dir}`,
      `expected one of ${COMPOSE_FILES.join(', ')}; pass file explicitly`,
    );
  }
  return ok(`${dir}/${COMPOSE_FILES[index]}`);
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');
}
