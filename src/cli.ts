export interface CliOptions {
  http: boolean;
  port?: number;
  host?: string;
  help: boolean;
  version: boolean;
}

/** Tiny flag parser: stdio is the default, HTTP is opt-in. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { http: false, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--http') {
      options.http = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      options.version = true;
      continue;
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg.startsWith('--port=') ? arg.slice('--port='.length) : argv[index + 1];
      if (arg === '--port') index += 1;
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port expects a number between 1 and 65535');
      }
      options.port = port;
      continue;
    }
    if (arg === '--host' || arg.startsWith('--host=')) {
      const value = arg.startsWith('--host=') ? arg.slice('--host='.length) : argv[index + 1];
      if (arg === '--host') index += 1;
      if (value === undefined || value.trim() === '') {
        throw new Error('--host expects an address');
      }
      options.host = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function usage(): string {
  return [
    'arch-mcp — MCP server for Linux hosts (Arch first)',
    '',
    'Usage: arch-mcp [--http [--port N] [--host ADDR]]',
    '',
    '  (no flags)   stdio transport, for OpenCode/Claude/Cursor',
    '  --http       Streamable HTTP on /mcp (default 127.0.0.1:3333)',
    '  --port N     HTTP port (or ARCH_MCP_HTTP_PORT)',
    '  --host ADDR  HTTP bind address (or ARCH_MCP_HTTP_HOST)',
    '  --help       show this help',
    '  --version    print the version',
    '',
    'HTTP auth: set ARCH_MCP_HTTP_TOKEN (>=16 chars) to require a bearer token.',
    'Configuration is environment-only; see docs/11-configuration.md.',
  ].join('\n');
}
