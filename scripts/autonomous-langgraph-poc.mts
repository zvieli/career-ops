import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { evaluateJob } from '../lib/job-evaluator.mjs';
import { createZeroCostProviderRunner } from '../lib/llm/provider-runner.mjs';
import { isZeroCostModel } from '../lib/zero-cost-router.mjs';
import { detectRequiredEligibility, evaluateCandidateFit, FIT_POLICY_VERSION } from '../lib/candidate-fit-gate.mjs';
import { resolveApplicationIdentity } from '../lib/application-identity.mjs';
import { hydrateDirectJobFromHistory, candidateFactsFromSources } from '../autonomous-pipeline.mjs';
import { hashReviewEvidence } from '../lib/application-state-machine.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { ApplicationLedger, createApplicationEventEmitter, recordJobDiscoveryEvent, semanticFitEventType } from '../lib/application-ledger.mjs';

interface JobRecord {
  url: string;
  title: string;
  company: string;
  jdText: string;
  jdHash: string;
  identity?: Record<string, unknown>;
  [key: string]: unknown;
}

interface GraphState {
  job: JobRecord;
  evaluation: Record<string, any>;
  fit: Record<string, any>;
  route: 'REJECT' | 'NEEDS_REVIEW' | 'SHORTLIST' | '';
  attempts: Array<{ tier: string; modelId: string; provider: string }>;
  requestedTier: string;
}

const State = Annotation.Root({
  job: Annotation<JobRecord>(),
  evaluation: Annotation<Record<string, any>>(),
  fit: Annotation<Record<string, any>>(),
  route: Annotation<'REJECT' | 'NEEDS_REVIEW' | 'SHORTLIST' | ''>(),

  attempts: Annotation<Array<{ tier: string; modelId: string; provider: string }>>({ reducer: (_left, right) => right, default: () => [] }),
  requestedTier: Annotation<string>()
});

const root = getCareerOpsRoot();
const fixturePath = resolve(root, 'data/autonomous-poc/atbay-backend-engineer.json');
const applicationIdExpected = 'app-cf14f24b357e9e7b4f2fda63';
const outputPath = resolve(root, 'data/autonomous-poc/langgraph-result.json');

function readCandidate() {
  const profile = yaml.load(readFileSync(join(root, 'config/profile.yml'), 'utf8')) as Record<string, any>;
  const cv = readFileSync(join(root, 'cv.md'), 'utf8');
  return { profile, cv, facts: candidateFactsFromSources(profile, cv) };
}

function identityFromFixture(job: JobRecord) {
  const hydrated = hydrateDirectJobFromHistory(root, job.url);
  if (!hydrated.company || !hydrated.title || hydrated.identityConflict) throw new Error('Existing scan-history identity cannot be safely hydrated');
  const identity = resolveApplicationIdentity(hydrated, { dataRoot: root });
  if (identity.application_id !== applicationIdExpected) throw new Error(`Canonical identity changed: ${identity.application_id}`);
  return { ...job, ...hydrated, identity };
}

async function runLegacy(job: JobRecord) {
  const { profile, cv, facts } = readCandidate();
  const candidateProfile = { ...profile, verified_candidate_facts: facts };
  const attempts: Array<{ tier: string; modelId: string; provider: string }> = [];
  const llmRunner = createZeroCostProviderRunner({ onModelAttempt: (attempt) => attempts.push({
    tier: String(attempt.tier), modelId: attempt.modelId, provider: attempt.provider
  }) });
  const evaluation = await evaluateJob({
    jdText: job.jdText,
    title: job.title,
    company: job.company,
    candidateProfile,
    llmRunner,
    dataRoot: root
  });
  const fit = evaluateCandidateFit({ evaluation, candidateFacts: facts, title: job.title, requiredEligibility: detectRequiredEligibility(job.jdText) });
  return { evaluation, fit, attempts, identity: job.identity };
}

