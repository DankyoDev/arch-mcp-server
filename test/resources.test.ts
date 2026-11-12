import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { cheatsheetText, rulesText } from '../src/resources.js';
import { allTools } from '../src/tools/index.js';

describe('cheatsheetText', () => {
  it('lists every registered tool so it cannot drift', () => {
    const text = cheatsheetText();
    for (const tool of allTools) {
      assert.ok(text.includes(`\`${tool.name}\``), `missing ${tool.name}`);
    }
    assert.match(text, /\| Question \| Tool \|/);
  });
});

describe('rulesText', () => {
  const previous = process.env.ARCH_MCP_RULES;

  afterEach(() => {
    if (previous === undefined) delete process.env.ARCH_MCP_RULES;
    else process.env.ARCH_MCP_RULES = previous;
  });

  it('uses the inline rules when set', () => {
    process.env.ARCH_MCP_RULES = '- no tocar docker\n';
    assert.equal(rulesText(), '- no tocar docker\n');
  });

  it('falls back to the template', () => {
    delete process.env.ARCH_MCP_RULES;
    const text = rulesText();
    assert.ok(text.length > 0);
    assert.match(text, /Host rules|ARCH_MCP_RULES_FILE/);
  });
});
