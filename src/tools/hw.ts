import { z } from 'zod';
import { ok } from '../core/result.js';
import { runCommand } from '../exec/run.js';
import { runSections } from '../exec/sequence.js';
import { round1 } from '../core/format.js';
import { parseLscpuJson } from '../parse/host.js';
import {
  parseLspciDrivers,
  parseLspciMm,
  parseLsblk,
  parseLsusb,
  parseSensorsJson,
} from '../parse/hw.js';
import { defineTool, toolData } from './registry.js';
import type { ToolContext } from './registry.js';
import { requireFeature } from './guards.js';

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const DISPLAY_CLASS = /(VGA compatible|3D controller|Display controller)/i;

export const hwSummaryTool = defineTool({
  name: 'hw_summary',
  title: 'Hardware summary',
  description:
    'CPU model and cores, GPUs, disks, maximum temperatures and battery state in one call. Use it for a quick hardware health check.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const batch = await runSections(
      ctx.conn,
      [
        { key: 'lscpu', argv: ['lscpu', '-J'] },
        { key: 'lsblk', argv: ['lsblk', '-J', '-b'] },
        { key: 'lspci', argv: ['lspci', '-mm', '-nn'] },
        { key: 'sensors', argv: ['sensors', '-j'] },
        { key: 'power', argv: ['sh', '-c', 'cat /sys/class/power_supply/*/capacity /sys/class/power_supply/*/status 2>/dev/null'] },
        { key: 'ac', argv: ['sh', '-c', 'cat /sys/class/power_supply/*/online 2>/dev/null'] },
        { key: 'thermal', argv: ['sh', '-c', 'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null'] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 262_144 },
    );
    if (!batch.ok) return batch;

    const cpu = parseLscpuJson(batch.data.lscpu?.stdout ?? '');
    const devices = parseLsblk(batch.data.lsblk?.stdout ?? '');
    const gpus = parseLspciMm(batch.data.lspci?.stdout ?? '')
      .filter((device) => DISPLAY_CLASS.test(device.class))
      .map((device) => ({ vendor: device.vendor, model: device.device }));

    const temps: Record<string, number> = {};
    for (const reading of parseSensorsJson(batch.data.sensors?.stdout ?? '')) {
      if (reading.unit !== 'C') continue;
      temps[reading.chip] = Math.max(temps[reading.chip] ?? 0, reading.value);
    }
    if (Object.keys(temps).length === 0) {
      const thermalMax = maxThermal(batch.data.thermal?.stdout ?? '');
      if (thermalMax !== undefined) temps.thermal = thermalMax;
    }
    for (const key of Object.keys(temps)) temps[key] = round1(temps[key] ?? 0);

    const data: Record<string, unknown> = {
      cpu: { cores: cpu.cores, model: cpu.model },
      gpus,
      disks: devices
        .filter((device) => device.type === 'disk' && device.sizeB > 0)
        .map((device) => ({ name: device.name, size_b: device.sizeB, model: device.model })),
      temps,
    };
    const battery = parseBattery(batch.data.power?.stdout ?? '');
    if (battery !== undefined) data.battery = battery;
    const ac = firstNumeric(batch.data.ac?.stdout ?? '');
    if (ac !== undefined) data.ac = ac === 1;

    return ok(toolData(data));
  },
});

