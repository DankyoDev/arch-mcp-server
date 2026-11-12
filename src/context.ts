import type { HostCapabilities } from './caps.js';
import { detectCapabilities } from './caps.js';
import type { Config } from './config.js';
import type { Connection } from './connection/types.js';
import type { Result } from './core/types.js';
import type { ToolContext } from './tools/registry.js';

/** Per-process tool context: connection, config and memoized capabilities. */
export class HostContext implements ToolContext {
  #caps: Promise<Result<HostCapabilities>> | null = null;

  constructor(
    readonly conn: Connection,
    readonly config: Config,
  ) {}

  capabilities(): Promise<Result<HostCapabilities>> {
    this.#caps ??= detectCapabilities(this.conn, this.config);
    return this.#caps;
  }
}
