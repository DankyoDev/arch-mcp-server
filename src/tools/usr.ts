import { z } from 'zod';
import { ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import { parseLast, parseLoginctlSessions } from '../parse/usr.js';
import { defineTool, toolData } from './registry.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const usrSessionsTool = defineTool({
  name: 'usr_sessions',
  title: 'Active sessions',
  description:
    'Logged-in sessions with user, TTY and seat. Empty when logind is unavailable (containers).',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const result = await runCommand(ctx.conn, ['loginctl', 'list-sessions', '--no-pager'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;
    // logind is masked in containers: an empty answer is valid, not an error.
    return ok(toolData(parseLoginctlSessions(result.data.stdout)));
  },
});

export const usrLoginsTool = defineTool({
  name: 'usr_logins',
  title: 'Login history',
  description:
    'Recent successful and failed logins from wtmp/btmp. Use it to check who has been on the host.',
  schema: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe('Entries per list'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const batch = await runSections(
      ctx.conn,
      [
        { key: 'ok', argv: ['last', '-F', '-n', String(input.limit)] },
        { key: 'failed', argv: ['lastb', '-n', String(input.limit)] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!batch.ok) return batch;

    const okLogins = parseLast(batch.data.ok?.stdout ?? '').filter(
      (entry) => !entry.tty.startsWith('system'),
    );
    const failed = parseLast(batch.data.failed?.stdout ?? '').filter(
      (entry) => !entry.tty.startsWith('system'),
    );
    return ok(toolData({ ok: okLogins, failed }));
  },
});
