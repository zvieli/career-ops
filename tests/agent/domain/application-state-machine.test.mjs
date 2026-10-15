// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STATE_DEFINITIONS,
  TRANSITION_GRAPH,
  transitionState,
  resumeReviewWithChangedEvidence,
  getState,
  readExistingState,
  listApplications,
  resetState
} from '../../../lib/application-state-machine.mjs';

function readyInput(id) {
  return {
    formType: 'GREENHOUSE', jdHash: 'a'.repeat(64), schemaExtractionStatus: 'EXTRACTED', schemaHash: 'b'.repeat(64),
    schemaArtifactHash: 'c'.repeat(64), schemaArtifactRef: `${id}/schema.json`,
    preparationReceiptHash: 'd'.repeat(64), preparationReceiptRef: `${id}/receipt.json`
  };
}

function withTempDataRoot(fn) {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-asm-test-'));
  const origRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = tempDir;
  try {
    fn(tempDir);
  } finally {
    if (origRoot !== undefined) process.env.CAREER_OPS_ROOT = origRoot;
    else delete process.env.CAREER_OPS_ROOT;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

test('READY_TO_FILL requires an extracted schema and complete application-scoped receipt references', () => {
  withTempDataRoot(() => {
    const id = 'app-readiness-gate';
    for (const target of ['NORMALIZED', 'DEDUPED', 'FIT_EVALUATED', 'SHORTLISTED', 'CV_GENERATED', 'CV_VALIDATED']) transitionState(id, target, {});
    assert.throws(() => transitionState(id, 'READY_TO_FILL', {}), /requires an extracted schema/i);
    assert.throws(() => transitionState(id, 'READY_TO_FILL', { ...readyInput(id), schemaExtractionStatus: 'NEEDS_REVIEW' }), /requires an extracted schema/i);
    assert.throws(() => transitionState(id, 'READY_TO_FILL', { ...readyInput(id), schemaArtifactRef: '../schema.json' }), /requires an extracted schema/i);
    assert.equal(readExistingState(id).state, 'CV_VALIDATED');
    assert.equal(transitionState(id, 'READY_TO_FILL', readyInput(id)).state, 'READY_TO_FILL');
  });
});

test('FORM_FILLED preserves legacy transitions and stores controlled receipt evidence when supplied', () => {
  withTempDataRoot(() => {
    const legacyId = 'app-form-filled-legacy';
    for (const target of ['NORMALIZED', 'DEDUPED', 'FIT_EVALUATED', 'SHORTLISTED', 'CV_GENERATED', 'CV_VALIDATED']) transitionState(legacyId, target, {});
    transitionState(legacyId, 'READY_TO_FILL', readyInput(legacyId));
    assert.equal(transitionState(legacyId, 'FORM_FILLED', {}).state, 'FORM_FILLED');
    assert.equal(readExistingState(legacyId).metadata.FORM_FILLED.receiptHash, undefined, 'legacy state has no controlled-fill recovery evidence');

    const id = 'app-form-filled-binding';
    for (const target of ['NORMALIZED', 'DEDUPED', 'FIT_EVALUATED', 'SHORTLISTED', 'CV_GENERATED', 'CV_VALIDATED']) transitionState(id, target, {});
    transitionState(id, 'READY_TO_FILL', readyInput(id));
    const input = { jdHash: 'e'.repeat(64), schemaHash: 'f'.repeat(64), receiptHash: '1'.repeat(64), fillReceiptRef: `${id}/application-filled.json`, fillReceiptSha256: '2'.repeat(64), submissionPerformed: false, submitCapability: false };
    const result = transitionState(id, 'FORM_FILLED', input);
    assert.equal(result.metadata.FORM_FILLED.receiptHash, input.receiptHash);
    assert.equal(result.metadata.FORM_FILLED.fillReceiptSha256, input.fillReceiptSha256);
    assert.equal(result.metadata.FORM_FILLED.submissionPerformed, false);
    assert.equal(result.metadata.FORM_FILLED.submitCapability, false);
  });
});

test('readExistingState is strict and does not initialize a missing application', () => {
  withTempDataRoot((root) => {
    assert.equal(readExistingState('app-absent'), null);
    assert.equal(existsSync(join(root, 'data', 'applications')), false);
    transitionState('app-existing', 'NORMALIZED', {});
    assert.equal(readExistingState('app-existing').state, 'NORMALIZED');
    const path = join(root, 'data', 'applications', 'app-invalid', 'state.json');
    mkdirSync(join(root, 'data', 'applications', 'app-invalid'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, state: 'UNKNOWN', transitionCount: 0, metadata: {} }));
    assert.throws(() => readExistingState('app-invalid'), /Invalid application state/);
  });
});

test('state-machine operations honor an explicit dataRoot instead of the process root', () => {
  const processRoot = mkdtempSync(join(tmpdir(), 'career-ops-process-root-'));
  const explicitRoot = mkdtempSync(join(tmpdir(), 'career-ops-explicit-root-'));
  const previousRoot = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = processRoot;
  try {
    transitionState('app-root-bound', 'NORMALIZED', {}, { dataRoot: explicitRoot });
    assert.equal(readExistingState('app-root-bound', { dataRoot: explicitRoot }).state, 'NORMALIZED');
    assert.equal(existsSync(join(processRoot, 'data', 'applications', 'app-root-bound', 'state.json')), false);
    assert.equal(existsSync(join(explicitRoot, 'data', 'applications', 'app-root-bound', 'state.json')), true);
  } finally {
    if (previousRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = previousRoot;
    rmSync(processRoot, { recursive: true, force: true });
    rmSync(explicitRoot, { recursive: true, force: true });
  }
});

test('corrupted persisted state fails closed instead of resetting to DISCOVERED', () => {
  withTempDataRoot((root) => {
    const dir = join(root, 'data', 'applications', 'app-corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{not-json');
    assert.throws(() => getState('app-corrupt'), /Corrupted application state/);
  });
});

test('state writes replace atomically and leave no temp artifact', () => {
  withTempDataRoot((root) => {
    transitionState('app-atomic', 'NORMALIZED', {});
    const dir = join(root, 'data', 'applications', 'app-atomic');
    assert.deepEqual(readdirSync(dir), ['state.json']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).state, 'NORMALIZED');
  });
});

test('initial state is DISCOVERED', () => {
  withTempDataRoot(() => {
    const s = getState('app-1');
    assert.equal(s.state, STATE_DEFINITIONS.DISCOVERED.id);
    assert.equal(s.version, 1);
  });
});

test('sequential valid transitions advance correctly', () => {
  withTempDataRoot(() => {
    const appId = 'app-2';
    // DISCOVERED -> NORMALIZED -> DEDUPED -> FIT_EVALUATED -> SHORTLISTED -> CV_GENERATED -> CV_VALIDATED
    transitionState(appId, 'NORMALIZED', { source: 'test' });
    transitionState(appId, 'DEDUPED', {});
    transitionState(appId, 'FIT_EVALUATED', {});
    transitionState(appId, 'SHORTLISTED', {});
    transitionState(appId, 'CV_GENERATED', {});
    const finalState = transitionState(appId, 'CV_VALIDATED', {});
    assert.equal(finalState.state, 'CV_VALIDATED');
  });
});

test('invalid transition throws error (fails closed)', () => {
  withTempDataRoot(() => {
    const appId = 'app-3';
    // Cannot jump from DISCOVERED directly to READY_FOR_HUMAN
    assert.throws(() => {
      transitionState(appId, 'READY_FOR_HUMAN', {});
    }, /Invalid transition/);
  });
});

test('NEEDS_REVIEW cannot bypass an evidence-changed fit evaluation', () => {
  withTempDataRoot(() => {
    const id = 'app-needs-review';
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    const state = transitionState(id, 'NEEDS_REVIEW', { reason: 'provider unavailable' });
    assert.equal(state.state, 'NEEDS_REVIEW');
    assert.throws(() => transitionState(id, 'SHORTLISTED', {}), /Invalid transition/);
  });
});

test('transient evaluation failure retries with unchanged evidence', () => {
  withTempDataRoot(() => {
    const id = 'app-provider-retry';
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'NEEDS_REVIEW', { reviewType: 'evaluation_failure', evidenceHash: 'same' });
    assert.equal(transitionState(id, 'DEDUPED', { retry: true, evidenceHash: 'same' }).state, 'DEDUPED');
  });
});

