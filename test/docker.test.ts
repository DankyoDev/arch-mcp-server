import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { HostCapabilities } from '../src/caps.js';
import { loadConfig } from '../src/config.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { ok } from '../src/core/result.js';
import { parseDockerInspect, parseDockerPs } from '../src/parse/docker.js';
import { checkDenylist } from '../src/policy/denylist.js';
import { resetConfirmations } from '../src/policy/confirm.js';
import { dockerComposeTool, dockerInspectTool, dockerLogsTool, dockerPsTool } from '../src/tools/docker.js';
import type { ToolContext } from '../src/tools/registry.js';
import { isPreview, tokenOf } from './confirmation.js';

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

class ScriptedConnection implements Connection {
  readonly kind = 'local' as const;
  readonly calls: string[] = [];

  constructor(private readonly respond: (line: string) => Reply) {}

  async exec(line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls.push(line);
    const reply = this.respond(line);
    return {
      code: reply.code ?? 0,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      ms: 1,
      timedOut: false,
      truncated: false,
    };
  }

  close(): void {}
}

const capabilities: HostCapabilities = {
  os: { id: 'arch', name: 'Arch Linux' },
  kernel: '7.0',
  arch: 'x86_64',
  tools: { docker: '/usr/bin/docker' },
  features: { docker: true },
};

function context(conn: Connection, env: Record<string, string> = {}): ToolContext {
  const config = loadConfig({ ARCH_MCP_HOST: 'test', ARCH_MCP_USER: 'dante', ...env });
  return { conn, config, capabilities: async () => ok(capabilities) };
}

/** One `docker ps --format '{{json .}}'` line. */
function psLine(name: string, state: string, labels: string, ports = ''): string {
  return JSON.stringify({
    Command: '"/start"',
    CreatedAt: '2026-11-12 22:00:00 +0000 UTC',
    ID: `${name}-id-0123456789abcdef`,
    Image: 'mindustry:latest',
    Labels: labels,
    State: state,
    Status: state === 'running' ? 'Up 2 hours (healthy)' : 'Exited (0) 3 hours ago',
    Names: name,
    Ports: ports,
  });
}

const composeLabels = 'com.docker.compose.project=mindustry,com.docker.compose.service=server';

describe('docker parsers', () => {
  it('reads ps lines and compose labels', () => {
    const rows = parseDockerPs(
      [
        psLine('mindustry', 'running', composeLabels, '0.0.0.0:30000->6567/tcp'),
        psLine('manual', 'exited', ''),
        'not json',
      ].join('\n'),
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      name: 'manual',
      id: 'manual-id-01',
      image: 'mindustry:latest',
      state: 'exited',
      status: 'Exited (0) 3 hours ago',
      ports: '',
    });
    assert.equal(rows[1]?.project, 'mindustry');
    assert.equal(rows[1]?.service, 'server');
    assert.equal(rows[1]?.health, 'healthy');
    assert.equal(rows[1]?.ports, '0.0.0.0:30000->6567/tcp');
  });

  it('reduces inspect output without labels or environment values', () => {
    const raw = {
      Id: 'abcdef0123456789',
      Name: '/mindustry',
      RestartCount: 2,
      Config: {
        Image: 'mindustry:latest',
        Env: ['SECRET_TOKEN=hunter2', 'TZ=UTC'],
        Labels: { 'com.docker.compose.project': 'mindustry', 'com.docker.compose.service': 'server' },
      },
      State: {
        Status: 'running',
        Running: true,
        Pid: 4242,
        ExitCode: 0,
        StartedAt: '2026-11-12T22:00:00Z',
        Health: { Status: 'healthy' },
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Privileged: false },
      Mounts: [{ Type: 'bind', Source: '/home/dante/docker/apps/mindustry/config', Destination: '/config', RW: true }],
      NetworkSettings: {
        Ports: { '6567/tcp': [{ HostIp: '0.0.0.0', HostPort: '30000' }] },
        Networks: { internal: { IPAddress: '10.10.0.9' }, 'traefik-net': { IPAddress: '10.10.1.9' } },
      },
    };
    const summary = parseDockerInspect(JSON.stringify(raw));
    assert.ok(summary !== null);
    assert.equal(summary.name, 'mindustry');
    assert.equal(summary.state, 'running');
    assert.equal(summary.health, 'healthy');
    assert.equal(summary.restart_policy, 'unless-stopped');
    assert.equal(summary.compose_project, 'mindustry');
    assert.deepEqual(summary.ports, { '6567/tcp': '30000' });
    assert.deepEqual(summary.networks, ['internal', 'traefik-net']);
    assert.equal(summary.env_count, 2);
    assert.equal(summary.mounts[0]?.destination, '/config');
    assert.ok(!JSON.stringify(summary).includes('hunter2'));
  });

  it('returns null for garbage', () => {
    assert.equal(parseDockerInspect('Error: no such object'), null);
    assert.deepEqual(parseDockerPs(''), []);
  });
});

describe('docker denylist', () => {
  it('keeps containers out of exec but allows the native tools', () => {
    const blocked = checkDenylist(['docker', 'compose', 'up', '-d']);
    assert.ok(blocked !== null);
    if (blocked !== null) assert.equal((blocked.data as { rule: string }).rule, 'containers');
    assert.equal(checkDenylist(['docker', 'compose', 'up', '-d'], { allowContainers: true }), null);
  });

  it('still refuses privileged flags even for the native path', () => {
    const denied = checkDenylist(['docker', 'run', '--privileged', 'x'], { allowContainers: true });
    assert.ok(denied !== null);
    if (denied !== null) assert.equal((denied.data as { rule: string }).rule, 'container-flags');
  });
});

