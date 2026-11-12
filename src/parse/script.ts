/**
 * Best-effort list of the external binaries a shell snippet calls. It exists so
 * the gap log can say "this script used docker" instead of "this script used
 * bash" (ADR-021), which is what feeds the promotion rule for native tools.
 * It never executes anything and never influences policy.
 */

/** Shell builtins, keywords and control words that are not binaries. */
const NOT_BINARIES = new Set([
  'alias',
  'break',
  'case',
  'cd',
  'command',
  'continue',
  'do',
  'done',
  'echo',
  'elif',
  'else',
  'esac',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'local',
  'printf',
  'read',
  'return',
  'set',
  'shift',
  'source',
  'test',
  'then',
  'times',
  'trap',
  'true',
  'type',
  'umask',
  'unset',
  'until',
  'wait',
  'while',
  '[',
  '[[',
  ']]',
  ':',
  '.',
]);

/** Wrappers whose own name says nothing about the work being done. */
const WRAPPERS = new Set(['sudo', 'doas', 'time', 'nice', 'nohup', 'setsid', 'env', 'command', 'exec']);

const MAX_COMMANDS = 16;
const MAX_LENGTH = 40;

export function detectCommands(source: string | undefined): string[] {
  if (source === undefined || source === '') return [];
  const found = new Set<string>();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    for (const segment of line.split(/&&|\|\||[;|()]/)) {
      const name = firstBinary(segment);
      if (name !== null) found.add(name);
      if (found.size >= MAX_COMMANDS) return [...found];
    }
  }
  return [...found];
}

function firstBinary(segment: string): string | null {
  const words = segment.trim().split(/\s+/).filter((word) => word !== '');
  while (words.length > 0) {
    let word = words.shift();
    if (word === undefined) return null;
    if (word.startsWith('#') || word.startsWith('"') || word.startsWith("'")) return null;
    // Leading `VAR=value` assignments belong to the segment, not to a binary.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    word = word.replace(/^\(+/, '');
    if (word === '' || NOT_BINARIES.has(word)) return null;
    if (WRAPPERS.has(word)) continue;
    if (!/^[A-Za-z0-9_.+-]+$/.test(word)) return null;
    return word.slice(0, MAX_LENGTH);
  }
  return null;
}
