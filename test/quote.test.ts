import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLine, shellQuote } from '../src/exec/quote.js';

describe('shellQuote', () => {
  it('leaves safe tokens untouched', () => {
    for (const value of ['systemctl', '/var/log/journal', 'a-b_c.d:e@f%g+h,i=j', '1234']) {
      assert.equal(shellQuote(value), value);
    }
  });

  it('quotes empty strings', () => {
    assert.equal(shellQuote(''), "''");
  });

  it('wraps unsafe tokens in single quotes', () => {
    assert.equal(shellQuote('with space'), "'with space'");
    assert.equal(shellQuote('a;b'), "'a;b'");
    assert.equal(shellQuote('a|b'), "'a|b'");
    assert.equal(shellQuote('$(id)'), "'$(id)'");
    assert.equal(shellQuote('`id`'), "'`id`'");
    assert.equal(shellQuote('a&b'), "'a&b'");
    assert.equal(shellQuote('a\nb'), "'a\nb'");
    assert.equal(shellQuote('~'), "'~'");
  });

  it('escapes embedded single quotes', () => {
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
    assert.equal(shellQuote("'; rm -rf / #"), "''\\''; rm -rf / #'");
  });

  it('never leaves a dangerous character unquoted', () => {
    const payloads = ['a b', 'a;b', 'a|b', 'a&b', '$(x)', '`x`', 'a\nb', "a'b", 'a"b', 'a\\b', '<x>'];
    for (const payload of payloads) {
      const quoted = shellQuote(payload);
      assert.ok(quoted.startsWith("'"), `not quoted: ${quoted}`);
      assert.ok(quoted.endsWith("'"), `not quoted: ${quoted}`);
    }
  });
});

describe('buildLine', () => {
  it('joins argv with quoting per element', () => {
    assert.equal(buildLine(['systemctl', 'show', 'nginx.service']), 'systemctl show nginx.service');
    assert.equal(buildLine(['echo', 'a b']), "echo 'a b'");
    assert.equal(buildLine(['sh', '-c', 'echo "$HOME"']), "sh -c 'echo \"$HOME\"'");
  });

  it('rejects an empty argv', () => {
    assert.throws(() => buildLine([]), /argv must not be empty/);
  });

  it('rejects NUL bytes', () => {
    assert.throws(() => buildLine(['echo', 'a\0b']), /NUL/);
  });
});
