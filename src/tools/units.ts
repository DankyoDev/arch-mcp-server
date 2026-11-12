import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import { confirmed, MUTATE, runChecked } from './ops.js';

const UNIT = /^[A-Za-z0-9@:._-]{1,180}\.(service|timer|socket|mount|path)$/;
const UNIT_DIR = '/etc/systemd/system/';

function unitPath(unit: string): string | null {
  if (!UNIT.test(unit)) return null;
  return `${UNIT_DIR}${unit}`;
}

export const svcUnitWriteTool = defineTool({
  name: 'svc_unit_write',
  title: 'Create or replace a systemd unit',
  description:
    'Write a unit under /etc/systemd/system, daemon-reload and optionally enable it. Two-step confirmation.',
  schema: z.object({
    unit: z.string().max(180).describe('Unit name ending in .service/.timer/.socket/...'),
    content: z.string().min(1).max(32_768).describe('Full unit file content'),
    enable: z.boolean().default(false).describe('systemctl enable after writing'),
    dry_run: z.boolean().default(false).describe('Preview without writing'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = unitPath(input.unit);
    if (path === null) {
      return err('E_POLICY', 'invalid unit name', 'use name.service, name.timer, name.socket, name.mount or name.path');
    }
    return confirmed(
      ctx,
      'svc_unit_write',
      input as never,
      { unit: input.unit, path, bytes: Buffer.byteLength(input.content), enable: input.enable },
      async () => {
        const written = await runCommand(ctx.conn, ['sh', '-c', 'cat > "$1"', '_', path], {
          timeoutMs: ctx.config.timeoutMs,
          maxBytes: 4096,
          input: input.content,
        });
        if (!written.ok) return written;
        if (written.data.code !== 0) {
          return err('E_PERM', `cannot write ${path}`, written.data.stderr.trim() || 'root is required');
        }
        const reload = await runChecked(ctx, ['systemctl', 'daemon-reload']);
        if (!reload.ok) return reload;
        if (input.enable) {
          const enabled = await runChecked(ctx, ['systemctl', 'enable', input.unit]);
          if (!enabled.ok) return enabled;
        }
        return ok(toolData({ unit: input.unit, path, enabled: input.enable }));
      },
    );
  },
});

export const svcUnitDeleteTool = defineTool({
  name: 'svc_unit_delete',
  title: 'Delete a systemd unit',
  description:
    'Disable and delete a unit under /etc/systemd/system, then daemon-reload. Two-step confirmation.',
  schema: z.object({
    unit: z.string().max(180).describe('Unit name ending in .service/.timer/.socket/...'),
    dry_run: z.boolean().default(false).describe('Preview without deleting'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const path = unitPath(input.unit);
    if (path === null) {
      return err('E_POLICY', 'invalid unit name', 'use name.service, name.timer, name.socket, name.mount or name.path');
    }
    return confirmed(ctx, 'svc_unit_delete', input as never, { unit: input.unit, path }, async () => {
      await runChecked(ctx, ['systemctl', 'disable', input.unit]);
      const removed = await runChecked(ctx, ['rm', '-f', path]);
      if (!removed.ok) return removed;
      const reload = await runChecked(ctx, ['systemctl', 'daemon-reload']);
      if (!reload.ok) return reload;
      return ok(toolData({ unit: input.unit, deleted: true }));
    });
  },
});
