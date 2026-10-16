// @ts-check
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from '@langchain/langgraph';
import { chromium } from 'playwright';
import { extractReadOnlyFormFields } from '../../../src/agent/infrastructure/browser/ats-form-inspector.mjs';
import { createControlledFixtureBrowserSession } from '../../../src/agent/infrastructure/browser/controlled-fill-browser.mjs';
import { extractApplicationFormSchema } from '../../../src/agent/domain/applications/ats-preparation.mjs';
import { ApplicationLedger, createApplicationEventEmitter, recordJobDiscoveryEvent } from '../../../lib/application-ledger.mjs';
import { HumanReviewTaskStore } from '../../../src/agent/infrastructure/persistence/human-review-task-store.mjs';
import { decideAndResumeHumanReview } from '../../../src/agent/runtime/human-review-resume-bridge.mjs';
import { mergeAutonomousPendingJobs, readAutonomousPendingJobs } from '../../../lib/autonomous-pending-queue.mjs';
import { NotificationRouter } from '../../../lib/notification-router.mjs';
import { readExistingState } from '../../../lib/application-state-machine.mjs';
import { AUTONOMOUS_GRAPH_NODE_NAMES, assertCheckpointDomainConsistency, createAutonomousEvaluationGraph, openLangGraphCheckpointStore, stableEvaluationThreadId } from '../../../lib/autonomous-langgraph.mjs';
import { filesystemPrivacyCapabilities } from '../../../src/agent/infrastructure/persistence/filesystem-privacy.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ID = 'app-111111111111111111111111';

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-langgraph-test-'));
  const previousRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try { await fn(root); } finally {
    if (previousRoot === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

function makeJob(url = 'https://jobs.example.test/role/1') {
  return { url, company: 'Example', title: 'Software Engineer', provider: 'greenhouse', verification_status: 'active', liveness_verified_at: new Date().toISOString() };
}

function testCvSources(root) {
  mkdirSync(join(root, 'cv'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), '# Controlled candidate fixture\\n\\nVerified professional experience.');
  writeFileSync(join(root, 'cv', 'lior_zvieli_cv.tex'), '% Controlled candidate fixture\\n\\\\begin{document}\\\\end{document}');
  const factConfigPath = join(root, 'config', 'cv-facts.json');
  const sources = { markdown: readFileSync(join(root, 'cv.md')), latex: readFileSync(join(root, 'cv', 'lior_zvieli_cv.tex')),
    article: null, factConfig: existsSync(factConfigPath) ? readFileSync(factConfigPath) : null };
  return Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value === null ? null : createHash('sha256').update(value).digest('hex')]));
}

async function queueJob(root, job) {
  await mergeAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json'), [job]);
}

function makeGraph(root, options = {}) {
  const sourceHashes = testCvSources(root);
  const store = openLangGraphCheckpointStore({ dataRoot: root });
  const ledger = options.ledger || new ApplicationLedger({ dataRoot: root });
  const sent = [];
  const notificationRouter = new NotificationRouter({ dataRoot: root, adapters: [{
    id: 'fixture', isConfigured: () => true,
    async send(event) { sent.push(event.event_id); return { status: 'DELIVERED' }; }
  }] });
  const cvCalls = { generate: 0, validate: 0 };
  const graph = createAutonomousEvaluationGraph({
    checkpointer: store.checkpointer,
    dataRoot: root,
    dependencies: {
      queueFile: join(root, 'data', 'autonomous-pending.json'),
      ledger,
      notificationRouter,
      resolveIdentity: () => ({ application_id: APP_ID, identity_basis: 'canonical_url', mergeable: true }),
      hydrateJob: async (job) => {
        const jdText = 'Requires 1 year of professional software engineering experience.';
        return {
          ...job, title: job.title || 'Software Engineer', company: job.company || 'Example', jdText,
          hydration_status: 'PARTIAL', hydration_source: 'fixture-known-ats',
          hydrated_at: '2026-10-14T12:00:00.000Z',
          content_hash: createHash('sha256').update(jdText).digest('hex'),
          content_completeness: 'description-present; completeness-unverified'
        };
      },
      cvPipeline: {
        generate: async ({ jdText }) => {
          cvCalls.generate++;
          const fingerprint = createHash('sha256').update(JSON.stringify({ jdText, sourceHashes })).digest('hex');
          return { tex: '% controlled source-backed fixture', fingerprint, sourceHashes,
            policyVersion: 'test-reorder-only', factuality: { verdict: 'pass' } };
        },
        validate: async () => {
          cvCalls.validate++;
          return { pdfBytes: Buffer.from('%PDF-1.7 controlled fixture'), pageCount: 1, textCharCount: 1200,
            factuality: { passed: true, verdict: 'pass' } };
        },
        validateArtifact: ({ pdfPath } = {}) => {
          if (!pdfPath || !existsSync(pdfPath)) throw new Error('Recovered PDF validation requires the persisted PDF path.');
          return { success: true, pageCount: 1, textCharCount: 1200,
            factuality: { passed: true, verdict: 'pass' } };
        }
      },
      ...options.dependencies
    }
  });
  return { graph, store, ledger, sent, cvCalls };
}

test('production queue runner does not wire the fixture mutation controller', () => {
  const source = readFileSync(join(TEST_DIR, '../../../src/agent/runtime/queue-runner.mjs'), 'utf8');
  assert.doesNotMatch(source, /controlledFillController|fixtureApplicationFiller|createControlledFixtureBrowserSession/);
});

test('stable graph thread identity is deterministic and application-scoped', () => {
  assert.equal(stableEvaluationThreadId('app-123'), 'careerops-evaluation-v1:app-123');
  assert.equal(stableEvaluationThreadId('app-123'), stableEvaluationThreadId('app-123'));
  assert.notEqual(stableEvaluationThreadId('app-123'), stableEvaluationThreadId('app-456'));
  assert.throws(() => stableEvaluationThreadId('../escape'), /application ID/);
});

test('local SQLite checkpointer uses private durable storage and can reopen', async () => {
  await withTempRoot((root) => {
    let first;
    let second;
    try {
      first = openLangGraphCheckpointStore({ dataRoot: root });
      assert.equal(first.dbPath, join(root, 'data', 'langgraph', 'checkpoints.sqlite'));
      assert.equal(existsSync(first.dbPath), true);
      if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) {
        assert.equal(statSync(join(root, 'data', 'langgraph')).mode & 0o777, 0o700);
        assert.equal(statSync(first.dbPath).mode & 0o777, 0o600);
      } else {
        assert.equal(filesystemPrivacyCapabilities().WINDOWS_ACL_VERIFIED, false);
      }
      assert.equal(first.db.pragma('journal_mode', { simple: true }).toLowerCase(), 'wal');
      assert.equal(first.db.pragma('synchronous', { simple: true }), 2);
      first.close(); first = null;
      second = openLangGraphCheckpointStore({ dataRoot: root });
      assert.equal(typeof second.checkpointer.getTuple, 'function');
    } finally { first?.close(); second?.close(); }
  });
});

test('existing POSIX checkpoint directory and database permissions are repaired safely', async () => {
  if (!filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) return;
  await withTempRoot((root) => {
    const first = openLangGraphCheckpointStore({ dataRoot: root });
    first.close();
    const directory = join(root, 'data', 'langgraph');
    chmodSync(directory, 0o755);
    chmodSync(join(directory, 'checkpoints.sqlite'), 0o644);
    const repaired = openLangGraphCheckpointStore({ dataRoot: root });
    try {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(join(directory, 'checkpoints.sqlite')).mode & 0o777, 0o600);
    } finally { repaired.close(); }
  });
});

