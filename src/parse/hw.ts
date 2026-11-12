export interface BlockDevice {
  name: string;
  type: string;
  sizeB: number;
  model?: string;
}

interface LsblkNode {
  name?: unknown;
  type?: unknown;
  size?: unknown;
  model?: unknown;
  children?: unknown;
}

/** `lsblk -J -b`, flattened; loop/ram/nbd devices are dropped. */
export function parseLsblk(text: string): BlockDevice[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const devices = (parsed as { blockdevices?: unknown }).blockdevices;
  if (!Array.isArray(devices)) return [];

  const result: BlockDevice[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const node = value as LsblkNode;
    const name = typeof node.name === 'string' ? node.name : undefined;
    const type = typeof node.type === 'string' ? node.type : 'disk';
    if (name !== undefined && !/^(loop|ram|nbd|sr)/.test(name)) {
      const device: BlockDevice = {
        name,
        type,
        sizeB: typeof node.size === 'number' ? node.size : 0,
      };
      if (typeof node.model === 'string' && node.model.trim() !== '') {
        device.model = node.model.trim();
      }
      result.push(device);
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child);
  };
  for (const device of devices) visit(device);
  return result;
}

export interface PciDevice {
  slot: string;
  class: string;
  vendor: string;
  device: string;
  driver?: string;
}

/** `lspci -mm -nn`: quoted fields; the trailing [id] is stripped. */
export function parseLspciMm(text: string): PciDevice[] {
  const devices: PciDevice[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+"([^"]*)"\s+"([^"]*)"\s+"([^"]*)"/.exec(line.trim());
    if (match === null) continue;
    const [, slot, klass, vendor, device] = match;
    if (slot === undefined || klass === undefined) continue;
    devices.push({
      slot,
      class: stripId(klass),
      vendor: stripId(vendor ?? ''),
      device: stripId(device ?? ''),
    });
  }
  return devices;
}

/** `lspci -k`: attach "Kernel driver in use" to each previously seen slot. */
export function parseLspciDrivers(text: string): Map<string, string> {
  const drivers = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const slot = /^(\S+)\s+\S/.exec(line);
    if (slot?.[1] !== undefined && !line.startsWith('\t') && !line.startsWith(' ')) {
      current = slot[1];
      continue;
    }
    const driver = /Kernel driver in use:\s*(\S+)/.exec(line);
    if (driver?.[1] !== undefined && current !== undefined) drivers.set(current, driver[1]);
  }
  return drivers;
}

export interface SensorReading {
  chip: string;
  sensor: string;
  value: number;
  unit: string;
}

/** `sensors -j`: chip -> sensor -> {temp1_input: 45.0, ...}. */
export function parseSensorsJson(text: string): SensorReading[] {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '{}') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const readings: SensorReading[] = [];
  for (const [chip, sensors] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof sensors !== 'object' || sensors === null) continue;
    for (const [sensor, values] of Object.entries(sensors as Record<string, unknown>)) {
      if (sensor === 'Adapter' || typeof values !== 'object' || values === null) continue;
      for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
        if (typeof raw !== 'number') continue;
        const unit = unitFor(key);
        if (unit === null) continue;
        readings.push({ chip, sensor, value: raw, unit });
      }
    }
  }
  return readings;
}

export interface UsbDevice {
  bus: string;
  id: string;
  desc: string;
}

/** `lsusb`: "Bus 001 Device 002: ID 1d6b:0002 Linux Foundation 2.0 root hub". */
export function parseLsusb(text: string): UsbDevice[] {
  const devices: UsbDevice[] = [];
  for (const line of text.split('\n')) {
    const match = /^Bus (\d+)\s+Device \d+:\s+ID\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, bus, id, desc] = match;
    if (bus === undefined || id === undefined) continue;
    devices.push({ bus, id, desc: (desc ?? '').trim() });
  }
  return devices;
}

export interface SmartHealth {
  device: string;
  model?: string;
  health: string;
  tempC?: number;
  hours?: number;
  /** smartctl's own error, present when it could not query the device. */
  error?: string;
}

/** `smartctl -j -H -A` subset. */
export function parseSmartctlJson(text: string, device: string): SmartHealth {
  const health: SmartHealth = { device, health: 'unknown' };
  const trimmed = text.trim();
  if (trimmed === '') return health;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return health;
  }
  if (typeof parsed !== 'object' || parsed === null) return health;
  const record = parsed as Record<string, unknown>;
  const model = record.model_name;
  if (typeof model === 'string' && model.trim() !== '') health.model = model.trim();
  const status = record.smart_status;
  if (typeof status === 'object' && status !== null) {
    const passed = (status as { passed?: unknown }).passed;
    if (typeof passed === 'boolean') health.health = passed ? 'passed' : 'failed';
  }
  const temperature = record.temperature;
  if (typeof temperature === 'object' && temperature !== null) {
    const current = (temperature as { current?: unknown }).current;
    if (typeof current === 'number') health.tempC = current;
  }
  const powerOn = record.power_on_time;
  if (typeof powerOn === 'object' && powerOn !== null) {
    const hours = (powerOn as { hours?: unknown }).hours;
    if (typeof hours === 'number') health.hours = hours;
  }

  const smartctl = record.smartctl;
  if (typeof smartctl === 'object' && smartctl !== null) {
    const meta = smartctl as { exit_status?: unknown; messages?: unknown };
    const messages = Array.isArray(meta.messages) ? meta.messages : [];
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue;
      const entry = message as { severity?: unknown; string?: unknown };
      if (entry.severity === 'error' && typeof entry.string === 'string') {
        health.error = entry.string;
        break;
      }
    }
    const exitStatus = Number(meta.exit_status);
    if (health.error === undefined && Number.isInteger(exitStatus) && exitStatus !== 0) {
      health.error = `smartctl exited with ${exitStatus}`;
    }
  }
  return health;
}



function unitFor(key: string): string | null {
  if (key.startsWith('temp') && key.endsWith('_input')) return 'C';
  if (key.startsWith('fan') && key.endsWith('_input')) return 'RPM';
  if (key.startsWith('power') && key.endsWith('_input')) return 'W';
  if (key.startsWith('in') && key.endsWith('_input')) return 'V';
  if (key.startsWith('curr') && key.endsWith('_input')) return 'A';
  return null;
}

function stripId(value: string): string {
  return value.replace(/\s*\[[0-9a-fA-F]+\]$/, '').trim();
}

