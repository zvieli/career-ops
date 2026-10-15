import test from 'node:test';
import assert from 'node:assert/strict';
import { runShadowCareerPipeline } from '../../../src/agent/runtime/shadow-career-pipeline.mjs';

test('shadow pass normalizes duplicates, gates unsafe liveness, and creates local review tasks', async () => {
  const hydrated = [];
  const tasks = [];
  const jobs = [
    { title: 'Engineer', url: 'https://jobs.example/role/1?utm_source=x', company: 'Example' },
    { title: 'Engineer', url: 'https://JOBS.example/role/1', company: 'Example' },
    { title: 'Other', url: 'https://jobs.example/role/2' }
  ];
  const result = await runShadowCareerPipeline({
    runContext: { candidateFacts: {} }, budgets: { maxJobs: 5 },
    services: {
      discover: async () => jobs,
      hydrate: async job => { hydrated.push(job); return { job, jdText: 'Engineer role', hydration_status: 'FULL' }; },
      checkLiveness: async item => ({ result: item.job.url.endsWith('/2') ? 'expired' : 'active' }),
      evaluate: async () => ({ status: 'PASSED', extraction: {}, fit: { status: 'NEEDS_REVIEW', reasons: ['Evidence needed.'] } }),
      materialize: async (candidate) => {
        const task = { application_id: 'app-1234567890abcdef12345678', review_type: 'CANDIDATE_FIT_REVIEW', evidence: { fit_status: candidate.fit.status } };
        tasks.push(task); return { reviewTask: task, notificationQueued: true };
      },
      reconcile: async input => ({ reconciled: input.reviewTasks.length })
    }
  });
  assert.equal(hydrated.length, 2);
  assert.equal(result.normalized, 3);
  assert.equal(result.evaluated, 1);
  assert.match(tasks[0].application_id, /^app-[a-f0-9]{24}$/);
  assert.equal(tasks[0].review_type, 'CANDIDATE_FIT_REVIEW');
  assert.equal(result.work_performed, true);
  assert.equal(result.counters.jobs_duplicate, 1);
  assert.equal(result.counters.jobs_liveness_checked, 2);
  assert.deepEqual(result.reconciliation, { reconciled: 1 });
});

test('uncertain liveness and missing job text become human-review candidates, not active postings', async () => {
  let materialized;
  const result = await runShadowCareerPipeline({
    runContext: { runId: 'fixture-run-uncertain' }, budgets: { maxJobs: 1, maxConcurrency: 1 },
    services: {
      discover: async () => [{ title: 'Engineer', url: 'https://jobs.example/uncertain' }],
      hydrate: async job => ({ job, jdText: '', hydration_status: 'MISSING' }),
      checkLiveness: async () => ({ result: 'uncertain', reason: 'API_UNCONFIRMED' }),
      evaluate: async item => ({ status: 'NEEDS_REVIEW', policy: item.livenessUncertain ? 'LIVENESS_UNCONFIRMED' : 'JD_CONTENT_INCOMPLETE', fit: { status: 'NEEDS_REVIEW', reasons: ['Verify posting and description.'] } }),
      materialize: async candidate => { materialized = candidate; return { reviewTask: { review_type: 'CANDIDATE_FIT_REVIEW' } }; },
      reconcile: async () => ({ reconciled: 0 })
    }
  });
  assert.equal(result.evaluated, 1);
  assert.equal(result.counters.jobs_hydration_incomplete, 1);
  assert.equal(result.counters.jobs_liveness_uncertain, 1);
  assert.equal(materialized.liveness.result, 'uncertain');
  assert.equal(materialized.fit.status, 'NEEDS_REVIEW');
  assert.equal(result.reviewTasks.length, 1);
});

test('shadow pass rejects unbounded budgets and incomplete capabilities', async () => {
  await assert.rejects(runShadowCareerPipeline({ runContext: {}, budgets: { maxJobs: 101 }, services: {} }), /trusted stage services/);
  await assert.rejects(runShadowCareerPipeline({ runContext: {}, budgets: { maxJobs: 101 }, services: {
    discover() {}, hydrate() {}, checkLiveness() {}, evaluate() {}, materialize() {}, reconcile() {}
  } }), /budgets/);
});