test('checkpoint directory symlinks are rejected before permission repair', async () => {
  await withTempRoot((root) => {
    const target = join(root, 'target-directory');
    mkdirSync(target);
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) chmodSync(target, 0o755);
    mkdirSync(join(root, 'data'));
    symlinkSync(target, join(root, 'data', 'langgraph'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => openLangGraphCheckpointStore({ dataRoot: root }), /real directory/);
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) assert.equal(statSync(target).mode & 0o777, 0o755);
  });
});

test('checkpoint database symlinks are rejected before permission repair', async (t) => {
  await withTempRoot((root) => {
    const directory = join(root, 'data', 'langgraph');
    mkdirSync(directory, { recursive: true });
    const target = join(root, 'outside.sqlite');
    writeFileSync(target, 'not a database');
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) chmodSync(target, 0o644);
    try { symlinkSync(target, join(directory, 'checkpoints.sqlite'), 'file'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`File symlink creation unavailable: ${error.code}`);
      return;
    }
    assert.throws(() => openLangGraphCheckpointStore({ dataRoot: root }), /regular file/);
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) assert.equal(statSync(target).mode & 0o777, 0o644);
  });
});

test('SQLite checkpoint resumes the next graph node in a fresh process without replaying the completed node', async () => {
  await withTempRoot((root) => {
    const worker = join(TEST_DIR, '../fixtures', 'langgraph-checkpoint-worker.mjs');
    const marker = join(root, 'completed-node.log');
    let crash;
    try { execFileSync(process.execPath, [worker, 'crash', root, marker], { encoding: 'utf8' }); }
    catch (error) { crash = error; }
    assert.equal(crash?.status, 77, 'fixture process must terminate from the next node');
    const resumed = execFileSync(process.execPath, [worker, 'resume', root, marker], { encoding: 'utf8' });
    assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['first']);
    assert.deepEqual(JSON.parse(resumed.trim()).events, ['first', 'second']);
  });
});

test('candidate-fit interrupt resumes from changed evidence without replaying evaluation; pre-submit remains a hard stop', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob();
    job.discovered_via = ['geektime-insider', 'greenhouse-api'];
    job.authoritative_provider = 'greenhouse';
    job.source_urls = ['https://insider.geektime.co.il/job/1', job.url];
    job.provider_ids = [{ provider: 'geektime-insider', id: 'GT-1' }, { provider: 'greenhouse', id: 'GH-123' }];
    await queueJob(root, job);
    let candidateFacts = {};
    let evaluationCalls = 0;
    const { graph, store, ledger, sent, cvCalls } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => candidateFacts,
      evaluate: async () => {
        evaluationCalls++;
        return { status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } };
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const paused = await graph.invoke({ input_job: job }, config);
      const hydratedCheckpoint = await graph.getState(config);
      assert.deepEqual(hydratedCheckpoint.values.job.discovered_via, ['geektime-insider', 'greenhouse-api']);
      assert.equal(hydratedCheckpoint.values.job.authoritative_provider, '', 'caller-supplied authority is discarded when the URL does not resolve to an ATS');
      assert.equal(hydratedCheckpoint.values.input_job.hydration_status, 'NOT_ATTEMPTED');
      assert.equal(hydratedCheckpoint.values.job.hydration_status, 'PARTIAL');
      assert.equal(hydratedCheckpoint.values.job.hydration_source, 'fixture-known-ats');
      assert.equal(hydratedCheckpoint.values.job.hydrated_at, '2026-10-14T12:00:00.000Z');
      assert.match(hydratedCheckpoint.values.job.content_hash, /^[a-f0-9]{64}$/);
      assert.equal(hydratedCheckpoint.values.job.content_hash, hydratedCheckpoint.values.jd_hash);
      assert.equal(hydratedCheckpoint.values.job.source_urls.length, 2);
      assert.deepEqual(hydratedCheckpoint.values.job.provider_ids, job.provider_ids);
      assert.equal(paused.__interrupt__?.[0]?.value?.type, 'CANDIDATE_FIT_REVIEW');
      assert.equal(paused.__interrupt__?.[0]?.value?.review_recovery?.review_task_id, paused.__interrupt__?.[0]?.value?.review_task_id);
      assert.equal(readExistingState(APP_ID).state, 'NEEDS_REVIEW');
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
      assert.ok(ledger.timeline(APP_ID).some((event) => event.type === 'CANDIDATE_REVIEW_PAUSED'));
      const jdArtifact = ledger.timeline(APP_ID).find((event) => event.type === 'ARTIFACT_STORED' && event.payload?.media_type === 'text/plain');
      assert.ok(jdArtifact, 'the hydrated JD is durably stored as an artifact');
      const jdText = 'Requires 1 year of professional software engineering experience.';
      const artifactContent = readFileSync(join(root, 'data', 'application-artifacts', jdArtifact.payload.relative_path), 'utf8');
      assert.equal(artifactContent, jdText);
      const checkpointText = store.db.prepare('SELECT checkpoint, metadata FROM checkpoints').all()
        .map((row) => `${Buffer.from(row.checkpoint).toString('utf8')} ${Buffer.from(row.metadata).toString('utf8')}`).join(' ');
      assert.equal(checkpointText.includes(jdText), false, 'checkpoint stores an artifact reference, not JD text');

      candidateFacts = { professional_years: 1, professional_yoe_verified: true, professional_years_source: 'user-stated' };
      const reviewStore = new HumanReviewTaskStore({ dataRoot: root });
      const fitTask = reviewStore.list({ applicationId: APP_ID }).find(task => task.review_type === 'CANDIDATE_FIT_REVIEW');
      const resumed = await decideAndResumeHumanReview({ graph, taskStore: reviewStore, reviewTaskId: fitTask.review_task_id, applicationId: APP_ID, decision: 'EVIDENCE_UPDATED', dataRoot: root });
      assert.equal(resumed.status, 'RESUMED');
      const preSubmit = resumed.result;
      assert.equal(preSubmit.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      assert.equal(readExistingState(APP_ID).state, 'CV_VALIDATED');
      assert.equal(evaluationCalls, 1);
      assert.deepEqual(cvCalls, { generate: 1, validate: 1 });
      assert.equal(preSubmit.__interrupt__[0].value.canonical_state, 'CV_VALIDATED');
      assert.equal(preSubmit.__interrupt__[0].value.review_recovery?.review_task_id, preSubmit.__interrupt__[0].value.review_task_id);
      assert.ok(preSubmit.__interrupt__[0].value.cv_artifact_ref.startsWith(`${APP_ID}/`));
      assert.ok(preSubmit.__interrupt__[0].value.pdf_artifact_ref.startsWith(`${APP_ID}/`));
      assert.ok(ledger.timeline(APP_ID).some((event) => event.type === 'CANDIDATE_REVIEW_RESUMED'));
      assert.equal(sent.length, 1);
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
      assert.equal(AUTONOMOUS_GRAPH_NODE_NAMES.includes('submit'), false);
      assert.equal(AUTONOMOUS_GRAPH_NODE_NAMES.includes('generate_cv'), true);
      assert.equal(AUTONOMOUS_GRAPH_NODE_NAMES.includes('validate_pdf'), true);
      assert.equal(preSubmit.__interrupt__[0].value.submit_capability, false);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'CV_GENERATED').length, 1);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'PDF_VALIDATED').length, 1);

      const result = await graph.invoke(new Command({ resume: { decision: 'STOP' } }), config);
      assert.equal(result.status, 'PRE_SUBMIT_REVIEW_RECORDED');
      assert.equal(result.human_decision, 'STOP');
      assert.equal(evaluationCalls, 1);
      assert.equal(sent.length, 1);
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    } finally { store.close(); }
  });
});