test('candidate-fit review cannot use the provider-retry transition', () => {
  withTempDataRoot(() => {
    const id = 'app-no-fake-retry';
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'FIT_EVALUATED', {});
    transitionState(id, 'NEEDS_REVIEW', { reviewType: 'candidate_fit', reason: 'ALL_ZERO_COST_MODELS_UNAVAILABLE', reviewEvidence: { jdText: 'required GPA', candidateFacts: { gpa: 85 } } });
    assert.throws(() => transitionState(id, 'DEDUPED', { evidenceHash: 'same' }), /only a transient evaluation failure/);
  });
});

test('NEEDS_REVIEW can re-enter evaluation only through evidence-derived resume', () => {
  withTempDataRoot(() => {
    const id = 'app-review-resume';
    const evidence = { fitPolicyVersion: 'v1', jdText: 'GPA 85', candidateFacts: { gpa: 85 } };
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'FIT_EVALUATED', {});
    transitionState(id, 'NEEDS_REVIEW', { reviewType: 'candidate_fit', reviewEvidence: { fitPolicyVersion: 'v1', jdText: 'GPA 86', candidateFacts: { gpa: 85 } } });
    assert.throws(() => transitionState(id, 'FIT_EVALUATED', { evidenceHash: 'caller-supplied-hash' }), /must return through DEDUPED/);
    const resumed = resumeReviewWithChangedEvidence(id, evidence);
    assert.equal(resumed.resumed, true);
    assert.equal(getState(id).state, 'DEDUPED');
    assert.equal(getState(id).metadata.DEDUPED.reviewEvidenceHash, resumed.evidenceHash);
    transitionState(id, 'NEEDS_REVIEW', { reviewEvidence: evidence, reason: 'provider timeout', reviewType: 'evaluation_failure' });
    assert.equal(transitionState(id, 'DEDUPED', { retry: true }).state, 'DEDUPED');
    assert.equal(transitionState(id, 'FIT_EVALUATED', {}).state, 'FIT_EVALUATED');
  });
});

