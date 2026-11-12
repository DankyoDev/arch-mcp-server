import { z } from 'zod';
import { ok } from '../core/result.js';
import { defineTool, toolData } from './registry.js';
import { READ, runChecked } from './ops.js';

export const usrListTool = defineTool({
  name: 'usr_list',
  title: 'Users and groups',
  description: 'Local accounts (getent passwd) or groups (getent group), filtered by name.',
  schema: z.object({
    type: z.enum(['users', 'groups']).default('users'),
    filter: z.string().max(64).optional().describe('Only names containing this text'),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    if (input.type === 'groups') {
      const result = await runChecked(ctx, ['getent', 'group'], 65_536);
      if (!result.ok) return result;
      const groups = result.data.stdout
        .split('\n')
        .map((line) => line.split(':'))
        .filter((parts) => parts.length >= 4 && parts[0])
        .map((parts) => ({
          name: parts[0] ?? '',
          gid: Number(parts[2] ?? 0),
          members: (parts[3] ?? '').split(',').filter(Boolean).slice(0, 50),
        }))
        .filter((group) => (input.filter ? group.name.includes(input.filter) : true));
      return ok(toolData(groups.slice(0, input.limit), { total: groups.length }));
    }

    const result = await runChecked(ctx, ['getent', 'passwd'], 65_536);
    if (!result.ok) return result;
    const users = result.data.stdout
      .split('\n')
      .map((line) => line.split(':'))
      .filter((parts) => parts.length >= 7 && parts[0])
      .map((parts) => ({
        name: parts[0] ?? '',
        uid: Number(parts[2] ?? 0),
        gid: Number(parts[3] ?? 0),
        home: parts[5] ?? '',
        shell: parts[6] ?? '',
      }))
      .filter((user) => (input.filter ? user.name.includes(input.filter) : true));
    return ok(toolData(users.slice(0, input.limit), { total: users.length }));
  },
});
