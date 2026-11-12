#!/usr/bin/env node
import { PassThrough, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs, usage } from './cli.js';
import { hostLabel, loadConfigDetailed } from './config.js';
import { createConnection } from './connection/index.js';
import { HostContext } from './context.js';
import { startHttpServer } from './http.js';
import { buildServer, VERSION } from './server.js';
import { allTools } from './tools/index.js';
import { toolsForProfile } from './tools/registry.js';
import { toolRuntime } from './tools/runtime.js';

async function main(): Promise<void> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`arch-mcp: ${error instanceof Error ? error.message : 'bad arguments'}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stderr.write(`${usage()}\n`);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const loaded = (() => {
    try {
      return loadConfigDetailed();
    } catch (error) {
      process.stderr.write(`arch-mcp: ${error instanceof Error ? error.message : 'bad configuration'}\n`);
      return null;
    }
  })();
  if (loaded === null) {
    process.exitCode = 1;
    return;
  }

  const { config, warnings } = loaded;
  for (const warning of warnings) process.stderr.write(`arch-mcp: warning: ${warning}\n`);

  const conn = createConnection(config);
  const ctx = new HostContext(conn, config);

  if (options.http === true || process.env.ARCH_MCP_HTTP_PORT !== undefined) {
    const port = options.port ?? Number(process.env.ARCH_MCP_HTTP_PORT ?? 3333);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write('arch-mcp: invalid HTTP port\n');
      process.exitCode = 1;
      return;
    }
    const host = options.host ?? process.env.ARCH_MCP_HTTP_HOST ?? '127.0.0.1';
    await startHttpServer(ctx, config, { port, host, token: config.httpToken });
    const stop = (): void => {
      conn.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  const server = buildServer(ctx, config);
  const toolCount = toolsForProfile(allTools, config.profile).length;
  process.stderr.write(
    `arch-mcp ${VERSION} host=${hostLabel(config)} mode=${config.mode} profile=${config.profile} tools=${toolCount}\n`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    conn.close();
    void server.close();
    // stdio servers must not outlive their client: ssh2 sockets and keepalive
    // timers can hold the event loop after the transport is gone.
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.server.onclose = shutdown;

  // Hold the transport open until in-flight calls have written their response:
  // `echo ... | arch-mcp` must not drop the last tool result on EOF.
  const input = new PassThrough();
  process.stdin.pipe(input);
  process.stdin.on('end', () => {
    setTimeout(() => {
      void toolRuntime.drain(10_000).finally(() => {
        input.end();
        shutdown();
      });
    }, 50);
  });

  await server.connect(new StdioServerTransport(input, serverStdout()));
}

await main();

/** stdout wrapper that tells the runtime when a response has really flushed. */
function serverStdout(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      toolRuntime.trackWrite();
      process.stdout.write(chunk, () => {
        toolRuntime.finishWrite();
        callback();
      });
    },
  });
}
