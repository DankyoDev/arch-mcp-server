import { randomBytes } from 'node:crypto';
import { err, ok } from './core/result.js';
import type { Result } from './core/types.js';
import type { Config } from './config.js';
import type { Connection } from './connection/types.js';
import { checkDenylist } from './policy/denylist.js';
import { runCommand } from './exec/run.js';
import { runSections } from './exec/sequence.js';
import { shellQuote } from './exec/quote.js';

export type JobCommand = 'pkg_update' | 'mkinitcpio' | 'reflector' | 'updatedb' | 'btrfs_scrub';

export interface Job {
  id: string;
  command: JobCommand;
  pid: number;
  logPath: string;
  exitPath: string;
  startedAt: string;
  killed: boolean;
  finished: boolean;
}

const MAX_ACTIVE = 3;

const jobs = new Map<string, Job>();

/** The allowlist (docs/03-tool-catalog.md, job_*): no arbitrary shells. */
export function jobArgv(command: JobCommand, target?: string): string[] | null {
  switch (command) {
    case 'pkg_update':
      return ['pacman', '-Syu', '--noconfirm'];
    case 'mkinitcpio':
      return ['mkinitcpio', '-P'];
    case 'reflector':
      return ['reflector', '--latest', '20', '--sort', 'rate', '--save', '/etc/pacman.d/mirrorlist'];
    case 'updatedb':
      return ['updatedb'];
    case 'btrfs_scrub':
      return target !== undefined && /^\/dev\/[A-Za-z0-9/_.-]{1,100}$/.test(target)
        ? ['btrfs', 'scrub', 'start', target]
        : null;
    default:
      return null;
  }
}

export async function startJob(
  conn: Connection,
  config: Config,
  command: JobCommand,
  target?: string,
): Promise<Result<Job>> {
  const active = [...jobs.values()].filter((job) => !job.killed && !job.finished);
  if (active.length >= MAX_ACTIVE) {
    return err('E_POLICY', `at most ${MAX_ACTIVE} jobs may run at once`, 'wait for one to finish or kill it');
  }

  const argv = jobArgv(command, target);
  if (argv === null) {
    return err('E_POLICY', 'command is not in the job allowlist', 'use pkg_update, mkinitcpio, reflector, updatedb or btrfs_scrub with a device');
  }
  const denied = checkDenylist(argv);
  if (denied !== null) return { ok: false, error: denied };

  const id = randomBytes(4).toString('hex');
  const logPath = `/tmp/arch-mcp-job-${id}.log`;
  const exitPath = `/tmp/arch-mcp-job-${id}.exit`;
  const inner = `${argv.map(shellQuote).join(' ')} ; printf "%s" $? > ${shellQuote(exitPath)}`;
  const script = `nohup sh -c ${shellQuote(inner)} > ${shellQuote(logPath)} 2>&1 & printf "%s" $!`;

  const started = await runCommand(conn, ['sh', '-c', script], {
    timeoutMs: 10_000,
    maxBytes: 4096,
  });
  if (!started.ok) return started;
  const pid = Number(started.data.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return err('E_INTERNAL', 'job did not report a pid', started.data.stderr.trim() || 'check the host logs');
  }

  const job: Job = {
    id,
    command,
    pid,
    logPath,
    exitPath,
    startedAt: new Date().toISOString(),
    killed: false,
    finished: false,
  };
  jobs.set(id, job);
  void config;
  return ok(job);
}

export interface JobStatus {
  job_id: string;
  state: 'running' | 'exited' | 'killed' | 'lost';
  exit_code?: number;
  output: string;
  next_offset: number;
}

export async function jobStatus(
  conn: Connection,
  config: Config,
  id: string,
  offset: number,
): Promise<Result<JobStatus>> {
  const job = jobs.get(id);
  if (job === undefined) return err('E_NOTFOUND', `unknown job ${id}`, 'jobs live in this process only');

  const chunk = Math.min(config.maxBytes, 3000);
  const batch = await runSections(
    conn,
    [
      { key: 'exit', argv: ['cat', job.exitPath] },
      { key: 'alive', argv: ['kill', '-0', String(job.pid)] },
      { key: 'log', argv: ['tail', '-c', `+${offset + 1}`, job.logPath] },
    ],
    { timeoutMs: config.timeoutMs, maxBytes: chunk + 4096 },
  );
  if (!batch.ok) return batch;

  const exitRaw = (batch.data.exit?.stdout ?? '').trim();
  let output = batch.data.log?.stdout ?? '';
  let nextOffset = offset + Buffer.byteLength(output, 'utf8');
  if (output.length > chunk) {
    output = output.slice(0, chunk);
    nextOffset = offset + Buffer.byteLength(output, 'utf8');
  }

  const status: JobStatus = {
    job_id: id,
    state: 'running',
    output,
    next_offset: nextOffset,
  };
  if (exitRaw !== '') {
    status.state = job.killed ? 'killed' : 'exited';
    job.finished = true;
    const code = Number(exitRaw);
    if (Number.isInteger(code)) status.exit_code = code;
  } else if (batch.data.alive?.code !== 0) {
    status.state = job.killed ? 'killed' : 'lost';
    job.finished = true;
  }
  return ok(status);
}

export async function killJob(
  conn: Connection,
  config: Config,
  id: string,
): Promise<Result<{ job_id: string; state: string }>> {
  const job = jobs.get(id);
  if (job === undefined) return err('E_NOTFOUND', `unknown job ${id}`, 'jobs live in this process only');

  void config;
  const killed = await runCommand(conn, ['kill', '-TERM', String(job.pid)], { timeoutMs: 5000 });
  if (!killed.ok) return killed;
  job.killed = true;
  job.finished = true;
  return ok({ job_id: id, state: 'killed' });
}