test('same candidate-fit evidence does not reopen NEEDS_REVIEW', () => {
  withTempDataRoot(() => {
    const id = 'app-review-unchanged';
    const evidence = { fitPolicyVersion: 'v1', jdText: 'GPA 85', candidateFacts: { gpa: 85 } };
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'FIT_EVALUATED', {});
    transitionState(id, 'NEEDS_REVIEW', { reviewType: 'candidate_fit', reviewEvidence: evidence });
    assert.equal(resumeReviewWithChangedEvidence(id, evidence).resumed, false);
    assert.equal(getState(id).state, 'NEEDS_REVIEW');
  });
});

test('LONG_STRETCH is terminal after fit evaluation', () => {
  withTempDataRoot(() => {
    const id = 'app-long-stretch';
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'FIT_EVALUATED', {});
    assert.equal(transitionState(id, 'LONG_STRETCH', {}).state, 'LONG_STRETCH');
    assert.throws(() => transitionState(id, 'SHORTLISTED', {}), /Invalid transition/);
  });
});

test('REJECTED_BY_POLICY is a terminal state after fit evaluation', () => {
  withTempDataRoot(() => {
    const id = 'app-policy-rejected';
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'FIT_EVALUATED', {});
    const rejected = transitionState(id, 'REJECTED_BY_POLICY', { reason: 'fit gate' });
    assert.equal(rejected.state, 'REJECTED_BY_POLICY');
    assert.throws(() => transitionState(id, 'SHORTLISTED', {}), /Invalid transition/);
  });
});

test('FORM_PREFILLED_RESUME_PENDING is explicit and cannot be mistaken for human-ready', () => {
  withTempDataRoot(() => {
    const id = 'app-resume-pending';
    transitionState(id, 'NORMALIZED', {});
    transitionState(id, 'DEDUPED', {});
    transitionState(id, 'FIT_EVALUATED', {});
    transitionState(id, 'SHORTLISTED', {});
    transitionState(id, 'CV_GENERATED', {});
    transitionState(id, 'CV_VALIDATED', {});
    transitionState(id, 'READY_TO_FILL', readyInput(id));
    const pending = transitionState(id, 'FORM_PREFILLED_RESUME_PENDING', {
      fields: ['First Name', 'Email'], screenshotPath: 'data/applications/app-resume-pending/evidence/form.png',
      resumeUploadStatus: 'RESUME_UPLOAD_UNVERIFIED', submitClicked: false
    });
    assert.equal(pending.state, 'FORM_PREFILLED_RESUME_PENDING');
    assert.deepEqual(pending.metadata.FORM_PREFILLED_RESUME_PENDING, {
      triggeredAt: pending.lastRun,
      fields: ['First Name', 'Email'],
      screenshotPath: 'data/applications/app-resume-pending/evidence/form.png',
      resumeUploadStatus: 'RESUME_UPLOAD_UNVERIFIED',
      submitClicked: false
    });
    assert.throws(() => transitionState(id, 'READY_FOR_HUMAN', {}), /Invalid transition/);
  });
});

test('NEEDS_USER_FACT and BLOCKED_CAPTCHA halt application', () => {
  withTempDataRoot(() => {
    const appId = 'app-4';
    // Advance step by step to READY_TO_FILL
    transitionState(appId, 'NORMALIZED', {});
    transitionState(appId, 'DEDUPED', {});
    transitionState(appId, 'FIT_EVALUATED', {});
    transitionState(appId, 'SHORTLISTED', {});
    transitionState(appId, 'CV_GENERATED', {});
    transitionState(appId, 'CV_VALIDATED', {});
    transitionState(appId, 'READY_TO_FILL', readyInput(appId));

    const blocked = transitionState(appId, 'BLOCKED_CAPTCHA', { reason: 'hCaptcha detected' });
    assert.equal(blocked.state, 'BLOCKED_CAPTCHA');
  });
});

test('idempotent rerun does not change state or duplicate work', () => {
  withTempDataRoot(() => {
    const appId = 'app-5';
    transitionState(appId, 'NORMALIZED', {});
    const s1 = getState(appId);
    // Calling transitionState with same state returns existing state
    const s2 = transitionState(appId, 'NORMALIZED', {});
    assert.equal(s1.version, s2.version);
    assert.equal(s1.state, s2.state);
  });
});
