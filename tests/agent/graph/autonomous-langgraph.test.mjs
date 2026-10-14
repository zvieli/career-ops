// @ts-check
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from '@langchain/langgraph';
import { ApplicationLedger } from '../../../lib/application-ledger.mjs';
import { mergeAutonomousPendingJobs, readAutonomousPendingJobs } from '../../../lib/autonomous-pending-queue.mjs';
import { NotificationRouter } from '../../../lib/notification-router.mjs';
import { readExistingState } from '../../../lib/application-state-machine.mjs';
import { AUTONOMOUS_GRAPH_NODE_NAMES, assertCheckpointDomainConsistency, createAutonomousEvaluationGraph, openLangGraphCheckpointStore, stableEvaluationThreadId } from '../../../lib/autonomous-langgraph.mjs';

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
      hydrateJob: async (job) => ({ ...job, title: job.title || 'Software Engineer', company: job.company || 'Example', jdText: 'Requires 1 year of professional software engineering experience.' }),
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

test('stable graph thread identity is deterministic and application-scoped', () => {
  assert.equal(stableEvaluationThreadId('app-123'), 'careerops-evaluation-v1:app-123');
  assert.equal(stableEvaluationThreadId('app-123'), stableEvaluationThreadId('app-123'));
  assert.notEqual(stableEvaluationThreadId('app-123'), stableEvaluationThreadId('app-456'));
  assert.throws(() => stableEvaluationThreadId('../escape'), /application ID/);
});

test('local SQLite checkpointer uses private durable storage and can reopen', async () => {
  await withTempRoot((root) => {
    const first = openLangGraphCheckpointStore({ dataRoot: root });
    assert.equal(first.dbPath, join(root, 'data', 'langgraph', 'checkpoints.sqlite'));
    assert.equal(statSync(join(root, 'data', 'langgraph')).mode & 0o777, 0o700);
    assert.equal(statSync(first.dbPath).mode & 0o777, 0o600);
    assert.equal(first.db.pragma('journal_mode', { simple: true }).toLowerCase(), 'wal');
    assert.equal(first.db.pragma('synchronous', { simple: true }), 2);
    first.close();
    const second = openLangGraphCheckpointStore({ dataRoot: root });
    assert.equal(typeof second.checkpointer.getTuple, 'function');
    second.close();
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
      assert.equal(paused.__interrupt__?.[0]?.value?.type, 'CANDIDATE_FIT_REVIEW');
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
      const preSubmit = await graph.invoke(new Command({ resume: { action: 'evidence_updated' } }), config);
      assert.equal(preSubmit.__interrupt__?.[0]?.value?.type, 'PRE_SUBMIT_REVIEW');
      assert.equal(readExistingState(APP_ID).state, 'CV_VALIDATED');
      assert.equal(evaluationCalls, 1);
      assert.deepEqual(cvCalls, { generate: 1, validate: 1 });
      assert.equal(preSubmit.__interrupt__[0].value.canonical_state, 'CV_VALIDATED');
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
      await graph.invoke({ input_job: job }, config);
      const saved = await graph.getState(config);
      assert.deepEqual(saved.values.input_job, {
        url: job.url, title: job.title, company: job.company, provider: job.provider,
        verification_status: job.verification_status, liveness_verified_at: job.liveness_verified_at
      });
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
