export interface PsRow {
  pid: number;
  ppid: number;
  user: string;
  cpuPct: number;
  memPct: number;
  rssB: number;
  state: string;
  uptimeS: number;
  cmd: string;
}

export interface CpuSample {
  total: number;
  idle: number;
  cores: Array<{ total: number; idle: number }>;
}

export interface TopRow {
  pid: number;
  name: string;
  cpuPct: number;
  memPct: number;
}

/** `ps -e -o pid=,comm=,pcpu=,pmem= --sort=-pcpu --no-headers`. */
export function parseTopOutput(text: string): TopRow[] {
  const rows: TopRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s*$/.exec(line);
    if (match === null) continue;
    const [, pid, name, cpu, mem] = match;
    if (pid === undefined || name === undefined) continue;
    rows.push({ pid: Number(pid), name, cpuPct: Number(cpu ?? 0), memPct: Number(mem ?? 0) });
  }
  return rows;
}

/**
 * `ps -e -o pid=,ppid=,user:16=,pcpu=,pmem=,rss=,stat=,etimes=,args= --no-headers`
 * Columns are whitespace separated; only args may contain spaces.
 */
export function parsePsOutput(text: string): PsRow[] {
  const rows: PsRow[] = [];
  const pattern =
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/;
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const [, pid, ppid, user, cpu, mem, rss, state, etimes, cmd] = match;
    if (pid === undefined || ppid === undefined || user === undefined) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      user,
      cpuPct: Number(cpu ?? 0),
      memPct: Number(mem ?? 0),
      rssB: Number(rss ?? 0) * 1024,
      state: state ?? '',
      uptimeS: Number(etimes ?? 0),
      cmd: (cmd ?? '').trim(),
    });
  }
  return rows;
}

/** /proc/stat: first eight counters are user..steal; idle includes iowait. */
export function parseProcStat(text: string): CpuSample {
  const sample: CpuSample = { total: 0, idle: 0, cores: [] };
  for (const line of text.split('\n')) {
    const match = /^cpu(\d*)\s+(.+)$/.exec(line.trim());
    if (match === null) continue;
    const suffix = match[1] ?? '';
    const values = (match[2] ?? '').trim().split(/\s+/).map(Number);
    if (values.length < 4) continue;
    const counters = values.slice(0, 8);
    const total = counters.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    const idle = (counters[3] ?? 0) + (counters[4] ?? 0);
    if (suffix === '') {
      sample.total = total;
      sample.idle = idle;
    } else {
      sample.cores.push({ total, idle });
    }
  }
  return sample;
}

export function parseLoadavg(text: string): number[] {
  const trimmed = text.trim();
  if (trimmed === '') return [0, 0, 0];
  const values = trimmed.split(/\s+/).slice(0, 3).map(Number);
  return values.map((value) => (Number.isFinite(value) ? value : 0));
}

export interface DiskStats {
  readB: number;
  writeB: number;
}

const WHOLE_DEVICE = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** /proc/diskstats: sectors read/written are fields 6 and 10 (512 B units). */
export function parseDiskstats(text: string): DiskStats {
  let readSectors = 0;
  let writeSectors = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const name = fields[2];
    if (name === undefined || !WHOLE_DEVICE.test(name)) continue;
    readSectors += Number(fields[5] ?? 0) || 0;
    writeSectors += Number(fields[9] ?? 0) || 0;
  }
  return { readB: readSectors * 512, writeB: writeSectors * 512 };
}

export interface NetStats {
  rxB: number;
  txB: number;
}

/** /proc/net/dev: rx bytes at field 1, tx bytes at field 9; loops are skipped. */
export function parseNetDev(text: string): NetStats {
  let rxB = 0;
  let txB = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (iface === '' || iface === 'lo') continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    rxB += Number(fields[0] ?? 0) || 0;
    txB += Number(fields[8] ?? 0) || 0;
  }
  return { rxB, txB };
}
