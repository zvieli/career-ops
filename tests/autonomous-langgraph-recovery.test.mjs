// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationLedger } from '../lib/application-ledger.mjs';
import { mergeAutonomousPendingJobs, readAutonomousPendingJobs } from '../lib/autonomous-pending-queue.mjs';
import { readExistingState } from '../lib/application-state-machine.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const worker = join(TEST_DIR, 'fixtures', 'langgraph-domain-recovery-worker.mjs');

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-langgraph-recovery-'));
  const oldRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try { await fn(root); } finally {
    if (oldRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

function runWorker(scenario, mode, root, boundary) {
  return JSON.parse(execFileSync(process.execPath, [worker, scenario, mode, root, boundary || ''], { encoding: 'utf8' }).trim());
}

async function seed(root, scenario, facts) {
  const url = `https://jobs.example.test/${scenario}`;
  await mergeAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json'), [{
    url, company: 'Fixture Co', title: 'Software Engineer', provider: 'greenhouse',
    verification_status: 'active', liveness_verified_at: new Date().toISOString()
  }]);
  const dir = join(root, 'data', 'langgraph-fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scenario}-facts.json`), JSON.stringify(facts));
}

function evaluationCalls(root, scenario) {
  const path = join(root, 'data', 'langgraph-fixtures', `${scenario}-evaluations.jsonl`);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

function notificationSends(root) {
  const path = join(root, 'data', 'langgraph-fixtures', 'notifications.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

test('fresh process recovers hydration and terminal state/ledger writes idempotently at crash boundaries', async () => {
  for (const boundary of ['hydrated', 'canonical-fit-terminal', 'fit-events-appended', 'queue-acknowledged']) {
    await withTempRoot(async (root) => {
      await seed(root, 'reject', { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' });
      let crash;
      try { runWorker('reject', `crash:${boundary}`, root, boundary); } catch (error) { crash = error; }
      assert.equal(crash?.status, 77, `worker must terminate after ${boundary}`);
      const stateAtCrash = readExistingState('app-444444444444444444444444');
      const transitionCountAtCrash = stateAtCrash?.transitionCount;
      const resumed = runWorker('reject', 'resume', root);
      assert.equal(resumed.canonical_state, 'REJECTED_BY_POLICY');
      assert.equal(resumed.queue_acknowledged, true);
      if (transitionCountAtCrash !== undefined) assert.equal(readExistingState('app-444444444444444444444444').transitionCount, transitionCountAtCrash);
      assert.equal(evaluationCalls(root, 'reject'), 1);
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 0);
      const events = new ApplicationLedger({ dataRoot: root }).timeline('app-444444444444444444444444');
      assert.equal(events.filter((event) => event.type === 'JOB_DISCOVERED').length, 1);
      assert.equal(events.filter((event) => event.type === 'JOB_HYDRATED').length, 1);
      assert.equal(events.filter((event) => event.type === 'JOB_EVALUATED').length, 1);
      assert.equal(events.filter((event) => event.type === 'FIT_REJECTED').length, 1);
      assert.equal(events.filter((event) => event.type === 'ARTIFACT_STORED').length, 1);
      const artifactHash = events.find((event) => event.type === 'ARTIFACT_STORED').payload.sha256;
      assert.equal(events.find((event) => event.type === 'JOB_HYDRATED').payload.jd_hash, artifactHash);
    });
  }
});

test('process termination after provider evaluation but before its checkpoint exposes the documented at-least-once call window', async () => {
  await withTempRoot(async (root) => {
    await seed(root, 'reject', { professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' });
    let crash;
    try { runWorker('reject', 'crash:evaluated', root, 'evaluated'); } catch (error) { crash = error; }
    assert.equal(crash?.status, 77);
    runWorker('reject', 'resume', root);
    assert.equal(evaluationCalls(root, 'reject'), 2);
    assert.equal(new ApplicationLedger({ dataRoot: root }).timeline('app-444444444444444444444444').filter((event) => event.type === 'FIT_REJECTED').length, 1);
  });
});

test('candidate-fit interrupt resumes in another process; notification outbox deduplicates after receipt crash', async () => {
  await withTempRoot(async (root) => {
    await seed(root, 'review', {});
    let interruptExit;
    try { runWorker('review', 'start-crash-after-interrupt', root); } catch (error) { interruptExit = error; }
    assert.equal(interruptExit?.status, 77, 'process must terminate after durable candidate-fit interrupt');
    assert.equal(readExistingState('app-333333333333333333333333').state, 'NEEDS_REVIEW');
    writeFileSync(join(root, 'data', 'langgraph-fixtures', 'review-facts.json'), JSON.stringify({
      professional_years: 1, professional_yoe_verified: true, professional_years_source: 'user-stated'
    }));

    let crash;
    try { runWorker('review', 'review-resume-crash:notifications-routed', root); } catch (error) { crash = error; }
    assert.equal(crash?.status, 77, 'resume process must terminate after durable notification receipt');
    assert.equal(notificationSends(root).length, 1);
    assert.equal(evaluationCalls(root, 'review'), 1);

    const resumed = runWorker('review', 'resume', root);
    assert.equal(resumed.interrupt, 'PRE_SUBMIT_REVIEW');
    assert.equal(resumed.queue_acknowledged, false);
    assert.equal(notificationSends(root).length, 1);
    assert.equal(evaluationCalls(root, 'review'), 1);
    assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    const ledger = new ApplicationLedger({ dataRoot: root });
    assert.equal(ledger.timeline('app-333333333333333333333333').filter((event) => event.type === 'CANDIDATE_REVIEW_RESUMED').length, 1);
    assert.equal(ledger.timeline('app-333333333333333333333333').filter((event) => event.type === 'FIT_REASONABLE').length, 1);
    const stopped = runWorker('review', 'stop-resume', root);
    assert.equal(stopped.status, 'PRE_SUBMIT_REVIEW_RECORDED');
    assert.equal(notificationSends(root).length, 1);
  });
});
