import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectCommands } from '../src/parse/script.js';

describe('detectCommands', () => {
  it('finds the binaries of a shell script', () => {
    const source = [
      '#!/bin/bash',
      'set -euo pipefail',
      'cd /home/dante/docker/apps/mindustry',
      'docker compose up -d 2>&1 | tail -5',
      "docker exec mindustry sh -c 'ls -la /config'",
      'sleep 20',
      'ls -1 /home/dante/docker',
    ].join('\n');
    assert.deepEqual(detectCommands(source), ['docker', 'tail', 'sleep', 'ls']);
  });

  it('skips wrappers, assignments, comments and shell builtins', () => {
    const source = [
      '# docker ps',
      'FOO=bar BAZ=1 curl -s https://example.com',
      'sudo systemctl restart nginx',
      'if [ -f /tmp/x ]; then echo yes; fi',
      'printf "%s\\n" hi',
    ].join('\n');
    assert.deepEqual(detectCommands(source), ['curl', 'systemctl']);
  });

  it('deduplicates and caps the list', () => {
    const source = Array.from({ length: 40 }, (_item, index) => `binary${index} --flag`).join('\n');
    const commands = detectCommands(source);
    assert.equal(commands.length, 16);
    assert.equal(new Set(commands).size, 16);
    assert.deepEqual(detectCommands('docker ps\ndocker ps\n'), ['docker']);
  });

  it('returns nothing for empty or missing source', () => {
    assert.deepEqual(detectCommands(undefined), []);
    assert.deepEqual(detectCommands(''), []);
  });
});
