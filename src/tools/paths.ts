import { err } from '../core/result.js';
import type { Result } from '../core/types.js';
import { validateAbsolutePath } from './guards.js';

const SENSITIVE_PATHS = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers'];
const SENSITIVE_PREFIXES = ['/etc/sudoers.d/'];
const FORBIDDEN_WRITE_PREFIXES = ['/etc/', '/boot/', '/usr/', '/proc/', '/sys/', '/dev/'];

/** System roots that a daily file operation must never target as a whole. */
const SYSTEM_ROOTS = new Set([
  '/',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/etc',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/home',
  '/root',
  '/var',
  '/srv',
  '/run',
  '/tmp',
  '/opt',
]);

export function validateSafePath(path: string): Result<string> {
  const base = validateAbsolutePath(path);
  if (!base.ok) return base;
  if (path.split('/').includes('..')) {
    return err('E_POLICY', 'path must not contain ..', 'use a normalized absolute path');
  }
  return base;
}

export function isSensitivePath(path: string): boolean {
  if (SENSITIVE_PATHS.includes(path)) return true;
  if (SENSITIVE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return /(^|\/)\.ssh\/id_[^/]*$/.test(path);
}

export function isForbiddenWrite(path: string): boolean {
  if (path === '/etc' || path === '/boot' || path === '/usr') return true;
  if (FORBIDDEN_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return /(^|\/)\.ssh(\/|$)/.test(path);
}

/** Refuse `/`, `/etc`, `/home`... while still allowing `/var/log/old.log`. */
export function isSystemRoot(path: string): boolean {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return SYSTEM_ROOTS.has(trimmed);
}
