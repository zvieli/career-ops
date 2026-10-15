import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSchedulerKernel } from './scheduler-core.mjs';

const MIN_CADENCE = 60 * 60_000;
const MAX_CADENCE = 7 * 24 * 60 * 60_000;
export function validateSchedulerConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Scheduler config must be an object.');
  const allowedKeys = new Set(['enabled', 'mode', 'cadenceMs', 'maxRuntimeMs', 'maxJobs', 'schedulerId']);
  if (Object.keys(config).some(key => !allowedKeys.has(key))) throw new Error('Scheduler config contains unsupported settings.');
  if (typeof config.enabled !== 'boolean') throw new Error('Scheduler enabled must be explicit.');
  if (!config.enabled) return { enabled: false };
  if (config.mode !== 'shadow') throw new Error('Only shadow scheduler mode is supported.');
  if (!Number.isFinite(config.cadenceMs) || config.cadenceMs < MIN_CADENCE || config.cadenceMs > MAX_CADENCE) throw new Error('Scheduler cadence must be between 60 minutes and 7 days.');
  if (!Number.isFinite(config.maxRuntimeMs) || config.maxRuntimeMs <= 0 || config.maxRuntimeMs > 30 * 60_000) throw new Error('Scheduler maxRuntimeMs must be at most 30 minutes.');
  if (!Number.isSafeInteger(config.maxJobs) || config.maxJobs < 1 || config.maxJobs > 100) throw new Error('Scheduler maxJobs must be between 1 and 100.');
  if (config.schedulerId !== undefined && (typeof config.schedulerId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(config.schedulerId))) throw new Error('Scheduler ID is invalid.');
  return { enabled: true, mode: 'shadow', cadenceMs: config.cadenceMs, maxRuntimeMs: config.maxRuntimeMs, maxJobs: config.maxJobs, schedulerId: config.schedulerId || 'default' };
}
export function readSchedulerConfig({ dataRoot }) {
  const path = join(dataRoot, 'data', 'scheduler-config.json');
  if (!existsSync(path)) return { enabled: false };
  let config; try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Scheduler config is malformed.'); }
  return validateSchedulerConfig(config);
}

/** Production entrypoint; executor construction is project-owned and has no callback override. */
export async function runScheduledOnce({ dataRoot, clock = () => new Date() }) {
  const config = readSchedulerConfig({ dataRoot });
  return runSchedulerKernel({ dataRoot, config, clock, createExecutor: async ({ dataRoot, config }) => {
    const { createTrustedShadowExecutor } = await import('./trusted-shadow-executor.mjs');
    return createTrustedShadowExecutor({ dataRoot, maxJobs: config.maxJobs, maxRunMs: config.maxRuntimeMs });
  } });
}

export { heartbeatRunLease } from '../infrastructure/persistence/run-lease-store.mjs';