describe('docker tools', () => {
  beforeEach(() => resetConfirmations());

  it('lists containers and filters by project', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: [psLine('mindustry', 'running', composeLabels), psLine('other', 'running', '')].join('\n'),
    }));
    const result = await dockerPsTool.handler(
      { all: true, project: 'mindustry', limit: 50 },
      context(conn),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as Promise<unknown>;
    assert.equal((data as unknown as Array<unknown>).length, 1);
    assert.ok(conn.calls[0]?.includes('docker ps -a --format'));
  });

  it('paginates with a cursor', async () => {
    const lines = Array.from({ length: 3 }, (_item, index) =>
      psLine(`app${index}`, 'running', '').replace('{{', '{'),
    ).join('\n');
    const conn = new ScriptedConnection(() => ({ stdout: lines }));
    const first = await dockerPsTool.handler({ all: true, limit: 2 }, context(conn));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.data.total, 3);
    assert.ok(typeof first.data.cursor === 'string');
    const second = await dockerPsTool.handler({ all: true, limit: 2, cursor: first.data.cursor ?? undefined }, context(conn));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal((second.data.data as unknown[]).length, 1);
  });

  it('filters logs by substring and keeps both streams', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: 'level=info ready\nlevel=info tick\n',
      stderr: 'level=error boom\n',
    }));
    const result = await dockerLogsTool.handler(
      { name: 'mindustry', tail: 100, timestamps: false, contains: 'level' },
      context(conn),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { stdout: string[]; stderr: string[] };
    assert.deepEqual(data.stdout, ['level=info ready', 'level=info tick']);
    assert.deepEqual(data.stderr, ['level=error boom']);
  });

  it('rejects names and windows that could become flags', async () => {
    const bad = await dockerLogsTool.handler(
      { name: '--all', tail: 10, timestamps: false },
      context(new ScriptedConnection(() => ({}))),
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, 'E_POLICY');

    const since = await dockerLogsTool.handler(
      { name: 'app', tail: 10, timestamps: false, since: '; rm -rf /' },
      context(new ScriptedConnection(() => ({}))),
    );
    assert.equal(since.ok, false);
    if (!since.ok) assert.equal(since.error.code, 'E_POLICY');
  });

  it('reports a missing container instead of an empty log', async () => {
    const conn = new ScriptedConnection(() => ({ code: 1, stderr: 'Error: No such container: ghost' }));
    const result = await dockerLogsTool.handler({ name: 'ghost', tail: 10, timestamps: false }, context(conn));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('inspects one container', async () => {    const conn = new ScriptedConnection(() => ({
      stdout: `${JSON.stringify({ Name: '/app', Id: 'deadbeefdeadbeef', Config: { Image: 'nginx:1.27' }, State: { Status: 'running', Running: true }, HostConfig: {}, NetworkSettings: {} })}\n`,
    }));
    const result = await dockerInspectTool.handler({ name: 'app' }, context(conn));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data.data as { image: string; running: boolean };
    assert.equal(data.image, 'nginx:1.27');
    assert.equal(data.running, true);
    assert.ok(conn.calls[0]?.includes('docker inspect --format'));
  });

  it('previews compose, detects the file and then applies with the token', async () => {
    const conn = new ScriptedConnection((line) => {
      if (line.includes('test -f')) {
        // compose.yaml missing, compose.yml present
        return {
          stdout: `\u001e0\n\u001f1\n\u001e1\n\u001f0\n\u001e2\n\u001f1\n\u001e3\n\u001f1\n`,
        };
      }
      return { stdout: ' Container mindustry  Started\n' };
    });
    const ctx = context(conn);
    const input = {
      dir: '/home/dante/docker/apps/mindustry',
      action: 'up' as const,
      services: ['server'],
      build: false,
      remove_orphans: false,
      timeout_ms: 120_000,
      dry_run: false,
    };

    const preview = await dockerComposeTool.handler({ ...input, dry_run: true }, ctx);
    assert.equal(isPreview(preview), true);
    // The preview carries a token that also authorizes the real call.
    const token = tokenOf(preview);
    assert.equal(token.length, 8);

    const applied = await dockerComposeTool.handler({ ...input, token }, ctx);
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    const data = applied.data.data as { action: string; dir: string };
    assert.equal(data.action, 'up');
    assert.equal(data.dir, '/home/dante/docker/apps/mindustry');
    const composeCall = conn.calls.find((line) => line.includes('docker compose'));
    assert.ok(composeCall !== undefined);
    assert.ok(composeCall.includes('-f /home/dante/docker/apps/mindustry/compose.yml'));
    assert.ok(composeCall.includes('up -d server'));
  });

  it('reports a missing compose file instead of guessing', async () => {
    const conn = new ScriptedConnection(() => ({
      stdout: `\u001e0\n\u001f1\n\u001e1\n\u001f1\n\u001e2\n\u001f1\n\u001e3\n\u001f1\n`,
    }));
    const result = await dockerComposeTool.handler(
      { dir: '/home/dante/docker/apps/nothing', action: 'up', services: [], build: false, remove_orphans: false, timeout_ms: 1000, dry_run: false },
      context(conn),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_NOTFOUND');
  });

  it('refuses / and path traversal in the project directory', async () => {
    const conn = new ScriptedConnection(() => ({}));
    const root = await dockerComposeTool.handler(
      { dir: '/', action: 'up', services: [], build: false, remove_orphans: false, timeout_ms: 1000, dry_run: true },
      context(conn),
    );
    assert.equal(root.ok, false);
    if (!root.ok) assert.equal(root.error.code, 'E_POLICY');

    const relative = await dockerComposeTool.handler(
      { dir: 'apps/mindustry', action: 'up', services: [], build: false, remove_orphans: false, timeout_ms: 1000, dry_run: true },
      context(conn),
    );
    assert.equal(relative.ok, false);
  });
});