export const hwSensorsTool = defineTool({
  name: 'hw_sensors',
  title: 'Sensors',
  description:
    'Normalised lm-sensors readings as chip, sensor, value and unit. Filter by chip when you only care about the CPU.',
  schema: z.object({
    chip: z.string().max(64).optional().describe('Only readings from this chip'),
    limit: z.number().int().min(1).max(200).default(100).describe('Readings per page'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'sensors', 'install lm_sensors');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['sensors', '-j'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;

    let readings = parseSensorsJson(result.data.stdout);
    if (input.chip !== undefined && input.chip !== '') {
      readings = readings.filter((reading) => reading.chip === input.chip);
    }
    return ok(
      toolData(
        readings.slice(0, input.limit).map((reading) => ({
          chip: reading.chip,
          sensor: reading.sensor,
          value: round1(reading.value),
          unit: reading.unit,
        })),
        { total: readings.length },
      ),
    );
  },
});

export const hwGpuTool = defineTool({
  name: 'hw_gpu',
  title: 'GPUs',
  description:
    'GPUs with driver and, when nvidia-smi exists, temperature, utilisation and memory. Use it before blaming the GPU.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const capabilities = await ctx.capabilities();
    if (!capabilities.ok) return capabilities;

    if (capabilities.data.features.nvidia === true) {
      const smi = await runCommand(
        ctx.conn,
        [
          'nvidia-smi',
          '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total',
          '--format=csv,noheader,nounits',
        ],
        { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
      );
      if (smi.ok && smi.data.code === 0) {
        const gpus = smi.data.stdout
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts.length >= 5 && parts[0] !== '')
          .map((parts) => ({
            vendor: 'nvidia',
            model: parts[0],
            temp_c: Number(parts[1]),
            util_pct: Number(parts[2]),
            mem_used_b: Number(parts[3]) * 1024 * 1024,
            mem_total_b: Number(parts[4]) * 1024 * 1024,
          }));
        if (gpus.length > 0) return ok(toolData(gpus));
      }
    }

    const batch = await runSections(
      ctx.conn,
      [
        { key: 'lspci', argv: ['lspci', '-mm', '-nn'] },
        { key: 'drivers', argv: ['lspci', '-k'] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!batch.ok) return batch;

    const drivers = parseLspciDrivers(batch.data.drivers?.stdout ?? '');
    const gpus = parseLspciMm(batch.data.lspci?.stdout ?? '')
      .filter((device) => DISPLAY_CLASS.test(device.class))
      .map((device) => {
        const gpu: Record<string, unknown> = { vendor: device.vendor, model: device.device };
        const driver = drivers.get(device.slot);
        if (driver !== undefined) gpu.driver = driver;
        return gpu;
      });
    return ok(toolData(gpus));
  },
});

export const hwPciTool = defineTool({
  name: 'hw_pci',
  title: 'PCI devices',
  description:
    'PCI devices with class, vendor, device and kernel driver. Filter by a substring of vendor, device or class.',
  schema: z.object({
    filter: z.string().max(100).optional().describe('Case-insensitive substring'),
    limit: z.number().int().min(1).max(200).default(100).describe('Devices per page'),
  }),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (input, ctx) => {
    const guard = await requireFeature(ctx, 'lspci', 'install pciutils');
    if (!guard.ok) return guard;

    const batch = await runSections(
      ctx.conn,
      [
        { key: 'lspci', argv: ['lspci', '-mm', '-nn'] },
        { key: 'drivers', argv: ['lspci', '-k'] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!batch.ok) return batch;

    const drivers = parseLspciDrivers(batch.data.drivers?.stdout ?? '');
    let devices = parseLspciMm(batch.data.lspci?.stdout ?? '');
    if (input.filter !== undefined && input.filter !== '') {
      const needle = input.filter.toLowerCase();
      devices = devices.filter(
        (device) =>
          device.vendor.toLowerCase().includes(needle) ||
          device.device.toLowerCase().includes(needle) ||
          device.class.toLowerCase().includes(needle) ||
          device.slot.toLowerCase().includes(needle),
      );
    }
    return ok(
      toolData(
        devices.slice(0, input.limit).map((device) => ({
          slot: device.slot,
          class: device.class,
          vendor: device.vendor,
          device: device.device,
          driver: drivers.get(device.slot),
        })),
        { total: devices.length },
      ),
    );
  },
});

export const hwUsbTool = defineTool({
  name: 'hw_usb',
  title: 'USB devices',
  description: 'USB devices with bus, vendor:product id and description. Use it to confirm a dongle is seen.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const guard = await requireFeature(ctx, 'lsusb', 'install usbutils');
    if (!guard.ok) return guard;

    const result = await runCommand(ctx.conn, ['lsusb'], {
      timeoutMs: ctx.config.timeoutMs,
      maxBytes: 65_536,
    });
    if (!result.ok) return result;
    return ok(toolData(parseLsusb(result.data.stdout)));
  },
});

export const hwPowerTool = defineTool({
  name: 'hw_power',
  title: 'Power state',
  description:
    'Battery percentage and status, AC adapter, CPU governor and power profiles. Use it on laptops or to check the governor.',
  schema: z.object({}),
  annotations: READ,
  profiles: ['readonly', 'full'],
  handler: async (_input, ctx) => {
    const batch = await runSections(
      ctx.conn,
      [
        { key: 'power', argv: ['sh', '-c', 'cat /sys/class/power_supply/*/capacity /sys/class/power_supply/*/status 2>/dev/null'] },
        { key: 'ac', argv: ['sh', '-c', 'cat /sys/class/power_supply/*/online 2>/dev/null'] },
        { key: 'governor', argv: ['sh', '-c', 'cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null'] },
        { key: 'profiles', argv: ['sh', '-c', 'powerprofilesctl get 2>/dev/null'] },
      ],
      { timeoutMs: ctx.config.timeoutMs, maxBytes: 65_536 },
    );
    if (!batch.ok) return batch;

    const data: Record<string, unknown> = {};
    const battery = parseBattery(batch.data.power?.stdout ?? '');
    if (battery !== undefined) data.battery = battery;
    const ac = firstNumeric(batch.data.ac?.stdout ?? '');
    if (ac !== undefined) data.ac = ac === 1;
    const governor = (batch.data.governor?.stdout ?? '').trim();
    if (governor !== '') data.governor = governor;
    const profile = (batch.data.profiles?.stdout ?? '').trim();
    if (profile !== '') data.profile = profile;
    return ok(toolData(data));
  },
});

function parseBattery(
  text: string,
): { pct?: number; status?: string } | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return undefined;
  const battery: { pct?: number; status?: string } = {};
  for (const line of lines) {
    const numeric = Number(line);
    if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 100 && battery.pct === undefined) {
      battery.pct = numeric;
    } else if (/^[A-Za-z ]+$/.test(line) && battery.status === undefined) {
      battery.status = line;
    }
  }
  return Object.keys(battery).length > 0 ? battery : undefined;
}

function firstNumeric(text: string): number | undefined {
  const value = Number(text.trim().split('\n')[0]);
  return Number.isFinite(value) ? value : undefined;
}

function maxThermal(text: string): number | undefined {
  const values = text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((milli) => Math.round(milli / 100) / 10);
  return values.length > 0 ? Math.max(...values) : undefined;
}

export type HwContext = ToolContext;