test('compaction keeps a successful-but-unannotated hydration distinct from evidence-backed hydration', async () => {
  await withTempRoot(async (root) => {
    const inputJob = makeJob();
    await queueJob(root, inputJob);
    const { graph, store } = makeGraph(root, { dependencies: {
      hydrateJob: async (job) => ({
        ...job, title: job.title || 'Software Engineer', company: job.company || 'Example',
        jdText: 'Requires 1 year of professional software engineering experience.'
      }),
      loadCandidateFacts: async () => ({}),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: {
        required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95,
        alternative_qualifications: false, ambiguous_yoe: false
      } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const result = await graph.invoke({ input_job: inputJob }, config);
      assert.equal(result.__interrupt__?.[0]?.value?.type, 'CANDIDATE_FIT_REVIEW');
      const checkpoint = await graph.getState(config);
      assert.equal(checkpoint.values.job.hydration_status, 'NOT_ATTEMPTED');
      assert.equal(checkpoint.values.job.hydrated_at, '');
      assert.equal(checkpoint.values.job.hydration_source, '');
      assert.equal(checkpoint.values.job.content_hash, '');
      assert.match(checkpoint.values.job.jdHash, /^[a-f0-9]{64}$/);
    } finally { store.close(); }
  });
});

test('failed hydration cannot checkpoint caller-supplied success evidence', async () => {
  await withTempRoot(async (root) => {
    const inputJob = {
      ...makeJob('https://www.linkedin.com/jobs/view/123456/?gh_jid=123'), authoritative_provider: 'greenhouse-embedded', hydration_status: 'FULL', hydration_source: 'forged-source',
      hydrated_at: '2026-10-14T12:00:00.000Z', content_hash: 'a'.repeat(64),
      content_completeness: 'claimed-complete'
    };
    const { graph, store } = makeGraph(root, { dependencies: {
      hydrateJob: async () => { throw new Error('fixture hydration failure'); }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await assert.rejects(graph.invoke({ input_job: inputJob }, config), /fixture hydration failure/);
      const checkpoint = await graph.getState(config);
      assert.equal(checkpoint.values.input_job.authoritative_provider, '', 'authority is derived from the URL, not caller input');
      assert.equal(checkpoint.values.input_job.hydration_status, 'NOT_ATTEMPTED');
      assert.equal(checkpoint.values.input_job.hydration_source, undefined);
      assert.equal(checkpoint.values.input_job.hydrated_at, undefined);
      assert.equal(checkpoint.values.input_job.content_hash, undefined);
      assert.ok(checkpoint.values.job == null, 'failed hydration does not create a compacted job');
      assert.ok(store);
    } finally { store.close(); }
  });
});

test('explicit PREPARE_APPLICATION uses read-only fixture extraction and interrupts with immutable no-submit receipt', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://boards.greenhouse.io/acme/jobs/1');
    await queueJob(root, job);
    let inspectionCalls = 0;
    let failAfterReceipt = true;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(readFileSync(join(TEST_DIR, '../../fixtures/ats/greenhouse-form.html'), 'utf8'));
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ email: 'candidate@example.test', professional_yoe_years: 0, professional_yoe_verified: true, gpa_value: 85, gpa_scale: 'GPA_SCALE_UNKNOWN' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      fixtureAtsInspector: {
        mode: 'FIXTURE_TEST', provider: 'GREENHOUSE',
        async inspect({ mode, untrustedPageContent }) {
        inspectionCalls++;
        assert.equal(mode, 'FIXTURE_TEST');
        assert.equal(untrustedPageContent, true);
        const fields = await extractReadOnlyFormFields(page);
        if (inspectionCalls > 1) fields.push({ id: 'new-question', label: 'New required question', type: 'textarea', required: true });
        return { source: 'controlled_fixture', fields };
      } },
      onNodeBoundary: async (boundary) => {
        if (boundary === 'application-preparation-receipt-persisted' && failAfterReceipt) {
          failAfterReceipt = false;
          throw new Error('controlled crash after application preparation receipt');
        }
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const review = await graph.invoke({ input_job: job }, config);
      assert.equal(review.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      assert.equal(inspectionCalls, 0, 'no browser inspection before explicit human authorization');
      await assert.rejects(graph.invoke(new Command({ resume: { decision: 'PREPARE_APPLICATION' } }), config), /controlled crash after application preparation receipt/);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_PREPARED').length, 1);
      const checkpoint = await graph.getState(config);
      assert.equal(assertCheckpointDomainConsistency({ values: checkpoint.values, expectedApplicationId: APP_ID, expectedUrl: job.url,
        canonicalState: readExistingState(APP_ID, { dataRoot: root }), ledgerEvents: ledger.timeline(APP_ID), dataRoot: root }), true);
      const prepared = await graph.invoke(null, config);
      assert.equal(prepared.__interrupt__?.[0]?.value?.type, 'ATS_PREPARATION_REVIEW');
      const reviewItems = new HumanReviewTaskStore({ dataRoot: root }).inbox().filter(item => item.application_id === APP_ID && item.review_type === 'ATS_PREPARATION_REVIEW');
      assert.equal(reviewItems.length, 1);
      assert.deepEqual(reviewItems[0].allowed_decisions, ['STOP', 'CONTINUE_MANUALLY', 'FILL_APPLICATION']);
      assert.equal(inspectionCalls, 3, 'schema extraction and recovery revalidation both used the controlled read-only fixture');
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'READY_TO_FILL');
      assert.equal(prepared.__interrupt__[0].value.submit_capability, false, JSON.stringify(prepared.__interrupt__[0].value));
      assert.equal(prepared.__interrupt__[0].value.submission_performed, false);
      assert.equal(prepared.__interrupt__[0].value.ats_provider, 'GREENHOUSE');
      assert.equal(prepared.__interrupt__[0].value.review_recovery?.review_task_id, prepared.__interrupt__[0].value.review_task_id);
      const preparedState = await graph.getState(config);
      assert.ok(preparedState.values.field_mappings.every((field) => field.proposed_value === null));
      assert.equal(JSON.stringify(preparedState.values.field_mappings).includes('candidate@example.test'), false);
      const prepEvents = ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_PREPARED');
      assert.equal(prepEvents.length, 1);
      assert.equal(prepEvents[0].payload.form_fields_discovered, 17);
      assert.equal(prepEvents[0].payload.submission_performed, false);
      assert.equal(ledger.timeline(APP_ID).some((event) => event.type === 'APPLICATION_SUBMITTED_CONFIRMED'), false);
      assert.equal(prepared.__interrupt__[0].value.field_count, 17);
      assert.ok(prepared.__interrupt__[0].value.do_not_answer_fields.includes('hidden-email'));
      assert.match(prepared.__interrupt__[0].value.preparation_blockers.join(' '), /schema changed/i);
      const readyState = readExistingState(APP_ID, { dataRoot: root });
      assert.equal(assertCheckpointDomainConsistency({ values: preparedState.values, expectedApplicationId: APP_ID, expectedUrl: job.url,
        canonicalState: readyState, ledgerEvents: ledger.timeline(APP_ID), dataRoot: root }), true);
      const receiptPath = join(root, 'data', 'application-artifacts', readyState.metadata.READY_TO_FILL.preparationReceiptRef);
      unlinkSync(receiptPath);
      assert.throws(() => assertCheckpointDomainConsistency({ values: preparedState.values, expectedApplicationId: APP_ID, expectedUrl: job.url,
        canonicalState: readyState, ledgerEvents: ledger.timeline(APP_ID), dataRoot: root }), /ENOENT|artifact|receipt/i);
      assert.equal(AUTONOMOUS_GRAPH_NODE_NAMES.some((name) => /submit|apply|send_application/i.test(name)), false);
      const stopped = await graph.invoke(new Command({ resume: { decision: 'STOP' } }), config);
      assert.equal(stopped.status, 'ATS_PREPARATION_REVIEW_RECORDED');
      assert.equal(new HumanReviewTaskStore({ dataRoot: root }).get(reviewItems[0].review_task_id).status, 'DECIDED');
    } finally { store.close(); await browser.close(); }
  });
});

test('FILL_APPLICATION is explicit, emits a filled receipt, and final-review resume does not rerun mutation', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://boards.greenhouse.io/acme/jobs/1');
    await queueJob(root, job);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const fixtureHtml = '<form><label for="email">Email</label><input id="email" type="email"><label for="resume">Resume</label><input id="resume" type="file"></form>';
    await page.setContent(fixtureHtml);
    const controller = await createControlledFixtureBrowserSession({ provider: 'GREENHOUSE', applicationUrl: job.url, html: fixtureHtml, dataRoot: root, applicationId: APP_ID });
    const injectedCrashes = new Set(['controlled-fill-receipt-artifact-stored', 'controlled-fill-ledger-event-persisted', 'controlled-fill-canonical-transitioned']);
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ email: 'candidate@example.test', email_source: 'config/profile.yml:candidate.email', professional_years: 1, professional_yoe_verified: true, professional_years_source: 'user-stated' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      fixtureAtsInspector: { mode: 'FIXTURE_TEST', provider: 'GREENHOUSE', async inspect() { return { fields: await extractReadOnlyFormFields(page), source: 'controlled_fixture' }; } },
      controlledFillController: controller,
      onNodeBoundary: async (boundary) => {
        if (injectedCrashes.has(boundary)) {
          injectedCrashes.delete(boundary);
          throw new Error(`injected crash at ${boundary}`);
        }
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const preSubmit = await graph.invoke({ input_job: job }, config);
      assert.equal(preSubmit.__interrupt__[0].value.type, 'PRE_SUBMIT_REVIEW');
      const prepared = await graph.invoke(new Command({ resume: { decision: 'PREPARE_APPLICATION' } }), config);
      assert.equal(prepared.__interrupt__[0].value.type, 'ATS_PREPARATION_REVIEW');
      assert.equal(controller.getMetrics().field_mutation_count, 0, 'PREPARE_APPLICATION alone does not mutate fields');
      await assert.rejects(graph.invoke(new Command({ resume: { decision: 'FILL_APPLICATION' } }), config), /injected crash at controlled-fill-receipt-artifact-stored/);
      await assert.rejects(graph.invoke(null, config), /injected crash at controlled-fill-ledger-event-persisted/);
      await assert.rejects(graph.invoke(null, config), /injected crash at controlled-fill-canonical-transitioned/);
      const filledState = readExistingState(APP_ID, { dataRoot: root });
      assert.equal(filledState.state, 'FORM_FILLED');
      const stateAhead = await graph.getState(config);
      assert.doesNotThrow(() => assertCheckpointDomainConsistency({ values: stateAhead.values, expectedApplicationId: APP_ID, expectedUrl: job.url,
        canonicalState: filledState, ledgerEvents: ledger.timeline(APP_ID), dataRoot: root }), 'fresh-process preflight accepts only matching durable FORM_FILLED evidence');
      const review = await graph.invoke(null, config);
      assert.equal(review.__interrupt__[0].value.type, 'FINAL_HUMAN_REVIEW');
      assert.equal(review.__interrupt__[0].value.review_recovery?.review_task_id, review.__interrupt__[0].value.review_task_id);
      const reviewItems = new HumanReviewTaskStore({ dataRoot: root }).inbox().filter(item => item.application_id === APP_ID && item.review_type === 'FINAL_HUMAN_REVIEW');
      assert.equal(reviewItems.length, 1);
      assert.deepEqual(reviewItems[0].allowed_decisions, ['STOP', 'CONTINUE_MANUALLY', 'EDIT_REQUIRED', 'REFILL_REQUIRED']);
      assert.equal(review.__interrupt__[0].value.submission_performed, false);
      assert.equal(review.__interrupt__[0].value.submit_capability, false);
      assert.equal(review.__interrupt__[0].value.current_page_state, 'NOT_ATTACHED; receipt is historical evidence only');
      assert.equal(controller.getMetrics().field_mutation_count, 2);
      assert.equal(review.__interrupt__[0].value.filled_fields.filter((field) => field.semantic_type === 'RESUME').length, 1);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_FILLED').length, 1);
      const stopped = await graph.invoke(new Command({ resume: { decision: 'STOP' } }), config);
      assert.equal(stopped.status, 'APPLICATION_FILLED');
      assert.equal(controller.getMetrics().field_mutation_count, 2, 'resuming final review must not replay browser mutation');
      const fillRef = filledState.metadata.FORM_FILLED.fillReceiptRef;
      const artifactPath = join(root, 'data', 'application-artifacts', fillRef);
      const originalReceipt = readFileSync(artifactPath);
      writeFileSync(artifactPath, Buffer.from(originalReceipt.toString().replace('"fill_status":"FILLED"', '"fill_status":"TAMPERED"')));
      const finalCheckpoint = await graph.getState(config);
      assert.throws(() => assertCheckpointDomainConsistency({ values: finalCheckpoint.values, expectedApplicationId: APP_ID, expectedUrl: job.url,
        canonicalState: readExistingState(APP_ID, { dataRoot: root }), ledgerEvents: ledger.timeline(APP_ID), dataRoot: root }), /hash|receipt|artifact/i);
    } finally { store.close(); await controller.close(); await browser.close(); }
  });
});