async function runLangGraph(job: JobRecord) {
  const temporaryCache = mkdtempSync(join(tmpdir(), 'career-ops-langgraph-'));
  const candidate = readCandidate();
  const attempts: Array<{ tier: string; modelId: string; provider: string }> = [];
  const runner = createZeroCostProviderRunner({ onModelAttempt: (attempt) => attempts.push({
    tier: String(attempt.tier), modelId: attempt.modelId, provider: attempt.provider
  }) });
  const ledger = new ApplicationLedger({ dataRoot: temporaryCache });
  const emitApplicationEvent = createApplicationEventEmitter(ledger, 'langgraph-poc');
  const semanticEvents: Array<{ event_id: string; type: string }> = [];

  const graph = new StateGraph(State)
    .addNode('hydrate', async (state: GraphState) => {
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as JobRecord;
      const jdHash = createHash('sha256').update(fixture.jd_text as string, 'utf8').digest('hex');
      if (jdHash !== fixture.jd_hash || jdHash !== job.jdHash) throw new Error('JD snapshot hash mismatch');
      const hydrated = identityFromFixture({ ...fixture, jdText: fixture.jd_text as string, jdHash });
      const discoveredEvent = await recordJobDiscoveryEvent(emitApplicationEvent, hydrated.identity!.application_id as string);
      semanticEvents.push({ event_id: discoveredEvent.event_id, type: discoveredEvent.type });
      return { job: hydrated, requestedTier: 'SYSTEM1', route: '', evaluation: {}, fit: {}, attempts: state.attempts };
    })
    .addNode('evaluate', async (state: GraphState) => {
      const job = state.job;
      const evaluation = await evaluateJob({
        jdText: job.jdText,
        title: job.title,
        company: job.company,
        candidateProfile: { ...candidate.profile, verified_candidate_facts: candidate.facts },
        llmRunner: runner,
        dataRoot: temporaryCache,
        bypassCache: true
      });
      return { evaluation, attempts, requestedTier: evaluation.tier === 2 ? 'SYSTEM2' : 'SYSTEM1' };
    })
    .addNode('candidate_fit', async (state: GraphState) => {
      const fit = evaluateCandidateFit({
        evaluation: state.evaluation,
        candidateFacts: candidate.facts,
        title: state.job.title,
        requiredEligibility: detectRequiredEligibility(state.job.jdText)
      });
      const route = ['REJECT', 'LONG_STRETCH'].includes(fit.status) ? 'REJECT'
        : ['STRONG', 'REASONABLE'].includes(fit.status) ? 'SHORTLIST' : 'NEEDS_REVIEW';
      const eventType = semanticFitEventType(fit.status);
      if (eventType) {
        const evidenceHash = hashReviewEvidence({ fitPolicyVersion: FIT_POLICY_VERSION, title: state.job.title, jdText: state.job.jdText, candidateFacts: candidate.facts });
        const fitEvent = await emitApplicationEvent(state.job.identity!.application_id as string, eventType,
          `fit:${evidenceHash}:${FIT_POLICY_VERSION}:${fit.status}`, { fit_status: fit.status, fit_policy_version: FIT_POLICY_VERSION, evidence_hash: evidenceHash });
        semanticEvents.push({ event_id: fitEvent.event_id, type: fitEvent.type });
      }
      return { fit, route };
    })
    .addNode('reject', async () => ({ route: 'REJECT' as const }))
    .addNode('needs_review', async () => ({ route: 'NEEDS_REVIEW' as const }))
    .addNode('shortlist', async () => ({ route: 'SHORTLIST' as const }))
    .addEdge(START, 'hydrate')
    .addEdge('hydrate', 'evaluate')
    .addEdge('evaluate', 'candidate_fit')
    .addConditionalEdges('candidate_fit', (state: GraphState) => state.route, {
      REJECT: 'reject', NEEDS_REVIEW: 'needs_review', SHORTLIST: 'shortlist'
    })
    .addEdge('reject', END)
    .addEdge('needs_review', END)
    .addEdge('shortlist', END)
    .compile();

  try {
    const result = await graph.invoke({ job, evaluation: {}, fit: {}, route: '', attempts: [], requestedTier: 'SYSTEM1' });
    const evaluation = result.evaluation;
    const selectedProvider = evaluation.provider || evaluation.system1?.provider || '';
    const physicalModel = evaluation.model || evaluation.system1?.model || '';
    const successful = evaluation.status === 'PASSED' && Boolean(physicalModel);
    return {
      result,
      semanticEvents,
      call: {
        REQUESTED_TIER: result.requestedTier,
        SELECTED_PROVIDER: selectedProvider,
        PHYSICAL_MODEL: physicalModel,
        USED_PI_GATEWAY: ['antigravity', 'openai-codex', 'kilo'].includes(selectedProvider),
        IN_EXACT_INVENTORY: isZeroCostModel(physicalModel),
        CALL_SUCCESS: successful,
        ATTEMPTS: attempts
      }
    };
  } finally {
    rmSync(temporaryCache, { recursive: true, force: true });
  }
}

async function main() {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as JobRecord & { jd_text: string; jd_hash: string };
  const jdHash = createHash('sha256').update(fixture.jd_text, 'utf8').digest('hex');
  if (jdHash !== fixture.jd_hash) throw new Error('Saved controlled JD fixture failed its hash check');
  const job = identityFromFixture({ ...fixture, jdText: fixture.jd_text, jdHash });
  if (job.identity.application_id !== applicationIdExpected) throw new Error('Unexpected canonical application identity');

  const legacy = await runLegacy(job);
  const graphRun = await runLangGraph(job);
  const a = legacy.evaluation;
  const b = graphRun.result.evaluation;
  const equivalent = JSON.stringify({ identity: job.identity.application_id, hash: jdHash, req: a.extraction?.required_yoe, degree: a.extraction?.degree, gpa: a.extraction?.gpa, fit: legacy.fit.status })
    === JSON.stringify({ identity: graphRun.result.job.identity.application_id, hash: b.job_description_hash, req: b.extraction?.required_yoe, degree: b.extraction?.degree, gpa: b.extraction?.gpa, fit: graphRun.result.fit.status });
  const report = {
    CONTROLLED_REPLAY: true,
    APPLICATION_ID: job.identity.application_id,
    JD_HASH: jdHash,
    LEGACY: { tier: a.tier, cached: a.cached, requirements: a.extraction, fit: legacy.fit.status, state: 'REJECTED_BY_POLICY', modelCallsThisReplay: legacy.attempts.length },
    LANGGRAPH: { route: graphRun.result.route, requirements: b.extraction, fit: graphRun.result.fit.status, semantic_events: graphRun.semanticEvents, call: graphRun.call },
    OUTPUT_EQUIVALENCE: equivalent ? 'PASS' : 'FAIL',
    PI_MODEL_USED: graphRun.call.PHYSICAL_MODEL,
    REAL_PI_MODEL_CALL_FROM_LANGGRAPH: graphRun.call.CALL_SUCCESS && graphRun.call.USED_PI_GATEWAY && graphRun.call.IN_EXACT_INVENTORY ? 'PASS' : 'FAIL'
  };
  mkdirSync(join(root, 'data/autonomous-poc'), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.OUTPUT_EQUIVALENCE !== 'PASS' || report.REAL_PI_MODEL_CALL_FROM_LANGGRAPH !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
