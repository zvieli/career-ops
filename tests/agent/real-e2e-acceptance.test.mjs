import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeRealE2EAcceptance } from '../../src/agent/runtime/real-e2e-acceptance-harness.mjs';

test('Acceptance Run 1: Primary Happy Path on real job with Telegram human control', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cops-run1-'));
  try {
    const res = await executeRealE2EAcceptance({
      jobUrl: 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003',
      scenario: 'RUN_1_HAPPY_PATH',
      dataRoot: root,
      telegramConfig: {
        token: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
        allowedUserId: '99887766',
        allowedChatId: '99887766',
        configured: true,
        validationErrors: []
      }
    });

    // Check all B3 Success Definition criteria
    assert.equal(res.DISCOVERY_SUCCESS, true, 'DISCOVERY_SUCCESS must be true');
    assert.equal(res.HYDRATION_SUCCESS, true, 'HYDRATION_SUCCESS must be true');
    assert.equal(res.LIVENESS_SUCCESS, true, 'LIVENESS_SUCCESS must be true');
    assert.equal(res.EVALUATION_SUCCESS, true, 'EVALUATION_SUCCESS must be true');
    assert.equal(res.APPLICATION_ID_PERSISTED, true, 'APPLICATION_ID_PERSISTED must be true');
    assert.equal(res.REVIEW_TASK_CREATED, true, 'REVIEW_TASK_CREATED must be true');
    assert.equal(res.TELEGRAM_NOTIFICATION_DELIVERED, true, 'TELEGRAM_NOTIFICATION_DELIVERED must be true');
    assert.equal(res.TELEGRAM_DECISION_RECORDED, true, 'TELEGRAM_DECISION_RECORDED must be true');
    assert.equal(res.CV_GENERATED, true, 'CV_GENERATED must be true');
    assert.equal(res.PDF_VALIDATED, true, 'PDF_VALIDATED must be true');
    assert.equal(res.ATS_PREPARED, true, 'ATS_PREPARED must be true');
    assert.equal(res.LIVE_ATS_READ_ONLY_ACCEPTANCE, true, 'LIVE_ATS_READ_ONLY_ACCEPTANCE must be true for Greenhouse');
    assert.equal(res.ATS_FIXTURE_ACCEPTANCE, true, 'ATS_FIXTURE_ACCEPTANCE must be true');
    assert.equal(res.AUTOMATION_HANDOFF_READY, true, 'AUTOMATION_HANDOFF_READY must be true');
    assert.equal(res.FINAL_HUMAN_REVIEW_REACHED, true, 'FINAL_HUMAN_REVIEW_REACHED must be true');
    assert.equal(res.MANUAL_SUBMISSION_CONFIRMED, true, 'MANUAL_SUBMISSION_CONFIRMED must be true');
    assert.equal(res.APPLICATION_TRACKING_APPLIED_CONFIRMED, true, 'APPLICATION_TRACKING_APPLIED_CONFIRMED must be true');

    // Check Zero Tolerance Safety Boundaries
    assert.equal(res.INVENTED_FACTS, 0);
    assert.equal(res.AUTO_SUBMISSIONS, 0);
    assert.equal(res.EMPLOYER_MESSAGES_SENT, 0);
    assert.equal(res.DUPLICATE_APPLICATIONS, 0);
    assert.equal(res.DUPLICATE_REVIEW_TASKS, 0);
    assert.equal(res.DUPLICATE_DECISION_RECEIPTS, 0);

    // Check metrics captured
    assert.ok(res.timings.TIME_DISCOVERY_TO_REVIEW >= 0);
    assert.ok(res.timings.TIME_REVIEW_TO_CV >= 0);
    assert.ok(res.timings.TIME_CV_TO_ATS_READY >= 0);
    assert.ok(res.timings.TIME_ATS_READY_TO_FINAL_REVIEW >= 0);
    assert.ok(res.timings.TOTAL_TIME_TO_READY_TO_SUBMIT >= 0);
    assert.ok(res.timings.TOTAL_TIME_TO_APPLIED_CONFIRMED >= 0);
    assert.equal(res.metrics.HUMAN_INTERRUPT_COUNT, 3);
    assert.equal(res.metrics.MANUAL_STEPS_COUNT, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Acceptance Run 2: Different ATS / Source (Lever) exercises discovery, hydration and schema mapping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cops-run2-'));
  try {
    const res = await executeRealE2EAcceptance({
      jobUrl: 'https://jobs.lever.co/lendbuzz/f234abf5-c204-4b15-986a-d8ce996883fd',
      scenario: 'RUN_2_DIFFERENT_ATS',
      dataRoot: root,
      telegramConfig: {
        token: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
        allowedUserId: '99887766',
        allowedChatId: '99887766',
        configured: true,
        validationErrors: []
      }
    });

    assert.equal(res.DISCOVERY_SUCCESS, true);
    assert.equal(res.HYDRATION_SUCCESS, true);
    assert.equal(res.LIVENESS_SUCCESS, true);
    assert.equal(res.CV_GENERATED, true);
    assert.equal(res.ATS_PREPARED, true);
    assert.equal(res.FINAL_HUMAN_REVIEW_REACHED, true);
    assert.equal(res.MANUAL_SUBMISSION_CONFIRMED, true);
    assert.equal(res.APPLICATION_TRACKING_APPLIED_CONFIRMED, true);
    assert.equal(res.AUTO_SUBMISSIONS, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Acceptance Run 3: Restart / Replay during human boundary without duplicate state or receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cops-run3-'));
  try {
    const res = await executeRealE2EAcceptance({
      jobUrl: 'https://job-boards.greenhouse.io/nextinsurance66/jobs/7979131003',
      scenario: 'RUN_3_RESTART_REPLAY',
      dataRoot: root,
      simulateRestartAt: 'AFTER_PRE_SUBMIT_REVIEW',
      telegramConfig: {
        token: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_12345678',
        allowedUserId: '99887766',
        allowedChatId: '99887766',
        configured: true,
        validationErrors: []
      }
    });

    assert.equal(res.metrics.RECOVERY_REQUIRED, true, 'Recovery must have been exercised');
    assert.ok(res.metrics.TELEGRAM_DUPLICATES_PREVENTED >= 1, 'Delivery deduplication must prevent duplicate message on restart');
    assert.equal(res.FINAL_HUMAN_REVIEW_REACHED, true);
    assert.equal(res.MANUAL_SUBMISSION_CONFIRMED, true);
    assert.equal(res.APPLICATION_TRACKING_APPLIED_CONFIRMED, true);

    // Assert strictly zero duplicates
    assert.equal(res.DUPLICATE_APPLICATIONS, 0);
    assert.equal(res.DUPLICATE_REVIEW_TASKS, 0);
    assert.equal(res.DUPLICATE_DECISION_RECEIPTS, 0);
    assert.equal(res.AUTO_SUBMISSIONS, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
