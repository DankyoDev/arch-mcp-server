export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return round1((part / whole) * 100);
}

/** Journal and systemd timestamps are microseconds since the epoch. */
export function isoFromUs(value: number | string): string | undefined {
  const us = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(us) || us <= 0) return undefined;
  return new Date(Math.round(us / 1000)).toISOString();
}

/** `Thu 2026-11-12 14:28:24 UTC` (with LANG=C) to ISO 8601. */
export function isoFromSystemdStamp(value: string): string | undefined {
  const match = /^\w{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(value.trim());
  if (match === null) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return `${match[1]}T${match[2]}Z`;
}

/** Strip ANSI escapes and control characters except tab/newline. */
export function sanitizeOutput(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}
