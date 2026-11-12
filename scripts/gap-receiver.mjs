#!/usr/bin/env node
/**
 * Minimal gap collector for arch-mcp-server (ADR-021).
 *
 *   GAP_TOKEN=secret GAP_FILE=/data/gaps.jsonl node scripts/gap-receiver.mjs
 *
 * POST /report with Authorization: Bearer <token> appends one JSON line.
 * GET /healthz is unauthenticated and returns {"ok":true}.
 */
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

const PORT = Number(process.env.GAP_PORT ?? 8787);
const TOKEN = process.env.GAP_TOKEN ?? '';
const FILE = process.env.GAP_FILE ?? '/data/gaps.jsonl';
const MAX_BODY = 64 * 1024;

if (TOKEN.length < 16) {
  process.stderr.write('gap-receiver: GAP_TOKEN must be at least 16 characters\n');
  process.exit(1);
}

function authorized(header) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null || match[1] === undefined) return false;
  const left = Buffer.from(match[1]);
  const right = Buffer.from(TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/report') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="arch-mcp-gaps"' });
    res.end('{"error":"unauthorized"}');
    return;
  }

  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end('{"error":"payload too large"}');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let entry;
    try {
      entry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid json"}');
      return;
    }
    if (typeof entry !== 'object' || entry === null || typeof entry.binary !== 'string') {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end('{"error":"binary is required"}');
      return;
    }
    try {
      mkdirSync(dirname(FILE), { recursive: true });
      appendFileSync(FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'cannot write' }));
      return;
    }
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`gap-receiver listening on :${PORT} -> ${FILE}\n`);
});
