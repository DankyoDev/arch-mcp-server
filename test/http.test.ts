import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { HostContext } from '../src/context.js';
import type { Connection, ExecOptions, RawExecResult } from '../src/connection/types.js';
import { isLoopback, startHttpServer } from '../src/http.js';

const BASE_ENV = {
  ARCH_MCP_HOST: '127.0.0.1',
  ARCH_MCP_PORT: '2223',
  ARCH_MCP_USER: 'root',
  ARCH_MCP_KEY: '/tmp/id_test',
};

const TOKEN = 'test-token-with-enough-length';

class NeverCalledConnection implements Connection {
  readonly kind = 'local' as const;
  calls = 0;

  exec(_line: string, _opts?: ExecOptions): Promise<RawExecResult> {
    this.calls += 1;
    return Promise.resolve({
      code: 127,
      stdout: '',
      stderr: 'not available in tests',
      ms: 0,
      timedOut: false,
      truncated: false,
    });
  }

  close(): void {}
}

function context(token?: string): HostContext {
  const config = loadConfig({ ...BASE_ENV, ...(token === undefined ? {} : { ARCH_MCP_HTTP_TOKEN: token }) });
  return new HostContext(new NeverCalledConnection(), config);
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '0' },
    },
  });
}

async function postMcp(port: number, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: initializeBody(),
  });
}

describe('startHttpServer auth', () => {
  it('rejects missing and wrong bearer tokens', async () => {
    const ctx = context();
    const handle = await startHttpServer(ctx, ctx.config, {
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    try {
      const missing = await postMcp(handle.port);
      assert.equal(missing.status, 401);
      assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="arch-mcp"');

      const wrong = await postMcp(handle.port, { authorization: 'Bearer nope-nope-nope-nope' });
      assert.equal(wrong.status, 401);

      const malformed = await postMcp(handle.port, { authorization: `Basic ${TOKEN}` });
      assert.equal(malformed.status, 401);
    } finally {
      await handle.close();
    }
  });

  it('accepts the configured token', async () => {
    const ctx = context();
    const handle = await startHttpServer(ctx, ctx.config, {
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    try {
      const response = await postMcp(handle.port, { authorization: `Bearer ${TOKEN}` });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
      assert.equal(payload.result?.serverInfo?.name, 'arch-mcp');
    } finally {
      await handle.close();
    }
  });

  it('keeps working without a token (localhost default)', async () => {
    const ctx = context();
    const handle = await startHttpServer(ctx, ctx.config, { port: 0, host: '127.0.0.1' });
    try {
      const response = await postMcp(handle.port);
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { result?: { protocolVersion?: string } };
      assert.equal(typeof payload.result?.protocolVersion, 'string');
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for other paths before checking auth', async () => {
    const ctx = context();
    const handle = await startHttpServer(ctx, ctx.config, {
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/other`);
      assert.equal(response.status, 404);
    } finally {
      await handle.close();
    }
  });
});

describe('isLoopback', () => {
  it('recognises loopback spellings', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      assert.equal(isLoopback(host), true, host);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      assert.equal(isLoopback(host), false, host);
    }
  });
});