test('browser interlock failure persists APPLICATION_FILL_NEEDS_REVIEW and never transitions to FORM_FILLED', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://boards.greenhouse.io/acme/jobs/2');
    await queueJob(root, job);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const fixtureHtml = `<form><label for="email">Email</label><input id="email" type="email"></form><script>
      document.querySelector('#email').addEventListener('input',()=>{
        window.__controlledFillAudit={blocked:0};
        HTMLFormElement.prototype.submit=function(){};
        try { Object.defineProperty(HTMLFormElement.prototype,'requestSubmit',{configurable:true,writable:true,value:function(){}}); } catch {}
        document.querySelector('form').submit();document.querySelector('form').requestSubmit();fetch('/submit',{method:'POST',body:'fixture'});
      });
    </script>`;
    await page.setContent(fixtureHtml);
    const controller = await createControlledFixtureBrowserSession({ provider: 'GREENHOUSE', applicationUrl: job.url, html: fixtureHtml, dataRoot: root, applicationId: APP_ID });
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ email: 'candidate@example.test', email_source: 'config/profile.yml:candidate.email', professional_years: 1, professional_yoe_verified: true, professional_years_source: 'user-stated' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      fixtureAtsInspector: { mode: 'FIXTURE_TEST', provider: 'GREENHOUSE', async inspect() { return { fields: await extractReadOnlyFormFields(page), source: 'controlled_fixture' }; } },
      controlledFillController: controller
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await graph.invoke({ input_job: job }, config);
      await graph.invoke(new Command({ resume: { decision: 'PREPARE_APPLICATION' } }), config);
      const review = await graph.invoke(new Command({ resume: { decision: 'FILL_APPLICATION' } }), config);
      assert.equal(review.__interrupt__[0].value.type, 'FINAL_HUMAN_REVIEW');
      assert.equal(review.__interrupt__[0].value.status, 'APPLICATION_FILL_NEEDS_REVIEW');
      assert.equal(review.__interrupt__[0].value.submission_performed, false);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'READY_TO_FILL');
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_FILL_NEEDS_REVIEW').length, 1);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_FILLED').length, 0);
      assert.ok(controller.getMetrics().blocked_submission_attempts > 0);
      assert.ok(controller.getMetrics().mutation_network_events > 0);
      assert.equal(controller.getMetrics().submission_requests_delivered, 0);
      await graph.invoke(new Command({ resume: { decision: 'STOP' } }), config);
      const finalTask = new HumanReviewTaskStore({ dataRoot: root }).list({ applicationId: APP_ID }).find(task => task.review_type === 'FINAL_HUMAN_REVIEW');
      assert.equal(finalTask.status, 'DECIDED');
      assert.equal(controller.getMetrics().submission_requests_delivered, 0);
    } finally { store.close(); await controller.close(); await browser.close(); }
  });
});

