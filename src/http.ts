import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { ToolContext } from './tools/registry.js';

export interface HttpOptions {
  port: number;
  host: string;
  /** Optional bearer token. Without it the transport is unauthenticated. */
  token?: string;
}

export interface HttpHandle {
  /** Real listening port (useful when options.port is 0 in tests). */
  port: number;
  close(): Promise<void>;
}

/**
 * Optional HTTP transport (phase 6). Stateless: one server per request, so
 * several clients can share the same SSH connection safely.
 */
export async function startHttpServer(
  ctx: ToolContext,
  config: Config,
  options: HttpOptions,
): Promise<HttpHandle> {
  const token = options.token !== undefined && options.token.trim() !== '' ? options.token : undefined;
  const httpServer = createServer((req, res) => {
    void handle(req, res, ctx, config, token);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const auth = token === undefined ? '' : ' (bearer auth)';
  process.stderr.write(`arch-mcp http listening on http://${options.host}:${port}/mcp${auth}\n`);
  if (token === undefined && !isLoopback(options.host)) {
    process.stderr.write(
      'arch-mcp: warning: HTTP has no authentication; set ARCH_MCP_HTTP_TOKEN or keep it on localhost\n',
    );
  }

  return {
    port,
    close: async () => {
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ToolContext,
  config: Config,
  token: string | undefined,
): Promise<void> {
  if ((req.url ?? '') !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
    return;
  }

  if (token !== undefined && !isAuthorized(req, token)) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="arch-mcp"',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const server = buildServer(ctx, config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    process.stderr.write(
      `arch-mcp: http error: ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error\n');
  }
}

/** `Authorization: Bearer <token>`, compared in constant time. */
function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const provided = match[1];
  if (provided === undefined) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
