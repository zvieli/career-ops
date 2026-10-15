import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { getState } from '../src/agent/domain/applications/application-state-machine.mjs';
import { UserFactStore } from '../src/agent/infrastructure/persistence/inbound-events.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appId = 'app-0123456789abcdef01234567';
const operator = fileURLToPath(new URL('../operator.mjs', import.meta.url));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'operator-cli-'));
  return { root, run: (args, input) => spawnSync(process.execPath, [operator, ...args], { cwd: process.cwd(), env: { ...process.env, CAREER_OPS_ROOT: root }, input, encoding: 'utf8' }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('operator submission confirmation reads piped input and only records explicit confirmation', () => {
  const f = fixture();
  try {
    getState(appId, { dataRoot: f.root });
    const result = f.run(['applications', 'confirm-submission', appId], 'SUBMITTED\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SUBMISSION_CONFIRMED/);
    const denied = f.run(['applications', 'confirm-submission', appId], 'NO\n');
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /No submission confirmation recorded/);
  } finally { f.cleanup(); }
});

test('operator facts provide can recover only a receipt-bound decision after a crash', async () => {
  const f = fixture();
  try {
    const canonical = getState(appId, { dataRoot: f.root });
    const store = new UserFactStore({ dataRoot: f.root, onBoundary: async point => { if (point === 'fact-decision-persisted') throw new Error('simulated crash'); } });
    const request = await store.request({ applicationId: appId, field: 'work_authorization', prompt: 'Provide work authorization', currentState: canonical.state, currentVersion: canonical.version, evidenceHash: 'a'.repeat(64) });
    await assert.rejects(store.provide({ requestId: request.request_id, value: 'Citizen', currentState: canonical.state, currentVersion: canonical.version }), /simulated crash/);
    const result = f.run(['facts', 'provide', request.request_id], 'Citizen\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FACT_RECORDED/);
    assert.equal(new UserFactStore({ dataRoot: f.root }).factsForApplication(appId).work_authorization.value, 'Citizen');
  } finally { f.cleanup(); }
});