test('recognized live providers without read-only adapters stay CV_VALIDATED and recover without false READY_TO_FILL', async () => {
  for (const [provider, url] of [
    ['greenhouse', 'https://boards.greenhouse.io/acme/jobs/11'],
    ['lever', 'https://jobs.lever.co/acme/11']
  ]) {
    await withTempRoot(async (root) => {
      const job = makeJob(url);
      job.provider = provider;
      await queueJob(root, job);
      let forbiddenInspectorCalls = 0;
      let failOnce = true;
      const { graph, store, ledger } = makeGraph(root, { dependencies: {
        loadCandidateFacts: async () => ({ professional_yoe_years: 0, professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml:candidate.professional_yoe_years' }),
        evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
        inspectApplication: async () => { forbiddenInspectorCalls++; throw new Error('live inspector must not be called without capability'); },
        onNodeBoundary: async (boundary) => {
          if (boundary === 'ats-preparation-receipt-artifact-stored' && failOnce) { failOnce = false; throw new Error('crash after unextracted form receipt'); }
        }
      } });
      const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
      try {
        const cvReview = await graph.invoke({ input_job: job }, config);
        assert.equal(cvReview.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
        await assert.rejects(graph.invoke(new Command({ resume: { decision: 'PREPARE_APPLICATION' } }), config), /crash after unextracted form receipt/);
        assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
        assert.equal(forbiddenInspectorCalls, 0);
        const recovered = await graph.invoke(null, config);
        const review = recovered.__interrupt__?.[0]?.value;
        assert.equal(review?.type, 'ATS_PREPARATION_REVIEW');
        assert.equal(review.extraction_status, 'NEEDS_REVIEW');
        assert.equal(review.ats_status, 'HOST_RECOGNIZED');
        assert.equal(review.ats_capability.liveExtractionSupported, false);
        assert.match(review.preparation_blockers.join(' '), /host recognition alone is not form extraction/i);
        assert.equal(review.canonical_state, 'CV_VALIDATED');
        assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
        assert.equal(forbiddenInspectorCalls, 0);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_PREPARED').length, 1);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'ARTIFACT_STORED' && /^ats-schema-/.test(event.payload?.name || '')).length, 1);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_SUBMITTED_CONFIRMED').length, 0);
        const checkpoint = await graph.getState(config);
        assert.equal(checkpoint.values.canonical_state, 'CV_VALIDATED');
      } finally { store.close(); }
    });
  }
});

test('ATS crash matrix recovers every durable boundary without duplicate state, artifacts, events, or external actions', async () => {
  const boundaries = [
    'ats-detection-complete', 'ats-schema-extraction-complete', 'ats-field-mapping-complete',
    'ats-schema-artifact-stored', 'ats-preparation-receipt-artifact-stored',
    'ats-ready-to-fill-transitioned', 'application-prepared-ledger-event-persisted',
    'before-ats-preparation-review-interrupt'
  ];
  for (const crashBoundary of boundaries) {
    await withTempRoot(async (root) => {
      const job = makeJob('https://boards.greenhouse.io/acme/jobs/crash-matrix');
      await queueJob(root, job);
      let failOnce = true;
      let fixtureInspections = 0;
      const fields = [{ id: 'email', name: 'email', label: 'Email', type: 'email', required: true }];
      const { graph, store, ledger } = makeGraph(root, { dependencies: {
        loadCandidateFacts: async () => ({ email: 'candidate@example.test', email_source: 'config/profile.yml:candidate.email', professional_yoe_years: 0, professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml:candidate.professional_yoe_years' }),
        evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
        fixtureAtsInspector: { mode: 'FIXTURE_TEST', provider: 'GREENHOUSE', async inspect() { fixtureInspections++; return { source: 'controlled_fixture', fields }; } },
        onNodeBoundary: async (boundary) => {
          if (boundary === crashBoundary && failOnce) { failOnce = false; throw new Error(`controlled crash at ${boundary}`); }
        }
      } });
      const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
      try {
        const cvReview = await graph.invoke({ input_job: job }, config);
        assert.equal(cvReview.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
        await assert.rejects(graph.invoke(new Command({ resume: { decision: 'PREPARE_APPLICATION' } }), config), new RegExp(`controlled crash at ${crashBoundary}`));
        const interruptedCheckpoint = await graph.getState(config);
        const canonicalAfterCrash = readExistingState(APP_ID, { dataRoot: root });
        const eventsAfterCrash = ledger.timeline(APP_ID);
        assert.equal(assertCheckpointDomainConsistency({ values: interruptedCheckpoint.values, expectedApplicationId: APP_ID, expectedUrl: job.url,
          canonicalState: canonicalAfterCrash, ledgerEvents: eventsAfterCrash, dataRoot: root }), true, crashBoundary);
        const canonicalBeforeResume = canonicalAfterCrash;
        const resumed = await graph.invoke(null, config);
        assert.equal(resumed.__interrupt__?.[0]?.value?.type, 'ATS_PREPARATION_REVIEW', crashBoundary);
        const canonicalAfterResume = readExistingState(APP_ID, { dataRoot: root });
        assert.equal(canonicalAfterResume.state, 'READY_TO_FILL', crashBoundary);
        assert.equal(canonicalAfterResume.transitionCount, canonicalBeforeResume.transitionCount + (canonicalBeforeResume.state === 'READY_TO_FILL' ? 0 : 1), `one and only one canonical READY_TO_FILL transition at ${crashBoundary}`);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_PREPARED').length, 1, crashBoundary);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'ARTIFACT_STORED' && /^ats-schema-/.test(event.payload?.name || '')).length, 1, crashBoundary);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'ARTIFACT_STORED' && /^application-prepared-/.test(event.payload?.name || '')).length, 1, crashBoundary);
        assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'APPLICATION_SUBMITTED_CONFIRMED').length, 0, crashBoundary);
        assert.equal(fixtureInspections >= 2, true, crashBoundary);
        const checkpoint = await graph.getState(config);
        assert.equal(checkpoint.values.application_id, APP_ID);
        assert.equal(checkpoint.values.jd_hash, canonicalAfterResume.metadata.READY_TO_FILL.jdHash);
        assert.equal(checkpoint.values.pdf_artifact_sha256, canonicalAfterResume.metadata.CV_VALIDATED.pdfSha256);
      } finally { store.close(); }
    });
  }
});

test('CV/PDF state-ahead recovery verifies immutable receipts and does not duplicate transitions', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/cv-recovery');
    await queueJob(root, job);
    let failOnce = true;
    const { graph, store, ledger, cvCalls } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      onNodeBoundary: async (boundary) => {
        if (boundary === 'canonical-pdf-validated-transitioned' && failOnce) { failOnce = false; throw new Error('controlled crash after state transition'); }
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await assert.rejects(graph.invoke({ input_job: job }, config), /controlled crash/);
      const checkpoint = await graph.getState(config);
      const canonical = readExistingState(APP_ID, { dataRoot: root });
      const events = ledger.timeline(APP_ID);
      assert.equal(canonical.state, 'CV_VALIDATED');
      assert.equal(events.filter((event) => event.type === 'PDF_VALIDATED').length, 0);
      assert.equal(assertCheckpointDomainConsistency({ values: checkpoint.values, expectedApplicationId: APP_ID,
        expectedUrl: job.url, canonicalState: canonical, ledgerEvents: events, dataRoot: root }), true);
      const resumed = await graph.invoke(null, config);
      assert.equal(resumed.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
      assert.deepEqual(cvCalls, { generate: 1, validate: 1 });
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'CV_GENERATED').length, 1);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'PDF_VALIDATED').length, 1);
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    } finally { store.close(); }
  });
});

