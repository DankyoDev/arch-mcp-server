import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allTools } from '../src/tools/index.js';
import { toolsForProfile } from '../src/tools/registry.js';

describe('profiles', () => {
  it('keeps the documented tool counts', () => {
    assert.equal(allTools.length, 113);
    assert.equal(toolsForProfile(allTools, 'core').length, 12);
    assert.equal(toolsForProfile(allTools, 'readonly').length, 66);
    assert.equal(toolsForProfile(allTools, 'full').length, 113);
  });

  it('keeps exec_gaps and fs_grep read-only', () => {
    const readonly = new Set(toolsForProfile(allTools, 'readonly').map((tool) => tool.name));
    assert.ok(readonly.has('exec_gaps'));
    assert.ok(readonly.has('fs_grep'));
    assert.ok(readonly.has('fs_checksum'));
    assert.ok(readonly.has('fs_du'));
    assert.ok(readonly.has('fs_archive_list'));
    assert.ok(readonly.has('http_check'));
    assert.ok(readonly.has('net_ping'));
    assert.ok(!readonly.has('exec'));
    assert.ok(!readonly.has('exec_any'));
    assert.ok(!readonly.has('script_run'));
  });
});
