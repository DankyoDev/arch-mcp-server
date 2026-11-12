import { z } from 'zod';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { confirmed, MUTATE, runChecked } from './ops.js';

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const UNIT_DIR = '/etc/systemd/system/';

async function writeUnit(ctx: ToolContext, path: string, content: string): Promise<Result<true>> {
  const written = await runCommand(ctx.conn, ['sh', '-c', 'cat > "$1"', '_', path], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 4096,
    input: content,
  });
  if (!written.ok) return written;
  if (written.data.code !== 0) {
    return err('E_PERM', `cannot write ${path}`, written.data.stderr.trim() || 'root is required');
  }
  return ok(true);
}

async function validateSchedule(ctx: ToolContext, schedule: string): Promise<Result<string | null>> {
  const result = await runCommand(ctx.conn, ['systemd-analyze', 'calendar', schedule], {
    timeoutMs: ctx.config.timeoutMs,
    maxBytes: 16_384,
  });
  if (!result.ok) return result;
  if (result.data.code !== 0) {
    return err(
      'E_POLICY',
      `invalid OnCalendar expression: ${schedule}`,
      (result.data.stderr.trim().split('\n')[0] ?? 'see systemd.time(7)').slice(0, 200),
    );
  }
  const match = /Next elapse:\s*(.+)/.exec(result.data.stdout);
  return ok(match?.[1]?.trim() ?? null);
}

export const svcTimerSetTool = defineTool({
  name: 'svc_timer_set',
  title: 'Create or replace a systemd timer',
  description:
    'Write the <name>.service + <name>.timer pair with a validated OnCalendar, daemon-reload and enable it. Two-step confirmation.',
  schema: z.object({
    name: z
      .string()
      .max(64)
      .regex(NAME, 'use letters, digits, dot, dash or underscore')
      .describe('Base name without extension, e.g. backup'),
    schedule: z
      .string()
      .min(1)
      .max(120)
      .describe('OnCalendar expression, e.g. "daily", "*-*-* 03:00:00", "Mon *-*-* 04:00"'),
    command: z
      .string()
      .min(1)
      .max(1000)
      .refine((v) => !v.includes('\n') && !v.includes('\r'), 'ExecStart must be a single line')
      .describe('Command the service runs (absolute path, single line)'),
    description: z.string().max(200).optional().describe('Description for the service unit'),
    enable: z.boolean().default(true).describe('systemctl enable --now the timer'),
    dry_run: z.boolean().default(false).describe('Preview without writing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const servicePath = `${UNIT_DIR}${input.name}.service`;
    const timerPath = `${UNIT_DIR}${input.name}.timer`;
    const description = input.description ?? `Timer ${input.name}`;

    const service = [
      '[Unit]',
      `Description=${description}`,
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${input.command}`,
      '',
    ].join('\n');

    const timer = [
      '[Unit]',
      `Description=${description}`,
      '',
      '[Timer]',
      `OnCalendar=${input.schedule}`,
      'Persistent=true',
      `Unit=${input.name}.service`,
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n');

    const next = await validateSchedule(ctx, input.schedule);
    if (!next.ok) return next;

    const preview = {
      service: servicePath,
      timer: timerPath,
      schedule: input.schedule,
      next_elapse: next.data,
      command: input.command,
      enable: input.enable,
    };

    return confirmed(ctx, 'svc_timer_set', input as never, preview, async () => {
      const serviceWritten = await writeUnit(ctx, servicePath, service);
      if (!serviceWritten.ok) return serviceWritten;
      const timerWritten = await writeUnit(ctx, timerPath, timer);
      if (!timerWritten.ok) return timerWritten;

      const reload = await runChecked(ctx, ['systemctl', 'daemon-reload']);
      if (!reload.ok) return reload;

      if (input.enable) {
        const enabled = await runChecked(ctx, ['systemctl', 'enable', '--now', `${input.name}.timer`]);
        if (!enabled.ok) return enabled;
      }

      return ok(
        toolData({
          service: servicePath,
          timer: timerPath,
          schedule: input.schedule,
          next_elapse: next.data,
          enabled: input.enable,
        }),
      );
    });
  },
});
