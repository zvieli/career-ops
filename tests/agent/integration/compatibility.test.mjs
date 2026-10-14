// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const modulePairs = [
  ['../../../lib/application-identity.mjs', '../../../src/agent/domain/applications/application-identity.mjs'],
  ['../../../lib/application-state-machine.mjs', '../../../src/agent/domain/applications/application-state-machine.mjs'],
  ['../../../lib/candidate-fit-gate.mjs', '../../../src/agent/domain/candidate/candidate-fit-gate.mjs'],
  ['../../../lib/gpa-scale.mjs', '../../../src/agent/domain/candidate/gpa-scale.mjs'],
  ['../../../lib/cv-tailoring-engine.mjs', '../../../src/agent/domain/candidate/cv-tailoring-engine.mjs'],
  ['../../../lib/job-evaluator.mjs', '../../../src/agent/domain/jobs/job-evaluator.mjs'],
  ['../../../lib/application-ledger.mjs', '../../../src/agent/infrastructure/persistence/application-ledger.mjs'],
  ['../../../lib/autonomous-pending-queue.mjs', '../../../src/agent/infrastructure/persistence/autonomous-pending-queue.mjs'],
  ['../../../lib/run-reporter.mjs', '../../../src/agent/infrastructure/observability/run-reporter.mjs'],
  ['../../../lib/zero-cost-router.mjs', '../../../src/agent/infrastructure/model-gateway/zero-cost-router.mjs'],
  ['../../../lib/provider-availability.mjs', '../../../src/agent/infrastructure/model-gateway/provider-availability.mjs'],
  ['../../../lib/reasoning-cache.mjs', '../../../src/agent/infrastructure/model-gateway/reasoning-cache.mjs'],
  ['../../../lib/llm/provider-runner.mjs', '../../../src/agent/infrastructure/model-gateway/provider-runner.mjs'],
  ['../../../lib/notification-router.mjs', '../../../src/agent/infrastructure/communications/notification-router.mjs'],
  ['../../../lib/recruiter-email-monitor.mjs', '../../../src/agent/infrastructure/communications/recruiter-email-monitor.mjs'],
  ['../../../lib/recruiter-mailbox-adapter.mjs', '../../../src/agent/infrastructure/communications/recruiter-mailbox-adapter.mjs'],
  ['../../../lib/autofill-engine.mjs', '../../../src/agent/infrastructure/browser/autofill-engine.mjs'],
  ['../../../lib/latex-patcher.mjs', '../../../src/agent/infrastructure/documents/latex-patcher.mjs'],
  ['../../../lib/pdf-validator.mjs', '../../../src/agent/infrastructure/documents/pdf-validator.mjs'],
  ['../../../lib/autonomous-langgraph.mjs', '../../../src/agent/graph/autonomous-langgraph.mjs'],
  ['../../../scripts/autonomous-langgraph-queue.mjs', '../../../src/agent/runtime/queue-runner.mjs'],
];

test('legacy module paths re-export the canonical implementation API', async () => {
  for (const [legacyPath, canonicalPath] of modulePairs) {
    const legacy = await import(new URL(legacyPath, import.meta.url));
    const canonical = await import(new URL(canonicalPath, import.meta.url));
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(canonical).sort(), legacyPath);
  }
});

test('legacy queue command path preserves help behavior without starting a run', () => {
  const script = fileURLToPath(new URL('../../../scripts/autonomous-langgraph-queue.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/i);
});

test('model inventory carries no quota or physical-model provenance claims', async () => {
  const { readFile } = await import('node:fs/promises');
  const inventoryPath = new URL('../../../src/agent/infrastructure/model-gateway/zero-cost-model-inventory.json', import.meta.url);
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  assert.ok(inventory.length > 0);
  assert.ok(inventory.every((entry) => entry.incremental_cost === 'zero' && entry.automation_access === true));
  assert.ok(inventory.every((entry) => entry.quota_status === 'UNKNOWN'));
  assert.ok(inventory.every((entry) => entry.physical_model_provenance === 'UNKNOWN'));
});
