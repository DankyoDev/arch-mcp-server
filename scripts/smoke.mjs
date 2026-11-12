#!/usr/bin/env node
/**
 * Phase-0 acceptance smoke test: spawn the built server over stdio, run the MCP
 * handshake, list tools and call sys_info. Prints byte measurements.
 *
 * Usage: ARCH_MCP_* env vars + `node scripts/smoke.mjs`
 */
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let buffer = '';
const pending = new Map();
const responses = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    const message = JSON.parse(line);
    responses.push(message);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

const timer = setTimeout(() => {
  console.error('smoke: timed out waiting for the server');
  child.kill();
  process.exit(1);
}, 30_000);

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
notify('notifications/initialized');

const list = await request('tools/list', {});
const call = await request('tools/call', { name: 'sys_info', arguments: {} });

const text = call.result?.content?.[0]?.text ?? '';
const structured = call.result?.structuredContent;
const dataBytes = Buffer.byteLength(JSON.stringify(structured?.data ?? {}), 'utf8');
const envelopeBytes = Buffer.byteLength(text, 'utf8');

console.log(`initialize: ${init.result.serverInfo.name}@${init.result.serverInfo.version}`);
console.log(`tools/list: ${list.result.tools.length} tool(s) → ${list.result.tools.map((t) => t.name).join(', ')}`);
console.log(`sys_info bytes: data=${dataBytes} envelope=${envelopeBytes} ms=${structured?.meta?.ms}`);
console.log(`sys_info: ${JSON.stringify(structured?.data)}`);
console.log(`isError=${call.result.isError}`);

clearTimeout(timer);
child.stdin.end();
child.kill();
process.exit(call.result?.isError === false ? 0 : 1);
