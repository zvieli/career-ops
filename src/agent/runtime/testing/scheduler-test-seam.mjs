import { readSchedulerConfig } from '../scheduler.mjs';
import { runSchedulerKernel } from '../scheduler-core.mjs';

/** Test-only scheduler injection. Production must call runScheduledOnce(). */
export async function runScheduledOnceWithExecutorForTest({ dataRoot, executor, clock = () => new Date() }) {
  if (typeof executor !== 'function') throw new TypeError('Test executor is required.');
  const config = readSchedulerConfig({ dataRoot });
  return runSchedulerKernel({ dataRoot, config, clock, createExecutor: async () => executor });
}