test('LangGraph reuses the canonical JOB_DISCOVERED receipt for an application previously seen by legacy orchestration', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/legacy-discovery');
    await queueJob(root, job);
    const ledger = new ApplicationLedger({ dataRoot: root });
    const legacyEmit = createApplicationEventEmitter(ledger, 'legacy-autonomous');
    await recordJobDiscoveryEvent(legacyEmit, APP_ID);
    const { graph, store } = makeGraph(root, { ledger, dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const result = await graph.invoke({ input_job: job }, config);
      assert.equal(result.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      const discoveries = ledger.timeline(APP_ID).filter((event) => event.type === 'JOB_DISCOVERED');
      assert.equal(discoveries.length, 1);
      assert.deepEqual(discoveries[0].payload, {});
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
    } finally { store.close(); }
  });
});

test('failed PDF validation remains short of CV_VALIDATED and leaves the queue pending', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/cv-fail-closed');
    await queueJob(root, job);
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      cvPipeline: {
        generate: async ({ jdText }) => ({ tex: 'source-backed tex', fingerprint: createHash('sha256').update(JSON.stringify({ jdText, sourceHashes: testCvSources(root) })).digest('hex'),
          sourceHashes: testCvSources(root), policyVersion: 'test-reorder-only' }),
        validate: async () => ({ success: false, errors: ['controlled compile failure'] }),
        validateArtifact: () => ({ success: false, factuality: { passed: false } })
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await assert.rejects(graph.invoke({ input_job: job }, config), /did not return a passing source-backed validation receipt/);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_GENERATED');
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'CV_GENERATED').length, 1);
      assert.equal(ledger.timeline(APP_ID).filter((event) => event.type === 'PDF_VALIDATED').length, 0);
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    } finally { store.close(); }
  });
});

test('graph fresh-PDF receipt rejects multiple pages and text at or below the canonical threshold', async () => {
  for (const quality of [{ pageCount: 2, textCharCount: 1201 }, { pageCount: 1, textCharCount: 1000 }]) {
    await withTempRoot(async (root) => {
      const job = makeJob(`https://jobs.example.test/role/graph-quality-${quality.pageCount}-${quality.textCharCount}`);
      await queueJob(root, job);
      const sourceHashes = testCvSources(root);
      const { graph, store } = makeGraph(root, { dependencies: {
        loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
        evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
        cvPipeline: {
          generate: async ({ jdText }) => ({ tex: 'fixture TeX', fingerprint: createHash('sha256').update(JSON.stringify({ jdText, sourceHashes })).digest('hex'), sourceHashes, policyVersion: 'test' }),
          validate: async () => ({ pdfBytes: Buffer.from('%PDF fixture'), ...quality, factuality: { passed: true, verdict: 'pass' } }),
          validateArtifact: () => ({ success: false })
        }
      } });
      const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
      try {
        await assert.rejects(graph.invoke({ input_job: job }, config), /did not return a passing source-backed validation receipt/);
        assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_GENERATED');
        assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
      } finally { store.close(); }
    });
  }
});

test('graph recovery-PDF receipt enforces the same strict one-page and >1000-text policy', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/recovery-quality');
    await queueJob(root, job);
    const sourceHashes = testCvSources(root);
    const ledger = new ApplicationLedger({ dataRoot: root });
    const recordEvent = ledger.recordEvent.bind(ledger);
    let crashOnce = true;
    ledger.recordEvent = async (event) => {
      if (crashOnce && event.type === 'ARTIFACT_STORED' && event.payload?.media_type === 'application/pdf') {
        crashOnce = false;
        throw new Error('controlled crash after PDF publication');
      }
      return recordEvent(event);
    };
    const { graph, store } = makeGraph(root, { ledger, dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      cvPipeline: {
        generate: async ({ jdText }) => ({ tex: 'fixture TeX', fingerprint: createHash('sha256').update(JSON.stringify({ jdText, sourceHashes })).digest('hex'), sourceHashes, policyVersion: 'test' }),
        validate: async () => ({ pdfBytes: Buffer.from('%PDF fixture'), pageCount: 1, textCharCount: 1201, factuality: { passed: true, verdict: 'pass' } }),
        validateArtifact: () => ({ success: true, pageCount: 2, textCharCount: 1201, factuality: { passed: true, verdict: 'pass' } })
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await assert.rejects(graph.invoke({ input_job: job }, config), /controlled crash after PDF publication/);
      await assert.rejects(graph.invoke(null, config), /Recovered PDF artifact did not pass source-backed validation/);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_GENERATED');
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    } finally { store.close(); }
  });
});

test('canonical CV_VALIDATED receipt reconciliation rejects noncanonical PDF quality metadata', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/tampered-quality-receipt');
    await queueJob(root, job);
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const paused = await graph.invoke({ input_job: job }, config);
      assert.equal(paused.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      const statePath = join(root, 'data', 'applications', APP_ID, 'state.json');
      const canonical = JSON.parse(readFileSync(statePath, 'utf8'));
      canonical.metadata.CV_VALIDATED.pageCount = 2;
      canonical.metadata.CV_VALIDATED.validation.pageCount = 2;
      writeFileSync(statePath, JSON.stringify(canonical));
      const values = (await graph.getState(config)).values;
      await assert.rejects(Promise.resolve().then(() => assertCheckpointDomainConsistency({ values,
        expectedApplicationId: APP_ID, expectedUrl: job.url, canonicalState: readExistingState(APP_ID, { dataRoot: root }),
        ledgerEvents: ledger.timeline(APP_ID), dataRoot: root })), /PDF quality receipt/);
    } finally { store.close(); }
  });
});

