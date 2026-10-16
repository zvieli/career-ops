#!/usr/bin/env node
/**
 * scripts/run-real-e2e-acceptance.mjs — CLI operator entrypoint for v1.1
 * Real-World E2E Acceptance Run with Telegram Human Control.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRealE2EAcceptance } from '../src/agent/runtime/real-e2e-acceptance-harness.mjs';

async function main() {
  const scenario = process.argv.slice(2).find(a => !a.startsWith('--')) || 'RUN_1_HAPPY_PATH';
  const customDir = process.argv.find(a => a.startsWith('--dir='))?.split('=')[1];
  const dataRoot = customDir || mkdtempSync(join(tmpdir(), 'cops-acceptance-run-'));

  let jobUrl = 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003';

  if (scenario === 'RUN_2_DIFFERENT_ATS') {
    jobUrl = 'https://jobs.lever.co/lendbuzz/f234abf5-c204-4b15-986a-d8ce996883fd';
  }

  console.log(`Starting Career-Ops v1.1 Real-World E2E Acceptance Run (${scenario})...`);
  console.log(`Job URL: ${jobUrl}`);

  const results = await executeRealE2EAcceptance({
    jobUrl,
    scenario,
    dataRoot,
    simulateRestartAt: scenario === 'RUN_3_RESTART_REPLAY' ? 'AFTER_PRE_SUBMIT_REVIEW' : null
  });

  console.log('\n=== REAL-WORLD ACCEPTANCE VERDICTS ===');
  console.log(`DISCOVERY_SUCCESS: ${results.DISCOVERY_SUCCESS ? 'YES' : 'NO'}`);
  console.log(`HYDRATION_SUCCESS: ${results.HYDRATION_SUCCESS ? 'YES' : 'NO'}`);
  console.log(`LIVENESS_SUCCESS: ${results.LIVENESS_SUCCESS ? 'YES' : 'NO'}`);
  console.log(`EVALUATION_SUCCESS: ${results.EVALUATION_SUCCESS ? 'YES' : 'NO'}`);
  console.log(`APPLICATION_ID_PERSISTED: ${results.APPLICATION_ID_PERSISTED ? 'YES' : 'NO'}`);
  console.log(`REVIEW_TASK_CREATED: ${results.REVIEW_TASK_CREATED ? 'YES' : 'NO'}`);
  console.log(`TELEGRAM_NOTIFICATION_DELIVERED: ${results.TELEGRAM_NOTIFICATION_DELIVERED ? 'YES' : 'NO'}`);
  console.log(`TELEGRAM_DECISION_RECORDED: ${results.TELEGRAM_DECISION_RECORDED ? 'YES' : 'NO'}`);
  console.log(`CV_GENERATED: ${results.CV_GENERATED ? 'YES' : 'NO'}`);
  console.log(`PDF_VALIDATED: ${results.PDF_VALIDATED ? 'YES' : 'NO'}`);
  console.log(`ATS_PREPARED: ${results.ATS_PREPARED ? 'YES' : 'NO'}`);
  console.log(`FINAL_HUMAN_REVIEW_REACHED: ${results.FINAL_HUMAN_REVIEW_REACHED ? 'YES' : 'NO'}`);
  console.log(`MANUAL_SUBMISSION_CONFIRMED: ${results.MANUAL_SUBMISSION_CONFIRMED ? 'YES' : 'NO'}`);
  console.log(`APPLICATION_TRACKING_APPLIED_CONFIRMED: ${results.APPLICATION_TRACKING_APPLIED_CONFIRMED ? 'YES' : 'NO'}`);
  console.log(`INVENTED_FACTS: ${results.INVENTED_FACTS}`);
  console.log(`AUTO_SUBMISSIONS: ${results.AUTO_SUBMISSIONS}`);
  console.log(`EMPLOYER_MESSAGES_SENT: ${results.EMPLOYER_MESSAGES_SENT}`);
  console.log(`DUPLICATE_APPLICATIONS: ${results.DUPLICATE_APPLICATIONS}`);
  console.log(`DUPLICATE_REVIEW_TASKS: ${results.DUPLICATE_REVIEW_TASKS}`);
  console.log(`DUPLICATE_DECISION_RECEIPTS: ${results.DUPLICATE_DECISION_RECEIPTS}`);

  console.log('\n=== OPERATIONAL TIMINGS & METRICS ===');
  console.log(JSON.stringify({ timings: results.timings, metrics: results.metrics }, null, 2));

  return results;
}

main().catch(err => {
  console.error('Acceptance execution failed:', err);
  process.exitCode = 1;
});
