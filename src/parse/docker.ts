/**
 * Parsers for the Docker CLI JSON output. Everything is defensive: a container
 * that prints junk never breaks a tool, it just drops the line.
 */

export interface DockerContainer {
  name: string;
  id: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  project?: string;
  service?: string;
  health?: string;
}

export interface DockerMount {
  type: string;
  source: string;
  destination: string;
  rw: boolean;
}

export interface DockerInspectSummary {
  name: string;
  id: string;
  image: string;
  state: string;
  running: boolean;
  restart_policy: string;
  restart_count: number;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  health?: string;
  pid?: number;
  privileged: boolean;
  ports: Record<string, string>;
  networks: string[];
  mounts: DockerMount[];
  env_count: number;
  compose_project?: string;
  compose_service?: string;
}

/** `docker ps --format '{{json .}}'` emits one flat object per line. */
export function parseDockerPs(stdout: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('{') === false) continue;
    const raw = safeParse(text);
    if (raw === null) continue;
    const name = str(raw.Names);
    if (name === '') continue;
    const status = str(raw.Status);
    const labels = str(raw.Labels);
    const project = labelValue(labels, 'com.docker.compose.project');
    const service = labelValue(labels, 'com.docker.compose.service');
    const container: DockerContainer = {
      name,
      id: str(raw.ID).slice(0, 12),
      image: str(raw.Image),
      state: str(raw.State),
      status,
      ports: str(raw.Ports),
    };
    if (project !== null) container.project = project;
    if (service !== null) container.service = service;
    const health = /\(([a-z]+)\)/.exec(status)?.[1];
    if (health !== undefined && ['healthy', 'unhealthy', 'starting'].includes(health)) {
      container.health = health;
    }
    containers.push(container);
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

/** `docker inspect --format '{{json .}}' NAME`, reduced to what is useful. */
export function parseDockerInspect(stdout: string): DockerInspectSummary | null {
  const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'));
  if (line === undefined) return null;
  const raw = safeParse(line.trim());
  if (raw === null) return null;

  const state = obj(raw.State);
  const config = obj(raw.Config);
  const hostConfig = obj(raw.HostConfig);
  const networkSettings = obj(raw.NetworkSettings);

  const summary: DockerInspectSummary = {
    name: str(raw.Name).replace(/^\//, ''),
    id: str(raw.Id).slice(0, 12),
    image: str(config.Image),
    state: str(state.Status),
    running: state.Running === true,
    restart_policy: str(obj(hostConfig.RestartPolicy).Name),
    restart_count: num(raw.RestartCount),
    privileged: hostConfig.Privileged === true,
    ports: flattenPorts(obj(networkSettings.Ports)),
    networks: Object.keys(obj(networkSettings.Networks)).sort(),
    mounts: flattenMounts(raw.Mounts),
    env_count: Array.isArray(config.Env) ? config.Env.length : 0,
  };

  const health = str(obj(state.Health).Status);
  if (health !== '') summary.health = health;
  if (typeof state.StartedAt === 'string' && state.StartedAt !== '') summary.started_at = state.StartedAt;
  if (typeof state.FinishedAt === 'string' && state.FinishedAt !== '') summary.finished_at = state.FinishedAt;
  if (typeof state.ExitCode === 'number') summary.exit_code = state.ExitCode;
  if (typeof state.Pid === 'number' && state.Pid > 0) summary.pid = state.Pid;
  const project = labelOf(config.Labels, 'com.docker.compose.project');
  if (project !== null) summary.compose_project = project;
  const service = labelOf(config.Labels, 'com.docker.compose.service');
  if (service !== null) summary.compose_service = service;
  // Label and environment values stay out of the response: they often carry secrets.
  return summary;
}

function flattenPorts(ports: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (!Array.isArray(bindings) || bindings.length === 0) continue;
    const hostPorts = bindings
      .map((binding) => str(obj(binding).HostPort))
      .filter((port) => port !== '');
    if (hostPorts.length > 0) result[containerPort] = [...new Set(hostPorts)].join(',');
    else result[containerPort] = 'unpublished';
  }
  return result;
}

function flattenMounts(value: unknown): DockerMount[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((entry) => {
    const mount = obj(entry);
    return {
      type: str(mount.Type),
      source: str(mount.Source),
      destination: str(mount.Destination),
      rw: mount.RW !== false,
    };
  });
}

/** Compose labels travel as `k=v,k=v` in one field. */
export function labelValue(labels: string, key: string): string | null {
  for (const pair of labels.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    if (pair.slice(0, at) === key) return pair.slice(at + 1);
  }
  return null;
}

/** `docker inspect` returns labels as an object instead. */
function labelOf(labels: unknown, key: string): string | null {
  const value = obj(labels)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function obj(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
