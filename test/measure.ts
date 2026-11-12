/**
 * Token measurement against a live host (docs/06-testing.md §6-7).
 *
 * Runs the 20 evaluation tasks, asserts at most 2 tool calls per task and an
 * average under 1.5k tokens, and compares with the raw SSH baseline.
 *
 * Usage: ARCH_MCP_HOST=... ARCH_MCP_PORT=... ARCH_MCP_USER=... ARCH_MCP_KEY=... pnpm measure
 */
import { startMcp } from './helpers/mcp-client.js';
import type { ToolEnvelope } from './helpers/mcp-client.js';

interface EvalTask {
  id: number;
  question: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

const EVAL_DISK = process.env.ARCH_MCP_EVAL_DISK ?? '/dev/sda';

const TASKS: readonly EvalTask[] = [
  { id: 1, question: 'Is the server healthy?', calls: [{ tool: 'sys_status', args: {} }] },
  { id: 2, question: 'Why did nginx fail?', calls: [{ tool: 'svc_failed', args: { lines: 10 } }] },
  {
    id: 3,
    question: 'Free RAM and which process uses it?',
    calls: [
      { tool: 'sys_status', args: {} },
      { tool: 'proc_list', args: { sort: 'mem', limit: 5 } },
    ],
  },
  { id: 4, question: 'Any pending updates?', calls: [{ tool: 'pkg_status', args: {} }] },
  { id: 5, question: 'What fills the disk?', calls: [{ tool: 'fs_usage', args: {} }] },
  { id: 6, question: 'Is 8080 listening?', calls: [{ tool: 'net_ports', args: { port: 8080 } }] },
  {
    id: 7,
    question: 'Why does unit X not start?',
    calls: [
      { tool: 'svc_status', args: { unit: 'sshd.service' } },
      { tool: 'log_query', args: { unit: 'sshd.service', limit: 20 } },
    ],
  },
  {
    id: 8,
    question: 'Last boot and how long did it take?',
    calls: [
      { tool: 'boot_info', args: {} },
      { tool: 'boot_time', args: {} },
    ],
  },
  { id: 9, question: 'Is the firewall on?', calls: [{ tool: 'sec_audit', args: {} }] },
  { id: 10, question: 'Which kernel do I run and have?', calls: [{ tool: 'boot_info', args: {} }] },
  { id: 11, question: 'Is it running hot?', calls: [{ tool: 'hw_summary', args: {} }] },
  { id: 12, question: 'Which timer runs next?', calls: [{ tool: 'svc_timers', args: {} }] },
  {
    id: 13,
    question: 'Who is logged in?',
    calls: [{ tool: 'usr_sessions', args: {} }, { tool: 'usr_logins', args: { limit: 10 } }],
  },
  { id: 14, question: 'Who owns /usr/bin/bash?', calls: [{ tool: 'pkg_owns', args: { path: '/usr/bin/bash' } }] },
  {
    id: 15,
    question: 'Any errors in the last hour?',
    calls: [{ tool: 'log_query', args: { priority: 'err', limit: 50 } }],
  },
  { id: 16, question: 'Which units are failed?', calls: [{ tool: 'svc_failed', args: {} }] },
  { id: 17, question: 'Does 1.1.1.1 answer?', calls: [{ tool: 'net_check', args: { target: '1.1.1.1:443', timeout_ms: 3000 } }] },
  { id: 18, question: 'What DNS do I use?', calls: [{ tool: 'net_status', args: {} }] },
  { id: 19, question: 'Is a reboot pending?', calls: [{ tool: 'sys_status', args: {} }] },
  {
    id: 20,
    question: 'Which disks are degraded?',
    calls: [{ tool: 'fs_smart', args: { device: EVAL_DISK } }, { tool: 'sys_status', args: {} }],
  },
];

/** Raw ssh bytes measured in docs/01-research.md §5.2 for the three common questions. */
const RAW_BASELINE_BYTES = 91_256 + 63_783 + 69_754;

const MAX_CALLS = 2;
const MAX_AVERAGE_TOKENS = 1500;
const TOKENS_PER_BYTE = 1 / 4;

interface TaskResult {
  task: EvalTask;
  calls: number;
  bytes: number;
  tokens: number;
  statuses: string[];
}

async function main(): Promise<void> {
  const client = await startMcp({
    ARCH_MCP_MODE: 'readonly',
    ARCH_MCP_PROFILE: 'full',
    ARCH_MCP_RATE_LIMIT: '120',
  });
  const tools = await client.listTools();
  const results: TaskResult[] = [];

  try {
    for (const task of TASKS) {
      let bytes = 0;
      const statuses: string[] = [];
      for (const call of task.calls) {
        if (!tools.includes(call.tool)) {
          statuses.push(`MISSING:${call.tool}`);
          continue;
        }
        const envelope: ToolEnvelope = await client.call(call.tool, call.args);
        bytes += Buffer.byteLength(JSON.stringify(envelope), 'utf8');
        statuses.push(envelope.ok ? 'ok' : (envelope.error?.code ?? 'error'));
      }
      results.push({
        task,
        calls: task.calls.length,
        bytes,
        tokens: Math.round(bytes * TOKENS_PER_BYTE),
        statuses,
      });
    }
  } finally {
    client.close();
  }

  console.log(`tools registered: ${tools.length}`);
  console.log('id  calls   bytes  tokens  status');
  for (const result of results) {
    console.log(
      `${String(result.task.id).padStart(2)}  ${String(result.calls).padStart(5)}  ${String(result.bytes).padStart(7)}  ${String(result.tokens).padStart(6)}  ${result.statuses.join(',')}`,
    );
  }

  const totalTokens = results.reduce((sum, result) => sum + result.tokens, 0);
  const average = Math.round(totalTokens / results.length);
  console.log(`average: ${average} tokens/task (budget ${MAX_AVERAGE_TOKENS})`);
  console.log(`raw baseline for the 3 common questions: ${RAW_BASELINE_BYTES} B ≈ ${Math.round(RAW_BASELINE_BYTES / 4)} tokens`);

  const failures: string[] = [];
  for (const result of results) {
    if (result.calls > MAX_CALLS) {
      failures.push(`task ${result.task.id} used ${result.calls} calls`);
    }
    if (result.statuses.some((status) => status.startsWith('MISSING'))) {
      failures.push(`task ${result.task.id} references a missing tool`);
    }
    if (result.statuses.includes('E_INTERNAL') || result.statuses.includes('E_PARSE')) {
      failures.push(`task ${result.task.id} had a parameter/parse error`);
    }
  }
  if (average > MAX_AVERAGE_TOKENS) {
    failures.push(`average ${average} exceeds ${MAX_AVERAGE_TOKENS}`);
  }

  if (failures.length > 0) {
    console.error(`FAIL: ${failures.join('; ')}`);
    process.exitCode = 1;
  }
}

await main();
