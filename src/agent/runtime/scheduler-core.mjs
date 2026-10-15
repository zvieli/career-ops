import { createHash } from 'node:crypto';
import { acquireRunLease, completeRunLease, heartbeatRunLease, listRunLeases } from '../infrastructure/persistence/run-lease-store.mjs';
import { appendRunEvent, createRun, getRun } from '../infrastructure/persistence/agent-run-store.mjs';

function compactWarnings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string').map(value => value.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 160)))].slice(0, 100);
}
export async function runSchedulerKernel({ dataRoot, config, clock, createExecutor }) {
  if (!config.enabled) return { started: false, status: 'SCHEDULER_DISABLED' };
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
  const acquired = acquireRunLease({ dataRoot, schedulerId: config.schedulerId, owner: `local:${process.pid}`, now, leaseMs: config.maxRuntimeMs });
  if (!acquired.acquired) return { started: false, ...acquired };
  for (const expiredLease of listRunLeases({ dataRoot }).filter(lease => lease.status === 'EXPIRED')) {
    const orphan = getRun(expiredLease.runId, { dataRoot });
    if (orphan && ['CREATED', 'RUNNING'].includes(orphan.status)) {
      const recoveredAt = new Date(Math.max(monotonicTime, Date.parse(orphan.timestamp), Date.parse(expiredLease.expiredAt)));
      appendRunEvent(orphan.run_id, 'EXPIRED', { timestamp: recoveredAt.toISOString(), failure_class: 'RUN_FATAL_FAILURE', warnings: ['LEASE_EXPIRED_OWNER_GONE'] }, { dataRoot });
    }
  }
  const runId = acquired.lease.runId;
  const configFingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(Object.assign(new Error('Scheduled shadow deadline reached.'), { code: 'SHADOW_TIMEOUT' })), config.maxRuntimeMs);
  let ownsLease = true;
  const heartbeat = () => {
    if (controller.signal.aborted) return false;
    const renewed = heartbeatRunLease({ dataRoot, runId, now: readMonotonicTime(), leaseMs: config.maxRuntimeMs });
    if (!renewed) {
      ownsLease = false;
      controller.abort(Object.assign(new Error('Scheduler lease ownership was lost.'), { code: 'LEASE_OWNERSHIP_LOST' }));
      return false;
    }
    return true;
  };
  try {
    createRun({ run_id: runId, trigger: 'manual-operator', mode: 'SHADOW_SCHEDULED', started_at: now.toISOString(), timestamp: now.toISOString(), config_fingerprint: configFingerprint, stages: [], counters: {}, warnings: [] }, { dataRoot });
    appendRunEvent(runId, 'RUNNING', { timestamp: now.toISOString() }, { dataRoot });
    const executor = await createExecutor({ dataRoot, config });
    if (typeof executor !== 'function') throw new Error('Trusted scheduler executor construction failed.');
    const value = await executor({ dataRoot, maxJobs: config.maxJobs, lease: acquired.lease, runId, mode: 'SHADOW_SCHEDULED', signal: controller.signal, heartbeat, warnings: [] });
    if (controller.signal.aborted) throw controller.signal.reason || new Error('Scheduled shadow execution was cancelled.');
    const completedAt = readMonotonicTime();
    const metrics = value?.metricsFinal || {};
    const latest = getRun(runId, { dataRoot });
    const warnings = compactWarnings([...(Array.isArray(value?.warnings) ? value.warnings : []), ...(clockRolledBack ? ['CLOCK_ROLLBACK_CLAMPED'] : [])]);
    const outcome = value?.status === 'DEGRADED' || warnings.length ? 'DEGRADED' : 'COMPLETED';
    appendRunEvent(runId, 'COMPLETED', { timestamp: completedAt.toISOString(), stages: Array.isArray(metrics.stages) ? metrics.stages : latest.stages, counters: metrics.counters && typeof metrics.counters === 'object' ? metrics.counters : latest.counters, warnings, outcome }, { dataRoot });
    if (!completeRunLease({ dataRoot, runId, status: 'COMPLETED', now: completedAt })) throw new Error('Scheduler lease completion lost ownership.');
    ownsLease = false;
    return { started: true, runId, result: value };
  } catch (error) {
    if (!ownsLease || error?.code === 'LEASE_OWNERSHIP_LOST') throw error;
    const failedAt = readMonotonicTime();
    const cancelled = controller.signal.aborted;
    try {
      const warnings = [String(error?.code || error?.name || 'Error').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 80)];
      if (clockRolledBack) warnings.push('CLOCK_ROLLBACK_CLAMPED');
      appendRunEvent(runId, cancelled ? 'CANCELLED' : 'FAILED', { timestamp: failedAt.toISOString(), failure_class: cancelled ? null : 'RUN_FATAL_FAILURE', warnings }, { dataRoot });
    } finally {
      completeRunLease({ dataRoot, runId, status: cancelled ? 'CANCELLED' : 'FAILED', now: failedAt });
      ownsLease = false;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