test('PDF stage rejects canonical CV sources changed after the generation fingerprint', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/stale-cv-source');
    await queueJob(root, job);
    let validationCalls = 0;
    const { graph, store } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
      cvPipeline: {
        generate: async ({ jdText }) => {
          const sourceHashes = testCvSources(root);
          const fingerprint = createHash('sha256').update(JSON.stringify({ jdText, sourceHashes })).digest('hex');
          writeFileSync(join(root, 'cv.md'), '# Changed candidate source after generation');
          return { tex: 'sourced tex', fingerprint, sourceHashes, policyVersion: 'test-reorder-only' };
        },
        validate: async () => { validationCalls++; throw new Error('must not compile stale sources'); },
        validateArtifact: () => ({ success: false, factuality: { passed: false } })
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await assert.rejects(graph.invoke({ input_job: job }, config), /source changed after generation/);
      assert.equal(validationCalls, 0);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_GENERATED');
    } finally { store.close(); }
  });
});

test('PRE_SUBMIT_REVIEW resume blocks when canonical CV sources changed after PDF validation', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/cv-source-edited');
    await queueJob(root, job);
    const { graph, store } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const review = await graph.invoke({ input_job: job }, config);
      assert.equal(review.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      writeFileSync(join(root, 'cv.md'), '# Changed after validation');
      await assert.rejects(graph.invoke(new Command({ resume: { decision: 'STOP' } }), config), /source changed after generation/);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    } finally { store.close(); }
  });
});

test('PRE_SUBMIT_REVIEW resume blocks when the fact-policy config changes after PDF validation', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/fact-policy-edited');
    await queueJob(root, job);
    const { graph, store } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const review = await graph.invoke({ input_job: job }, config);
      assert.equal(review.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, 'config', 'cv-facts.json'), '{"allow_facts":[]}');
      await assert.rejects(graph.invoke(new Command({ resume: { decision: 'STOP' } }), config), /source changed after generation/);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1);
    } finally { store.close(); }
  });
});

test('recovery repairs an artifact-store/event-ledger crash before advancing CV_VALIDATED', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/pdf-artifact-receipt');
    await queueJob(root, job);
    const ledger = new ApplicationLedger({ dataRoot: root });
    const recordEvent = ledger.recordEvent.bind(ledger);
    let crashOnce = true;
    ledger.recordEvent = async (event) => {
      if (crashOnce && event.type === 'ARTIFACT_STORED' && event.payload?.media_type === 'application/pdf') {
        crashOnce = false;
        throw new Error('controlled crash after PDF bytes were published');
      }
      return recordEvent(event);
    };
    const { graph, store } = makeGraph(root, { ledger, dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 2, professional_yoe_verified: true, professional_years_source: 'cv.md' }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 1, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      await assert.rejects(graph.invoke({ input_job: job }, config), /controlled crash after PDF bytes/);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_GENERATED');
      const resumed = await graph.invoke(null, config);
      assert.equal(resumed.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      const events = ledger.timeline(APP_ID);
      const pdf = events.find((event) => event.type === 'PDF_VALIDATED');
      assert.ok(pdf);
      assert.equal(events.filter((event) => event.type === 'ARTIFACT_STORED' && event.payload?.relative_path === pdf.payload.pdf_artifact_ref).length, 1);
      assert.equal(readExistingState(APP_ID, { dataRoot: root }).state, 'CV_VALIDATED');
    } finally { store.close(); }
  });
});

test('explicit provider-failure retry requires a user-confirmed override and reuses the archived JD', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/provider-retry');
    await queueJob(root, job);
    let evaluations = 0;
    const activeOverrides = [];
    const override = { provider: 'antigravity', unavailable_until: '2026-10-21T06:14:32.000Z', reason: 'quota_exhausted', source: 'user_confirmed', status: 'active' };
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      providerAvailabilityOverrides: activeOverrides,
      loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' }),
      evaluate: async () => {
        evaluations++;
        if (evaluations === 1) return { status: 'NEEDS_REVIEW', reason: 'PROVIDER_FAILURE_NON_RETRYABLE', provider_attempts: [
          { provider: 'antigravity', requested_model_id: 'antigravity/gemini-3.8-flash', attempt: 1 }
        ] };
        return { status: 'PASSED', tier: 1, extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } };
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const first = await graph.invoke({ input_job: job }, config);
      assert.equal(first.status, 'NEEDS_REVIEW');
      const statePath = join(root, 'data', 'applications', APP_ID, 'state.json');
      const canonical = JSON.parse(readFileSync(statePath, 'utf8'));
      delete canonical.metadata.NEEDS_REVIEW.jdHash;
      writeFileSync(statePath, JSON.stringify(canonical));
      await assert.rejects(graph.invoke(new Command({ resume: { action: 'provider_failure_retry' } }), config), /active user-confirmed availability override/);
      activeOverrides.push(override);
      const retried = await graph.invoke(new Command({ resume: { action: 'provider_failure_retry' } }), config);
      assert.equal(retried.status, 'CV_VALIDATED');
      assert.equal(retried.evaluation_attempt, 2);
      assert.equal(evaluations, 2);
      const events = ledger.timeline(APP_ID);
      assert.equal(events.filter((event) => event.type === 'EVALUATION_RETRY_AUTHORIZED').length, 1);
      assert.equal(events.filter((event) => event.type === 'JOB_EVALUATED').length, 2);
      const authorization = events.find((event) => event.type === 'EVALUATION_RETRY_AUTHORIZED');
      assert.equal(authorization.payload.provider_overrides[0].source, 'user_confirmed');
      assert.equal(authorization.payload.provider_overrides[0].reason, 'quota_exhausted');
      assert.equal(readExistingState(APP_ID).state, 'CV_VALIDATED');
    } finally { store.close(); }
  });
});

test('retry node refuses conflicting canonical JD hashes without authorizing or reevaluating', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/conflicting-provider-retry');
    await queueJob(root, job);
    let evaluations = 0;
    const activeOverrides = [{ provider: 'antigravity', unavailable_until: '2026-10-21T06:14:32.000Z', reason: 'quota_exhausted', source: 'user_confirmed', status: 'active' }];
    const { graph, store, ledger } = makeGraph(root, { dependencies: {
      providerAvailabilityOverrides: activeOverrides,
      loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' }),
      evaluate: async () => {
        evaluations++;
        if (evaluations === 1) return { status: 'NEEDS_REVIEW', reason: 'PROVIDER_FAILURE_NON_RETRYABLE', provider_attempts: [
          { provider: 'antigravity', requested_model_id: 'antigravity/gemini-3.8-flash', attempt: 1 }
        ] };
        return { status: 'PASSED', tier: 1, extraction: { required_yoe: 0, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } };
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const first = await graph.invoke({ input_job: job }, config);
      assert.equal(first.status, 'NEEDS_REVIEW');
      const statePath = join(root, 'data', 'applications', APP_ID, 'state.json');
      const canonical = JSON.parse(readFileSync(statePath, 'utf8'));
      canonical.metadata.NEEDS_REVIEW.jdHash = 'c'.repeat(64);
      writeFileSync(statePath, JSON.stringify(canonical));
      const eventsBefore = ledger.timeline(APP_ID);
      await assert.rejects(graph.invoke(new Command({ resume: { action: 'provider_failure_retry' } }), config), /Canonical review JD hash conflicts/);
      assert.equal(evaluations, 1);
      assert.deepEqual(ledger.timeline(APP_ID), eventsBefore);
      const stateAfter = readExistingState(APP_ID, { dataRoot: root });
      assert.equal(stateAfter.state, 'NEEDS_REVIEW');
      assert.equal(stateAfter.metadata.NEEDS_REVIEW.jdHash, 'c'.repeat(64));
    } finally { store.close(); }
  });
});

