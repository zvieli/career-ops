import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireRunLease, completeRunLease, heartbeatRunLease, listRunLeases } from '../infrastructure/persistence/run-lease-store.mjs';
import { appendRunEvent, createRun, getRun } from '../infrastructure/persistence/agent-run-store.mjs';

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
export async function runScheduledOnce({ dataRoot, dependencies, clock = () => new Date() }) {
  const config = readSchedulerConfig({ dataRoot });
  if (!config.enabled) return { started: false, status: 'SCHEDULER_DISABLED' };
  if (!dependencies || typeof dependencies.runSafe !== 'function') throw new Error('Injected runSafe callback is required.');
  const now = clock();
  let monotonicTime = new Date(now).getTime();
  if (!Number.isFinite(monotonicTime)) throw new Error('Scheduler clock returned an invalid time.');
  let clockRolledBack = false;
  const readMonotonicTime = () => {
    const observed = new Date(clock()).getTime();
    if (!Number.isFinite(observed)) throw new Error('Scheduler clock returned an invalid time.');
    if (observed < monotonicTime) clockRolledBack = true;
    monotonicTime = Math.max(monotonicTime, observed);
    return new Date(monotonicTime);
  };
  const result = acquireRunLease({ dataRoot, schedulerId: config.schedulerId, owner: `local:${process.pid}`, now, leaseMs: config.maxRuntimeMs });
  if (!result.acquired) return { started: false, ...result };
  // Reconcile every archived expired lease, not just the lease reclaimed in this
  // invocation. A crash after replacing a lease but before receipt reconciliation
  // must not strand that earlier run forever.
  for (const expiredLease of listRunLeases({ dataRoot }).filter(lease => lease.status === 'EXPIRED')) {
    const orphan = getRun(expiredLease.runId, { dataRoot });
    if (orphan && ['CREATED', 'RUNNING'].includes(orphan.status)) {
      const recoveredAt = new Date(Math.max(monotonicTime, Date.parse(orphan.timestamp), Date.parse(expiredLease.expiredAt)));
      appendRunEvent(orphan.run_id, 'EXPIRED', { timestamp: recoveredAt.toISOString(), failure_class: 'RUN_FATAL_FAILURE', warnings: ['LEASE_EXPIRED_OWNER_GONE'] }, { dataRoot });
    }
  }
  const runId = result.lease.runId;
  const configFingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  try {
    createRun({ run_id: runId, trigger: 'manual-operator', mode: 'SHADOW_SCHEDULED', started_at: now.toISOString(), timestamp: now.toISOString(), config_fingerprint: configFingerprint, stages: [], counters: {}, warnings: [] }, { dataRoot });
    appendRunEvent(runId, 'RUNNING', { timestamp: now.toISOString() }, { dataRoot });
    const value = await dependencies.runSafe({ maxJobs: config.maxJobs, lease: result.lease, runId, mode: 'SHADOW_SCHEDULED' });
    const completedAt = readMonotonicTime();
    appendRunEvent(runId, 'COMPLETED', { timestamp: completedAt.toISOString(), warnings: clockRolledBack ? ['CLOCK_ROLLBACK_CLAMPED'] : [] }, { dataRoot });
    if (!completeRunLease({ dataRoot, runId, status: 'COMPLETED', now: completedAt })) throw new Error('Scheduler lease completion lost ownership.');
    return { started: true, runId, result: value };
  } catch (error) {
    const failedAt = readMonotonicTime();
    try {
      const warnings = [String(error?.name || 'Error').slice(0, 80)];
      if (clockRolledBack) warnings.push('CLOCK_ROLLBACK_CLAMPED');
      appendRunEvent(runId, 'FAILED', { timestamp: failedAt.toISOString(), failure_class: 'RUN_FATAL_FAILURE', warnings }, { dataRoot });
    } finally {
      completeRunLease({ dataRoot, runId, status: 'FAILED', now: failedAt });
    }
    throw error;
  }
}
export { heartbeatRunLease };
