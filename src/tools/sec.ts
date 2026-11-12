import { z } from 'zod';
import { err, ok } from '../core/result.js';
import { sanitizeOutput } from '../core/format.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import type { SectionSpec } from '../exec/sequence.js';
import { parseIptablesRules, parseNftRuleset, parseSshdT } from '../parse/net.js';
import type { FirewallSummary } from '../parse/net.js';
import { parseLast } from '../parse/usr.js';
import { parsePacmanQu } from '../parse/pacman.js';
import { defineTool, toolData } from './registry.js';
import { requireFeature } from './guards.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const secAuditTool = defineTool({
  name: 'sec_audit',
  title: 'Security posture',
  description:
    'Basic posture: SSH root login and password auth, firewall state, world-writable files in /etc, failed logins and pending updates.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;
    const features = capabilities.data.features;

    const sections: SectionSpec[] = [];
    if (features.sshd === true) sections.push({ key: 'sshd', argv: ['sshd', '-T'] });
    if (features.nftables === true) sections.push({ key: 'nft', argv: ['nft', '-j', 'list', 'ruleset'] });
    else if (features.iptables === true) sections.push({ key: 'iptables', argv: ['iptables', '-S'] });
    sections.push({
      key: 'world',
      argv: ['find', '/etc', '-xdev', '-type', 'f', '-perm', '-0002', '-printf', '%p\n'],
    });
    sections.push({ key: 'failures', argv: ['lastb', '-n', '20'] });
    if (features.pacman === true) sections.push({ key: 'updates', argv: ['pacman', '-Qu'] });

    const batch = await runSections(ctx.conn, sections, {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!batch.ok) return batch;

    const data: Record<string, unknown> = {};
    const sshd = parseSshdT(batch.data.sshd?.stdout ?? '');
    if (sshd.size > 0) {
      data.ssh_root_login = sshd.get('permitrootlogin') ?? 'unknown';
      data.password_auth = (sshd.get('passwordauthentication') ?? 'unknown') === 'yes';
    }

    const firewall = firewallSummary(
      batch.data.nft?.stdout,
      batch.data.iptables?.stdout,
    );
    if (firewall !== undefined) data.firewall = firewall;

    const world = (batch.data.world?.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'));
    const failedLogins = parseLast(batch.data.failures?.stdout ?? '').filter(
      (entry) => !entry.tty.startsWith('system'),
    );
    return ok(
      toolData({
        ...data,
        world_writable: world.slice(0, 10),
        failed_logins: failedLogins.length,
        ...(features.pacman === true
          ? { updates: parsePacmanQu(batch.data.updates?.stdout ?? '').length }
          : {}),
      }),
    );
  },
});

export const secSshConfigTool = defineTool({
  name: 'sec_ssh_config',
  title: 'Effective sshd setting',
  description:
    'One effective sshd setting as reported by sshd -T, e.g. permitrootlogin or passwordauthentication. Use it to confirm hardening.',
  schema: z.object({
    key: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9]+$/, 'expected a lowercase sshd keyword')
      .describe('sshd keyword, e.g. permitrootlogin'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'sshd', 'install openssh');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['sshd', '-T'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 262_144,
    });
    if (!result.ok) return result;
    if (result.data.code !== 0) {
      return err('E_PERM', 'sshd -T failed', sanitizeOutput(result.data.stderr).trim() || 'requires root');
    }

    const config = parseSshdT(result.data.stdout);
    const value = config.get(input.key);
    if (value === undefined) {
      return err('E_NOTFOUND', `sshd has no setting named ${input.key}`, 'check the sshd_config manual');
    }
    return ok(toolData({ key: input.key, value }));
  },
});

function firewallSummary(
  nft: string | undefined,
  iptables: string | undefined,
): FirewallSummary | undefined {
  if (nft !== undefined) return parseNftRuleset(nft);
  if (iptables !== undefined) return parseIptablesRules(iptables);
  return undefined;
}
