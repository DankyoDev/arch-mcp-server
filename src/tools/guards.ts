import { err, ok } from '../core/result.js';
import type { Result } from '../core/types.js';
import type { ToolContext } from './registry.js';

/** Return E_UNSUPPORTED with an actionable hint when a feature is missing. */
export async function requireFeature(
  ctx: ToolContext,
  feature: string,
  hint: string,
): Promise<Result<true>> {
  const capabilities = await ctx.capabilities();
  if (!capabilities.ok) return capabilities;
  if (capabilities.data.features[feature] === true) return ok(true);
  return err('E_UNSUPPORTED', `this host does not provide ${feature}`, hint);
}

/** Absolute POSIX path, no traversal tricks. */
export function validateAbsolutePath(path: string): Result<string> {
  if (!path.startsWith('/')) {
    return err('E_POLICY', 'path must be absolute', 'use a path starting with /');
  }
  if (path.includes('\0')) {
    return err('E_POLICY', 'path contains a NUL byte', 'use a plain path');
  }
  return ok(path);
}
