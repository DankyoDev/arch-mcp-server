import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { defineTool, toolData } from './registry.js';
import { confirmed, MUTATE, runChecked } from './ops.js';

const USER = /^[a-z_][a-z0-9_-]{0,31}$/i;

export const usrPasswordTool = defineTool({
  name: 'usr_password',
  title: "Set a user's password",
  description:
    'Set a password with chpasswd over stdin (never argv). Requires root. Two-step confirmation; the password is not logged.',
  schema: z.object({
    user: z.string().max(32).regex(USER, 'not a valid user name').describe('Existing user'),
    password: z
      .string()
      .min(8)
      .max(256)
      .refine((v) => !v.includes(':') && !v.includes('\n') && !v.includes('\r'), 'password cannot contain ":" or newlines')
      .describe('New password (8–256 chars, no colon or newline)'),
    dry_run: z.boolean().default(false).describe('Preview without changing anything'),
    token: z.string().max(32).optional().describe('Confirmation token from the previous call'),
  }),
  annotations: MUTATE,
  profiles: ['full'],
  handler: async (input, ctx) => {
    const exists = await runChecked(ctx, ['id', '-u', input.user], 1024);
    if (!exists.ok || exists.data.code !== 0) {
      return err('E_NOTFOUND', `user ${input.user} not found`, 'use usr_action to create it first');
    }

    return confirmed(
      ctx,
      'usr_password',
      input as never,
      { user: input.user, action: 'set password' },
      async () => {
        const result = await runCommand(ctx.conn, ['chpasswd'], {
          timeoutMs: ctx.config.timeoutMs,
          maxBytes: 4096,
          input: `${input.user}:${input.password}\n`,
        });
        if (!result.ok) return result;
        if (result.data.code !== 0) {
          return err(
            'E_PERM',
            `cannot set the password for ${input.user}`,
            result.data.stderr.trim() || 'root is required',
          );
        }
        return ok(toolData({ user: input.user, changed: true }));
      },
    );
  },
});
