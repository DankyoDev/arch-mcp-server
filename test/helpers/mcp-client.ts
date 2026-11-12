import { spawn } from 'node:child_process';

export interface ToolEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
  meta?: { ms?: number; truncated?: boolean };
}

export interface McpClient {
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolEnvelope>;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
}

/** Minimal MCP stdio client for evals: no SDK, no network beyond the server. */
export async function startMcp(env: NodeJS.ProcessEnv, entry = 'dist/index.js'): Promise<McpClient> {
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });

  let buffer = '';
  const pending = new Map<number, Pending>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)?.resolve(message.error ?? message.result);
        pending.delete(message.id);
      }
    }
  });

  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve) => pending.set(id, { resolve }));
  };

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'eval', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    async listTools() {
      const result = (await request('tools/list', {})) as { tools?: Array<{ name: string }> };
      return (result.tools ?? []).map((tool) => tool.name);
    },
    async call(name, args) {
      const result = (await request('tools/call', { name, arguments: args })) as {
        structuredContent?: ToolEnvelope;
        isError?: boolean;
      };
      return result.structuredContent ?? { ok: false, error: { code: 'E_INTERNAL', message: 'no content' } };
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
