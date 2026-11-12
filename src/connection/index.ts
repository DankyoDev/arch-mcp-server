import type { Config } from '../config.js';
import { LocalConnection } from './local.js';
import { SshConnection } from './ssh.js';
import { SudoConnection } from './sudo.js';
import type { Connection } from './types.js';

export function createConnection(config: Config): Connection {
  const base: Connection = config.local ? new LocalConnection() : new SshConnection(config);
  return config.allowSudo ? new SudoConnection(base, config) : base;
}
