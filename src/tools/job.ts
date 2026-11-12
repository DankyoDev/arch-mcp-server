import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { jobArgv, jobStatus, killJob, startJob } from '../jobs.js';
import type { JobCommand } from '../jobs.js';
import { createConfirmation, consumeConfirmation } from '../policy/confirm.js';
import { defineTool, toolData } from './registry.js';

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
  openWorldHint: false,
};

const COMMANDS = ['pkg_update', 'mkinitcpio', 'reflector', 'updatedb', 'btrfs_scrub'] as const;

export const jobStartTool = defineTool({
  name: 'job_start',
  title: 'Start a long job',
  description:
    'Start one allowlisted long command (package update, mkinitcpio, reflector, updatedb, btrfs scrub) and return a job_id. Poll it with job_status.',
  schema: z.object({
    command: z.enum(COMMANDS).describe('Allowlisted job'),
    target: z.string().max(120).optional().describe('Device for btrfs_scrub'),
    dry_run: z.boolean().default(false).describe('Show the resolved argv without running'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const argv = jobArgv(input.command as JobCommand, input.target);
    if (argv === null) {
      return err('E_POLICY', 'job needs a valid target', 'btrfs_scrub requires /dev/<device>');
    }
    if (input.dry_run) {
      return ok(toolData({ command: input.command, argv, result: 'dry_run' }));
    }
    if (input.token === undefined) {
      const confirmation = createConfirmation('job_start', input as unknown as Record<string, unknown>, ctx.config.confirmTtl);
      return err('E_CONFIRM', 'confirmation required', 'repeat the call with token', {
        token: confirmation.token,
        expires_in_s: confirmation.expiresInS,
        preview: { command: input.command, argv, effect: 'runs in the background on the host' },
      });
    }
    const consumed = consumeConfirmation(input.token, 'job_start', input as unknown as Record<string, unknown>);
    if (!consumed.ok) return consumed;

    const started = await startJob(ctx.conn, ctx.config, input.command as JobCommand, input.target);
    if (!started.ok) return started;
    return ok(
      toolData({
        job_id: started.data.id,
        command: started.data.command,
        started: started.data.startedAt,
      }),
    );
  },
});

export const jobStatusTool = defineTool({
  name: 'job_status',
  title: 'Job status',
  description:
    'State, exit code and incremental output of a job. Pass next_offset as offset to read only the new output.',
  schema: z.object({
    job_id: z.string().regex(/^[0-9a-f]{8}$/, 'expected an 8 hex job id').describe('Job id'),
    offset: z.number().int().min(0).max(10_000_000).default(0).describe('Byte offset to continue from'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const status = await jobStatus(ctx.conn, ctx.config, input.job_id, input.offset);
    if (!status.ok) return status;
    return ok(toolData(status.data));
  },
});

export const jobKillTool = defineTool({
  name: 'job_kill',
  title: 'Stop a job',
  description: 'Send SIGTERM to a running job after confirmation. Output already produced is kept.',
  schema: z.object({
    job_id: z.string().regex(/^[0-9a-f]{8}$/, 'expected an 8 hex job id').describe('Job id'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    if (input.token === undefined) {
      const confirmation = createConfirmation('job_kill', input as unknown as Record<string, unknown>, ctx.config.confirmTtl);
      return err('E_CONFIRM', 'confirmation required', 'repeat the call with token', {
        token: confirmation.token,
        expires_in_s: confirmation.expiresInS,
        preview: { job_id: input.job_id, effect: 'the job receives SIGTERM' },
      });
    }
    const consumed = consumeConfirmation(input.token, 'job_kill', input as unknown as Record<string, unknown>);
    if (!consumed.ok) return consumed;
    const killed = await killJob(ctx.conn, ctx.config, input.job_id);
    if (!killed.ok) return killed;
    return ok(toolData(killed.data));
  },
});