test('graph checkpoints allowlisted admission fields only, excluding supplied JD and secret extras', async () => {
  await withTempRoot(async (root) => {
    const job = {
      ...makeJob('https://jobs.example.test/role/private-input'),
      jdText: 'SUPPLIED_JD_SENTINEL', apiToken: 'SUPPLIED_SECRET_SENTINEL',
      discovered_via: 'x'.repeat(101), source_urls: 'https://attacker.example/source', provider_ids: 'unvalidated-provider-id',
      nested: { credential: 'NESTED_SECRET_SENTINEL' }
    };
    await queueJob(root, job);
    const { graph, store } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true }),
      evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } })
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const unsafeEnvelope = {
        input_job: job,
        evaluation: { status: 'PASSED', sentinel: 'TOP_LEVEL_SECRET_SENTINEL' },
        evaluation_hash: 'attacker-controlled-hash',
        job: { jdText: 'TOP_LEVEL_JD_SENTINEL' },
        fit: { status: 'STRONG', sentinel: 'TOP_LEVEL_STATE_SENTINEL' },
        review_evidence: { secret: 'TOP_LEVEL_REVIEW_SECRET_SENTINEL' },
        application_id: 'app-attacker-controlled'
      };
      assert.throws(() => graph.invoke(unsafeEnvelope, config), /input_job envelope/);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM checkpoints').get().count, 0,
        'unsafe envelopes are rejected before any checkpoint is written');
      const tooManyProviderIds = Array.from({ length: 21 }, (_, index) => ({ provider: `source-${index}`, id: `id-${index}` }));
      assert.throws(() => graph.invoke({ input_job: { ...job, provider_ids: tooManyProviderIds } }, config), /provider-scoped identity limit/);
      assert.throws(() => graph.invoke({ input_job: { ...job, provider_ids: [{ provider: 'source', id: 'x'.repeat(201) }] } }, config), /provider-scoped identity limit/);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM checkpoints').get().count, 0,
        'identity overflow is refused before writing a checkpoint');
      await graph.invoke({ input_job: job }, config);
      const saved = await graph.getState(config);
      assert.deepEqual(saved.values.input_job, {
        url: job.url, title: job.title, company: job.company, provider: job.provider,
        verification_status: job.verification_status, liveness_verified_at: job.liveness_verified_at,
        authoritative_provider: '', hydration_status: 'NOT_ATTEMPTED'
      });
      assert.equal(saved.values.input_job.discovered_via, undefined, 'oversized discovery provenance is rejected');
      assert.equal(saved.values.input_job.source_urls, undefined, 'string source URLs are rejected');
      assert.equal(saved.values.input_job.provider_ids, undefined, 'string provider IDs are rejected');
      const rawCheckpoint = store.db.prepare('SELECT checkpoint, metadata FROM checkpoints').all()
        .map((row) => `${Buffer.from(row.checkpoint).toString('utf8')} ${Buffer.from(row.metadata).toString('utf8')}`).join(' ');
      assert.doesNotMatch(rawCheckpoint, /SUPPLIED_JD_SENTINEL|SUPPLIED_SECRET_SENTINEL|NESTED_SECRET_SENTINEL|TOP_LEVEL_SECRET_SENTINEL|TOP_LEVEL_JD_SENTINEL|TOP_LEVEL_STATE_SENTINEL|TOP_LEVEL_REVIEW_SECRET_SENTINEL|app-attacker-controlled/);
      assert.throws(() => graph.invoke(new Command({ resume: { decision: 'STOP' }, update: { status: 'INJECTED' } }), config), /resume-only/);
      assert.throws(() => graph.invoke(new Command({ resume: { decision: 'SUBMIT' } }), config), /unsupported resume/);
    } finally { store.close(); }
  });
});

test('queue acknowledgement fails closed if canonical state or terminal ledger evidence changes before ack', async () => {
  for (const tamper of ['missing-state', 'corrupt-state', 'conflicting-state', 'missing-terminal-event']) {
    await withTempRoot(async (root) => {
      const job = makeJob(`https://jobs.example.test/role/ack-${tamper}`);
      await queueJob(root, job);
      const statePath = join(root, 'data', 'applications', APP_ID, 'state.json');
      const eventsPath = join(root, 'data', 'application-events.jsonl');
      const { graph, store } = makeGraph(root, { dependencies: {
        loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' }),
        evaluate: async () => ({ status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } }),
        onNodeBoundary: (name) => {
          if (name !== 'notifications-routed') return;
          if (tamper === 'missing-state') unlinkSync(statePath);
          if (tamper === 'corrupt-state') writeFileSync(statePath, '{corrupt');
          if (tamper === 'conflicting-state') {
            const state = JSON.parse(readFileSync(statePath, 'utf8'));
            state.state = 'NEEDS_REVIEW';
            writeFileSync(statePath, JSON.stringify(state));
          }
          if (tamper === 'missing-terminal-event') {
            const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.type !== 'FIT_REJECTED');
            writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
          }
        }
      } });
      const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
      try {
        await assert.rejects(graph.invoke({ input_job: job }, config), /canonical|state|terminal|corrupt/i, tamper);
        assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 1, `${tamper} must not acknowledge the queue item`);
      } finally { store.close(); }
    });
  }
});

test('terminal fit persistence, ledger events, notifications, and queue acknowledgement are idempotent on rerun', async () => {
  await withTempRoot(async (root) => {
    const job = makeJob('https://jobs.example.test/role/reject');
    await queueJob(root, job);
    let evaluationCalls = 0;
    const { graph, store, ledger, sent } = makeGraph(root, { dependencies: {
      loadCandidateFacts: async () => ({ professional_years: 0, professional_yoe_verified: true, professional_years_source: 'config/profile.yml' }),
      evaluate: async () => {
        evaluationCalls++;
        return { status: 'PASSED', tier: 1, extraction: { required_yoe: 5, preferred_yoe: null, degree: null, gpa: null, confidence: 0.95, alternative_qualifications: false, ambiguous_yoe: false } };
      }
    } });
    const config = { configurable: { thread_id: stableEvaluationThreadId(APP_ID) }, durability: 'sync' };
    try {
      const result = await graph.invoke({ input_job: job }, config);
      assert.equal(result.canonical_state, 'REJECTED_BY_POLICY');
      assert.equal(result.queue_acknowledged, true);
      assert.equal(readExistingState(APP_ID).state, 'REJECTED_BY_POLICY');
      assert.equal(readAutonomousPendingJobs(join(root, 'data', 'autonomous-pending.json')).length, 0);
      const eventCount = ledger.timeline(APP_ID).length;
      const duplicate = await graph.invoke({ input_job: job }, config);
      assert.equal(duplicate.status, 'DUPLICATE_SKIPPED');
      assert.equal(evaluationCalls, 1);
      assert.equal(ledger.timeline(APP_ID).length, eventCount);
      assert.equal(sent.length, 0);
    } finally { store.close(); }
  });
});
