import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('defaults to stdio', () => {
    assert.deepEqual(parseArgs([]), { http: false, help: false, version: false });
  });

  it('enables HTTP explicitly', () => {
    assert.equal(parseArgs(['--http']).http, true);
  });

  it('accepts port and host in both forms', () => {
    assert.equal(parseArgs(['--http', '--port', '4444']).port, 4444);
    assert.equal(parseArgs(['--port=5555']).port, 5555);
    assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
    assert.equal(parseArgs(['--host=127.0.0.1']).host, '127.0.0.1');
  });

  it('reports help and version', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['--version']).version, true);
  });

  it('rejects invalid values and unknown flags', () => {
    assert.throws(() => parseArgs(['--port', 'abc']), /between 1 and 65535/);
    assert.throws(() => parseArgs(['--port', '70000']), /between 1 and 65535/);
    assert.throws(() => parseArgs(['--host']), /expects an address/);
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });
});
