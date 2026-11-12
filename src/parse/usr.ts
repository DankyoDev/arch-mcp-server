export interface Session {
  id: string;
  user: string;
  tty: string;
  seat?: string;
}

/** `loginctl list-sessions`: SESSION UID USER SEAT TTY. */
export function parseLoginctlSessions(text: string): Session[] {
  const sessions: Session[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || /^SESSION\b/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    const id = parts[0];
    const user = parts[2];
    const seat = parts[3];
    const tty = parts[4];
    if (id === undefined || user === undefined || tty === undefined) continue;
    const session: Session = { id, user, tty };
    if (seat !== undefined && seat !== '-' && seat !== 'seat') session.seat = seat;
    sessions.push(session);
  }
  return sessions;
}

export interface LoginEntry {
  user: string;
  tty: string;
  from: string;
  at: string;
  status?: string;
}

const LAST_LINE = /^(\S+)\s+(system boot|\S+)\s+(\S+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s*(.*)$/;

/** `last -F` / `lastb`: user, tty, origin, timestamp, status. */
export function parseLast(text: string): LoginEntry[] {
  const entries: LoginEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || /^(wtmp|btmp) begins/.test(trimmed)) continue;
    const match = LAST_LINE.exec(trimmed);
    if (match === null) continue;
    const [, user, tty, from, at, status] = match;
    if (user === undefined || tty === undefined || from === undefined || at === undefined) continue;
    const entry: LoginEntry = { user, tty, from, at };
    const cleanStatus = (status ?? '').trim();
    if (cleanStatus !== '') entry.status = cleanStatus;
    entries.push(entry);
  }
  return entries;
}
