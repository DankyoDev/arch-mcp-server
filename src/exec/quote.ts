const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argv element for a POSIX shell. Anything outside the safe set is
 * wrapped in single quotes, with embedded quotes escaped as '\''.
 */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (SAFE_ARG.test(value)) return value;
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** Build one shell line from an argv vector. Never concatenate raw model data. */
export function buildLine(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('buildLine: argv must not be empty');
  for (const arg of argv) {
    if (arg.includes('\0')) throw new Error('buildLine: argument contains NUL');
  }
  return argv.map(shellQuote).join(' ');
}
