import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { ApplicationLedger } from '../../../lib/application-ledger.mjs';
import { NotificationRouter } from '../../../lib/notification-router.mjs';
import { createAutonomousEvaluationGraph, openLangGraphCheckpointStore, stableEvaluationThreadId } from '../../../lib/autonomous-langgraph.mjs';

const [scenario, mode, root, boundary = ''] = process.argv.slice(2);
process.env.CAREER_OPS_ROOT = root;
const applicationId = scenario === 'review' ? 'app-333333333333333333333333' : 'app-444444444444444444444444';
const url = `https://jobs.example.test/${scenario}`;
const job = { url, title: 'Software Engineer', company: 'Fixture Co', provider: 'greenhouse', verification_status: 'active', liveness_verified_at: new Date().toISOString() };
const fixtureDir = join(root, 'data', 'langgraph-fixtures');
const factsPath = join(fixtureDir, `${scenario}-facts.json`);
const evaluationsPath = join(fixtureDir, `${scenario}-evaluations.jsonl`);
const notificationPath = join(root, 'data', 'langgraph-fixtures', 'notifications.jsonl');
const store = openLangGraphCheckpointStore({ dataRoot: root });
const ledger = new ApplicationLedger({ dataRoot: root });
const notificationRouter = new NotificationRouter({ dataRoot: root, adapters: [{
  id: 'fixture', isConfigured: () => true,
  async send(event) { appendFileSync(notificationPath, `${event.event_id}\n`); return { status: 'DELIVERED' }; }
}] });
const graph = createAutonomousEvaluationGraph({
  checkpointer: store.checkpointer,
  dataRoot: root,
  dependencies: {
    queueFile: join(root, 'data', 'autonomous-pending.json'),
    ledger,
    notificationRouter,
    resolveIdentity: () => ({ application_id: applicationId, identity_basis: 'canonical_url', mergeable: true }),
    hydrateJob: async (input) => ({ ...input, jdText: scenario === 'review' ? 'Requires 1 year of professional software engineering experience.' : 'Requires 5 years of professional software engineering experience.' }),
    loadCandidateFacts: async () => JSON.parse(readFileSync(factsPath, 'utf8')),
    evaluate: async () => {
      appendFileSync(evaluationsPath, 'called\n');
      return { status: 'PASSED', tier: 1, extraction: {
        required_yoe: scenario === 'review' ? 1 : 5, preferred_yoe: null,
        degree: null, gpa: null, confidence: 0.95,
        alternative_qualifications: false, ambiguous_yoe: false
      } };
    },
    onNodeBoundary(name) {
      if (mode === `crash:${name}` || mode === `review-resume-crash:${name}`) process.exit(77);
    }
  }
});
const threadId = stableEvaluationThreadId(applicationId);
const config = { configurable: { thread_id: threadId }, durability: 'sync' };
let input;
if (mode === 'start' || mode === 'start-crash-after-interrupt') input = { input_job: job };
else if (mode === 'resume') input = null;
else if (mode === 'review-resume' || mode.startsWith('review-resume-crash:')) input = new Command({ resume: { action: 'evidence_updated' } });
else if (mode === 'stop-resume') input = new Command({ resume: { decision: 'STOP' } });
else if (mode.startsWith('crash:')) input = { input_job: job };
else throw new Error(`Unknown worker mode: ${mode}`);

const result = await graph.invoke(input, config);
if (mode === 'start-crash-after-interrupt' && result.__interrupt__?.length) process.exit(77);
process.stdout.write(`${JSON.stringify({
  status: result.status,
  canonical_state: result.canonical_state,
  interrupt: result.__interrupt__?.[0]?.value?.type || null,
  application_id: result.application_id,
  queue_acknowledged: result.queue_acknowledged === true
})}\n`);
store.close();
