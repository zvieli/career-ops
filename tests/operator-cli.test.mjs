import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateFactsFromSources } from '../autonomous-pipeline.mjs';
import { ApplicationLedger } from '../src/agent/infrastructure/persistence/application-ledger.mjs';
import { NotificationRouter } from '../src/agent/infrastructure/communications/notification-router.mjs';
import { mergeAutonomousPendingJobs } from '../src/agent/infrastructure/persistence/autonomous-pending-queue.mjs';
import { createAutonomousEvaluationGraph, openLangGraphCheckpointStore, stableEvaluationThreadId } from '../src/agent/graph/autonomous-langgraph.mjs';
import { getState } from '../src/agent/domain/applications/application-state-machine.mjs';
import { UserFactStore } from '../src/agent/infrastructure/persistence/inbound-events.mjs';
import { HumanReviewTaskStore } from '../src/agent/infrastructure/persistence/human-review-task-store.mjs';

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

test('operator graph resume loads only the primary candidate sources before changed-evidence validation', async () => {
  const f = fixture();
  const job = { url: 'https://jobs.example.test/role/1', company: 'Example', title: 'Software Engineer', provider: 'greenhouse', verification_status: 'active', liveness_verified_at: new Date().toISOString() };
  const jdText = 'Requires 1 year of professional software engineering experience.';
  const cvMarkdown = '# Resume\n';
  const candidateFacts = candidateFactsFromSources({}, cvMarkdown);
  mkdirSync(join(f.root, 'config'), { recursive: true });
  writeFileSync(join(f.root, 'config', 'profile.yml'), 'candidate: {}\n');
  writeFileSync(join(f.root, 'cv.md'), cvMarkdown);
  await mergeAutonomousPendingJobs(join(f.root, 'data', 'autonomous-pending.json'), [job]);
  const checkpoint = openLangGraphCheckpointStore({ dataRoot: f.root });
  let reviewTaskId;
  try {
    const graph = createAutonomousEvaluationGraph({
      checkpointer: checkpoint.checkpointer,
      dataRoot: f.root,
      dependencies: {
        queueFile: join(f.root, 'data', 'autonomous-pending.json'),
        ledger: new ApplicationLedger({ dataRoot: f.root }),
        notificationRouter: new NotificationRouter({ dataRoot: f.root, adapters: [{ id: 'fixture', isConfigured: () => true, async send() { return { status: 'DELIVERED' }; } }] }),
        resolveIdentity: () => ({ application_id: appId, identity_basis: 'canonical_url', mergeable: true }),
        hydrateJob: async item => ({ ...item, jdText, hydration_status: 'PARTIAL', hydration_source: 'fixture-known-ats', hydrated_at: new Date().toISOString(), content_hash: createHash('sha256').update(jdText).digest('hex'), content_completeness: 'description-present; completeness-unverified' }),
        loadCandidateFacts: async () => candidateFacts,
        evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
      }
    });
    const initial = await graph.invoke({ input_job: job }, { configurable: { thread_id: stableEvaluationThreadId(appId) }, durability: 'sync' });
    assert.equal(initial.__interrupt__?.[0]?.value?.type, 'CANDIDATE_FIT_REVIEW');
    reviewTaskId = new HumanReviewTaskStore({ dataRoot: f.root }).list({ applicationId: appId }).find(task => task.review_type === 'CANDIDATE_FIT_REVIEW')?.review_task_id;
    assert.ok(reviewTaskId);
  } finally { checkpoint.close(); }

  try {
    const result = f.run(['reviews', 'decide', reviewTaskId, 'EVIDENCE_UPDATED'], '');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Candidate-fit resume refused: evidence hash did not change/);
    assert.equal(new HumanReviewTaskStore({ dataRoot: f.root }).get(reviewTaskId).status, 'DECIDED');
  } finally { f.cleanup(); }
});
