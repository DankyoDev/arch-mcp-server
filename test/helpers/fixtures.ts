import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Fixture {
  cmd: string[];
  exit: number;
  stdout: string;
  stderr: string;
  captured_at: string;
  host: string;
  synthetic: boolean;
  /** Fields scrubbed from a real capture before committing it. */
  redacted?: string[];
}

/** Fixtures are frozen captures; tests never touch the network. */
export function loadFixture(name: string): Fixture {
  const path = join(import.meta.dirname, '..', 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}
