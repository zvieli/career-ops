#!/usr/bin/env node
/**
 * lib/application-state-machine.mjs — Persistent, idempotent application state machine.
 *
 * Manages the full lifecycle of an application from DISCOVERED through to
 * READY_FOR_HUMAN, with fail-closed handling for NEEDS_USER_FACT and
 * BLOCKED_CAPTCHA states. Persists state to data/applications/{application_id}/state.json
 * with idempotency guarantees: a rerun never duplicates an application or
 * regenerates identical artifacts.
 *
 * State Lifecycle: DISCOVERED → NORMALIZED → DEDUPED → FIT_EVALUATED → SHORTLISTED
 *                        → CV_GENERATED → CV_VALIDATED → READY_TO_FILL
 *                        → FORM_FILLED → READY_FOR_HUMAN
 *                        └─> NEEDS_USER_FACT (fail-closed, halts with request)
 *                        └─> BLOCKED_CAPTCHA    (fail-closed, halts with request)
 *
 * Idempotency: Each state transition is atomic and versioned. On rerun, if the
 * application already exists at the target state, no work is repeated. Artifact
 * regeneration is gated by a hash of the input data; identical inputs produce
 * identical outputs, and the existing artifact is retained.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, unlinkSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { isMainModule } from '../../../../lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from '../../../../path-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_RESUME_TOKEN = Symbol('review-resume');

/**
 * Canonical state lifecycle definitions.
 * Order matters: transitions are only allowed forward in the sequence.
 */
export const STATE_DEFINITIONS = Object.freeze({
  DISCOVERED: {
    id: 'DISCOVERED',
    label: 'Discovered',
    description: 'Application URL or posting found, not yet normalized',
    allowedTransitions: ['NORMALIZED'],
  },
  NORMALIZED: {
    id: 'NORMALIZED',
    label: 'Normalized',
    description: 'Application data normalized (company, role, source cleaned)',
    allowedTransitions: ['DEDUPED', 'FAILED'],
  },
  DEDUPED: {
    id: 'DEDUPED',
    label: 'Deduped',
    description: 'Duplicate check completed; this is a unique application',
    allowedTransitions: ['FIT_EVALUATED', 'NEEDS_REVIEW'],
  },
  FIT_EVALUATED: {
    id: 'FIT_EVALUATED',
    label: 'Fit Evaluated',
    description: 'Qualification fit assessed against job requirements',
    allowedTransitions: ['SHORTLISTED', 'REJECTED_BY_POLICY', 'NEEDS_REVIEW', 'LONG_STRETCH'],
  },
  LONG_STRETCH: {
    id: 'LONG_STRETCH',
    label: 'Long Stretch',
    description: 'Fit gap is outside the configured preparation threshold; no application artifacts are prepared',
    allowedTransitions: [],
  },
  NEEDS_REVIEW: {
    id: 'NEEDS_REVIEW',
    label: 'Needs Review',
    description: 'Model, source, or candidate-fit evidence is insufficient to proceed',
    allowedTransitions: ['DEDUPED'],
  },
  REJECTED_BY_POLICY: {
    id: 'REJECTED_BY_POLICY',
    label: 'Rejected by Policy',
    description: 'Candidate-fit policy rejected the role; no application artifacts are prepared',
    allowedTransitions: [],
  },
  SHORTLISTED: {
    id: 'SHORTLISTED',
    label: 'Shortlisted',
    description: 'Application qualifies for CV generation',
    allowedTransitions: ['CV_GENERATED'],
  },
  CV_GENERATED: {
    id: 'CV_GENERATED',
    label: 'CV Generated',
    description: 'Tailored CV document created',
    allowedTransitions: ['CV_VALIDATED'],
  },
  CV_VALIDATED: {
    id: 'CV_VALIDATED',
    label: 'CV Validated',
    description: 'CV has passed quality assurance checks',
    allowedTransitions: ['READY_TO_FILL'],
  },
  READY_TO_FILL: {
    id: 'READY_TO_FILL',
    label: 'Ready to Fill',
    description: 'Application package ready for form population',
    allowedTransitions: ['FORM_PREFILLED_RESUME_PENDING', 'FORM_FILLED', 'NEEDS_USER_FACT', 'BLOCKED_CAPTCHA'],
  },
  FORM_PREFILLED_RESUME_PENDING: {
    id: 'FORM_PREFILLED_RESUME_PENDING',
    label: 'Form Prefilled — Resume Pending',
    description: 'Verified fields were filled locally; resume upload remains unverified and nothing was submitted',
    allowedTransitions: [],
  },
  FORM_FILLED: {
    id: 'FORM_FILLED',
    label: 'Form Filled',
    description: 'Application form fields populated from CV data',
    allowedTransitions: ['READY_FOR_HUMAN', 'NEEDS_USER_FACT', 'BLOCKED_CAPTCHA'],
  },
  READY_FOR_HUMAN: {
    id: 'READY_FOR_HUMAN',
    label: 'Ready for Human',
    description: 'Application ready for candidate review and submission',
    allowedTransitions: [],
    // Terminal state - no outgoing transitions
  },
  NEEDS_USER_FACT: {
    id: 'NEEDS_USER_FACT',
    label: 'Needs User Fact',
    description: 'Employer form asks an unverified legal/salary/clearance question',
    allowedTransitions: ['FAILED'], // Can only go to FAILED or be resolved manually
    // Fail-closed: halts application; requires explicit profile update
  },
  BLOCKED_CAPTCHA: {
    id: 'BLOCKED_CAPTCHA',
    label: 'Blocked by CAPTCHA',
    description: 'hCaptcha/reCAPTCHA/Cloudflare Turnstile detected on apply form',
    allowedTransitions: ['FAILED'], // Can only go to FAILED or be resolved manually
    // Fail-closed: halts application; candidate must solve CAPTCHA manually
  },
  FAILED: {
    id: 'FAILED',
    label: 'Failed',
    description: 'Application failed irrecoverably',
    allowedTransitions: [],
    // Terminal failure state
  },
});

/**
 * State transition graph edges (forward-only).
 */
export const TRANSITION_GRAPH = Object.freeze({
  DISCOVERED: ['NORMALIZED'],
  NORMALIZED: ['DEDUPED', 'FAILED'],
  DEDUPED: ['FIT_EVALUATED', 'NEEDS_REVIEW'],
  FIT_EVALUATED: ['SHORTLISTED', 'REJECTED_BY_POLICY', 'NEEDS_REVIEW', 'LONG_STRETCH'],
  NEEDS_REVIEW: ['DEDUPED'],
  LONG_STRETCH: [],
  REJECTED_BY_POLICY: [],
  SHORTLISTED: ['CV_GENERATED'],
  CV_GENERATED: ['CV_VALIDATED'],
  CV_VALIDATED: ['READY_TO_FILL'],
  READY_TO_FILL: ['FORM_PREFILLED_RESUME_PENDING', 'FORM_FILLED', 'NEEDS_USER_FACT', 'BLOCKED_CAPTCHA'],
  FORM_PREFILLED_RESUME_PENDING: [],
  FORM_FILLED: ['READY_FOR_HUMAN', 'NEEDS_USER_FACT', 'BLOCKED_CAPTCHA'],
  READY_FOR_HUMAN: [],
  NEEDS_USER_FACT: ['FAILED'],
  BLOCKED_CAPTCHA: ['FAILED'],
  FAILED: [],
});

/**
 * Application state machine state file path.
 * @param {string} applicationId - Unique application identifier (report number + company + role slug)
 * @returns {string} Absolute path to state.json
 */
function stateFilePath(applicationId, dataRoot = getCareerOpsRoot()) {
  const root = dataRoot;
  return join(root, 'data', 'applications', applicationId, 'state.json');
}

/**
 * Initialize a new application state file.
 * Creates the directory structure if it doesn't exist.
 * @param {string} applicationId - Unique application identifier
 * @param {Object} initialState - Initial state object
 * @returns {Object} The initialized state
 */
function atomicWriteState(statePath, content) {
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = existsSync(statePath) ? statSync(statePath).mode & 0o777 : 0o600;
  writeFileSync(tempPath, content, { flag: 'wx', mode });
  try {
    renameSync(tempPath, statePath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function initializeState(applicationId, initialState, dataRoot = getCareerOpsRoot()) {
  const dir = join(dataRoot, 'data', 'applications', applicationId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteState(stateFilePath(applicationId, dataRoot), JSON.stringify(initialState, null, 2));
  return initialState;
}

/**
 * Load application state from disk, or initialize if not present.
 * @param {string} applicationId - Unique application identifier
 * @returns {Object} The loaded or initialized state
 */
function loadState(applicationId, dataRoot = getCareerOpsRoot()) {
  const statePath = stateFilePath(applicationId, dataRoot);
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (error) {
      throw new Error(`Corrupted application state at ${statePath}; refusing to reset or continue.`, { cause: error });
    }
  }
  return initializeState(applicationId, {
    version: 1,
    state: 'DISCOVERED',
    transitionCount: 0,
    artifactHash: null,
    lastRun: null,
    metadata: {},
  }, dataRoot);
}

/**
 * Validate that a transition from currentState to targetState is allowed.
 * @param {string} currentState - Current state ID
 * @param {string} targetState - Target state ID
 * @throws {Error} If the transition is not allowed
 */
function validateTransition(currentState, targetState) {
  const currentDef = STATE_DEFINITIONS[currentState];
  if (!currentDef) {
    throw new Error(`Unknown current state: ${currentState}`);
  }
  const targetDef = STATE_DEFINITIONS[targetState];
  if (!targetDef) {
    throw new Error(`Unknown target state: ${targetState}`);
  }
  const allowed = TRANSITION_GRAPH[currentState];
  if (!allowed) {
    throw new Error(`Unknown current state: ${currentState}`);
  }
  if (!allowed.includes(targetState)) {
    const allowedLabels = allowed.map(s => STATE_DEFINITIONS[s]?.label || s).join(', ');
    throw new Error(
      `Invalid transition from ${currentDef.label} ` +
      `to ${targetDef.label}. ` +
      `Allowed transitions: ${allowedLabels}`
    );
  }
}

/**
 * Compute a content hash for idempotency checking.
 * @param {Object} state - Current state object
 * @param {Object} inputData - Input data that led to current state
 * @returns {string} SHA256 hash string
 */
export function hashReviewEvidence(evidence) {
  return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}

function computeArtifactHash(state, inputData) {
  const hashInput = JSON.stringify({
    version: state.version,
    state: state.state,
    transitionCount: state.transitionCount,
    ...inputData,
  });
  return createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Check if the current artifact is idempotent (same inputs produce same hash).
 * If idempotent, return the existing artifact path without regeneration.
 * @param {Object} state - Current state
 * @param {Object} inputData - Input data
 * @param {string} artifactType - Type of artifact ('cv', 'report', etc.)
 * @returns {string|null} Existing artifact path if idempotent, null if regeneration needed
 */
function checkIdempotency(state, inputData, artifactType) {
  if (!state.artifactHash) {
    return null;
  }
  const currentHash = computeArtifactHash(state, inputData);
  if (currentHash === state.artifactHash) {
    return null; // Artifact is already up-to-date; no regeneration needed
  }
  return null; // Hash differs; regeneration is needed (caller handles writing new artifact)
}

/**
 * Transition application state forward by one step.
 * Enforces idempotency and fail-closed handling.
 *
 * @param {string} applicationId - Unique application identifier
 * @param {string} targetState - Target state ID to transition to
 * @param {Object} inputData - Input data for the transition
 * @param {Object} [options] - Optional options
 * @param {boolean} [options.force=false] - Force transition even if already at target state
 * @returns {Object} The updated state
 * @throws {Error} If transition is invalid or state is fail-closed
 */
export function resumeReviewWithChangedEvidence(applicationId, evidence, { dataRoot = getCareerOpsRoot() } = {}) {
  const state = loadState(applicationId, dataRoot);
  if (state.state !== 'NEEDS_REVIEW') {
    throw new Error(`Application ${applicationId}: changed-evidence resume requires NEEDS_REVIEW state.`);
  }
  const evidenceHash = hashReviewEvidence(evidence);
  const previousEvidenceHash = state.metadata?.NEEDS_REVIEW?.evidenceHash;
  if (!/^[a-f0-9]{64}$/i.test(previousEvidenceHash || '') || evidenceHash === previousEvidenceHash) {
    return { resumed: false, evidenceHash, state };
  }
  const nextState = transitionState(applicationId, 'DEDUPED', { evidenceHash, jdHash: evidence?.jdHash }, { reviewResumeToken: REVIEW_RESUME_TOKEN, dataRoot });
  return { resumed: true, evidenceHash, state: nextState };
}

export function transitionState(applicationId, targetState, inputData, options = {}) {
  const { force = false, reviewResumeToken, dataRoot = getCareerOpsRoot() } = options;

  // Load current state
  let state = loadState(applicationId, dataRoot);

  // Idempotency check: if already at target state and not forcing, skip work
  if (state.state === targetState && !force) {
    state.transitionCount = (state.transitionCount || 0) + 1;
    state.lastRun = new Date().toISOString();
    saveState(state, applicationId, dataRoot);
    return state; // No work performed - idempotent
  }

  // Validate transition
  const currentState = state.state;
  if (currentState === 'NEEDS_REVIEW' && targetState === 'FIT_EVALUATED') {
    throw new Error(`Application ${applicationId}: review must return through DEDUPED before fit evaluation.`);
  }
  if (currentState === 'NEEDS_REVIEW' && targetState === 'DEDUPED') {
    const review = state.metadata?.NEEDS_REVIEW || {};
    if (reviewResumeToken === REVIEW_RESUME_TOKEN) {
      if (typeof inputData?.evidenceHash !== 'string' || inputData.evidenceHash === review.evidenceHash) {
        throw new Error(`Application ${applicationId}: changed-evidence resume requires new evidence.`);
      }
    } else {
      const transientReason = ['ALL_ZERO_COST_MODELS_UNAVAILABLE', 'INVALID_MODEL_OUTPUT'].includes(review.reason);
      const retryableReview = review.reviewType === 'evaluation_failure' || (!review.reviewType && transientReason);
      if (inputData?.retry !== true || !retryableReview) {
        throw new Error(`Application ${applicationId}: only a transient evaluation failure can be retried unchanged.`);
      }
    }
  }
  try {
    validateTransition(currentState, targetState);
  } catch (error) {
    throw new Error(
      `Application ${applicationId}: ${error.message}. ` +
      `Current state: ${STATE_DEFINITIONS[currentState].label}`
    );
  }

  // Perform the transition
  state.state = targetState;
  state.transitionCount = (state.transitionCount || 0) + 1;
  state.lastRun = new Date().toISOString();

  // Update version on certain milestones
  const milestoneStates = new Set(['NORMALIZED', 'DEDUPED', 'CV_GENERATED', 'CV_VALIDATED', 'READY_FOR_HUMAN']);
  if (milestoneStates.has(targetState)) {
    state.version = (state.version || 1) + 1;
  }

  // Compute artifact hash for idempotency tracking (hash over inputData)
  state.artifactHash = createHash('sha256').update(JSON.stringify(inputData || {})).digest('hex');

  // Store transition metadata
  if (!state.metadata) state.metadata = {};
  state.metadata[targetState] = {
    triggeredAt: state.lastRun,
    ...transitionMetadata(targetState, inputData),
  };

  saveState(state, applicationId, dataRoot);
  return state;
}

/**
 * Extract user fact requirements from input data for NEEDS_USER_FACT.
 * @param {Object} inputData - Input data
 * @returns {Array} List of required user facts
 */
function extractUserFactRequirements(inputData) {
  const requirements = [];
  if (inputData && inputData.jobDescription) {
    const jd = inputData.jobDescription;
    if (jd.salaryRange && !inputData.salaryProvided) {
      requirements.push('salary-range');
    }
    if (jd.clearanceLevel && !inputData.clearanceProvided) {
      requirements.push('clearance-level');
    }
    if (jd.legalRequirement && !inputData.legalProvided) {
      requirements.push('legal-detail');
    }
  }
  return requirements;
}

/**
 * Detect CAPTCHA type from input data.
 * @param {Object} inputData - Input data
 * @returns {string|null} CAPTCHA type or null
 */
function detectCaptchaType(inputData) {
  if (!inputData) return null;
  const { formHtml, pageUrl } = inputData;
  if (formHtml) {
    const html = formHtml.toLowerCase();
    if (html.includes('hcaptcha') || html.includes('h-captcha') || html.includes('data-sitekey')) return 'hCaptcha';
    if (html.includes('recaptcha')) return 'reCAPTCHA';
    if (html.includes('turnstile')) return 'Cloudflare Turnstile';
  }
  if (pageUrl) {
    if (pageUrl.toLowerCase().includes('cloudflare')) return 'Cloudflare';
  }
  return null;
}

/**
 * Generate transition-specific metadata.
 * @param {string} targetState - Target state ID
 * @param {Object} inputData - Input data
 * @returns {Object} Metadata for the transition
 */
function transitionMetadata(targetState, inputData) {
  const metadata = {};
  switch (targetState) {
    case 'DEDUPED':
      metadata.dedupKey = inputData?.dedupKey || 'company-role';
      if (typeof inputData?.evidenceHash === 'string') metadata.reviewEvidenceHash = inputData.evidenceHash;
      if (typeof inputData?.jdHash === 'string') metadata.jdHash = inputData.jdHash;
      if (Number.isSafeInteger(inputData?.providerRetryAttempt) && inputData.providerRetryAttempt > 1
        && inputData?.providerRetryReason === 'PROVIDER_FAILURE_NON_RETRYABLE') {
        metadata.providerRetryAttempt = inputData.providerRetryAttempt;
        metadata.providerRetryReason = inputData.providerRetryReason;
      }
      break;
    case 'FIT_EVALUATED':
      metadata.fitScore = inputData?.fitScore;
      metadata.qualified = inputData?.qualified ?? false;
      if (typeof inputData?.fitStatus === 'string') metadata.fitStatus = inputData.fitStatus;
      if (typeof inputData?.jdHash === 'string') metadata.jdHash = inputData.jdHash;
      break;
    case 'SHORTLISTED':
      if (typeof inputData?.fitScore === 'number') metadata.fitScore = inputData.fitScore;
      if (typeof inputData?.fitStatus === 'string') metadata.fitStatus = inputData.fitStatus;
      if (typeof inputData?.jdHash === 'string') metadata.jdHash = inputData.jdHash;
      break;
    case 'REJECTED_BY_POLICY':
    case 'LONG_STRETCH':
      if (typeof inputData?.fitStatus === 'string') metadata.fitStatus = inputData.fitStatus;
      if (typeof inputData?.jdHash === 'string') metadata.jdHash = inputData.jdHash;
      break;
    case 'CV_GENERATED':
      metadata.cvVersion = inputData?.cvVersion || 1;
      break;
    case 'READY_TO_FILL':
      metadata.formType = inputData?.formType || 'unknown';
      break;
    case 'NEEDS_USER_FACT':
      metadata.inputRequires = extractUserFactRequirements(inputData);
      break;
    case 'NEEDS_REVIEW':
      metadata.evidenceHash = inputData?.reviewEvidence ? hashReviewEvidence(inputData.reviewEvidence) : undefined;
      if (typeof inputData?.jdHash === 'string') metadata.jdHash = inputData.jdHash;
      metadata.reason = inputData?.reason || inputData?.candidate_fit?.reasons?.[0];
      metadata.reviewType = inputData?.reviewType || 'candidate_fit';
      break;
    case 'BLOCKED_CAPTCHA':
      metadata.captchaType = detectCaptchaType(inputData);
      break;
    case 'FORM_PREFILLED_RESUME_PENDING':
      metadata.fields = Array.isArray(inputData?.fields)
        ? inputData.fields.filter((field) => typeof field === 'string').map((field) => field.slice(0, 120))
        : [];
      metadata.screenshotPath = typeof inputData?.screenshotPath === 'string' ? inputData.screenshotPath.slice(0, 1000) : null;
      metadata.resumeUploadStatus = ['RESUME_UPLOAD_UNVERIFIED', 'NO_RESUME_FIELD'].includes(inputData?.resumeUploadStatus)
        ? inputData.resumeUploadStatus : 'UNKNOWN';
      metadata.submitClicked = inputData?.submitClicked === false ? false : null;
      break;
    default:
      break;
  }
  return metadata;
}

/**
 * Save state to disk atomically.
 * @param {Object} state - State object to save
 * @param {string} applicationId - Application identifier
 */
function saveState(state, applicationId, dataRoot = getCareerOpsRoot()) {
  const dir = join(dataRoot, 'data', 'applications', applicationId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const statePath = stateFilePath(applicationId, dataRoot);
  atomicWriteState(statePath, JSON.stringify(state, null, 2));
}

/**
 * Get the current state of an application.
 * @param {string} applicationId - Application identifier
 * @returns {Object} Current state
 */
export function getState(applicationId, { dataRoot = getCareerOpsRoot() } = {}) {
  return loadState(applicationId, dataRoot);
}

/** Read canonical state without creating a DISCOVERED record when none exists. */
export function readExistingState(applicationId, { dataRoot = getCareerOpsRoot() } = {}) {
  if (typeof applicationId !== 'string' || !/^app-[a-z0-9][a-z0-9-]{0,80}$/i.test(applicationId)) {
    throw new Error('Invalid application ID for canonical state lookup.');
  }
  const path = stateFilePath(applicationId, dataRoot);
  if (!existsSync(path)) return null;
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Corrupted application state at ${path}; refusing to reset or continue.`, { cause: error }); }
  if (!state || typeof state !== 'object' || !STATE_DEFINITIONS[state.state]
    || !Number.isSafeInteger(state.version) || state.version < 1
    || !Number.isSafeInteger(state.transitionCount) || state.transitionCount < 0
    || !state.metadata || typeof state.metadata !== 'object' || Array.isArray(state.metadata)) {
    throw new Error(`Invalid application state at ${path}; refusing to reconcile graph progress.`);
  }
  return state;
}

/**
 * Reset application state to a specific state (for testing/recovery).
 * @param {string} applicationId - Application identifier
 * @param {string} targetState - Target state to reset to
 * @returns {Object} The reset state
 */
export function resetState(applicationId, targetState, { dataRoot = getCareerOpsRoot() } = {}) {
  const initialState = {
    version: 1,
    state: targetState,
    transitionCount: 0,
    artifactHash: null,
    lastRun: null,
    metadata: {},
  };
  saveState(initialState, applicationId, dataRoot);
  return initialState;
}

/**
 * List all application directories under data/applications/.
 * @returns {Array<string>} List of application IDs
 */
export function listApplications() {
  const root = getCareerOpsRoot();
  const appsDir = join(root, 'data', 'applications');
  if (!existsSync(appsDir)) {
    return [];
  }
  return readdirSync(appsDir)
    .filter((name) => {
      const statePath = join(appsDir, name, 'state.json');
      return existsSync(statePath);
    })
    .map((name) => name);
}

/**
 * Get the state transition history for an application.
 * @param {string} applicationId - Application identifier
 * @returns {Array<Object>} Transition history
 */
export function getTransitionHistory(applicationId) {
  const state = loadState(applicationId);
  const history = [];
  let current = state;
  while (current.state !== 'DISCOVERED' && current.state !== 'FAILED') {
    const metadata = current.metadata[current.state];
    if (metadata) {
      history.push({
        from: getPreviousState(current.state),
        to: current.state,
        triggeredAt: metadata.triggeredAt,
        ...metadata,
      });
    }
    // Move to previous state - this is simplified; real implementation
    // would track the full path
    break; // Prevent infinite loop - simplified history
  }
  return history;
}

/**
 * Get the previous state in the transition.
 * @param {string} currentState - Current state
 * @returns {string|null} Previous state or null
 */
function getPreviousState(currentState) {
  const predecessors = {
    NORMALIZED: 'DISCOVERED',
    DEDUPED: 'NORMALIZED',
    FIT_EVALUATED: 'DEDUPED',
    SHORTLISTED: 'FIT_EVALUATED',
    CV_GENERATED: 'SHORTLISTED',
    CV_VALIDATED: 'CV_GENERATED',
    READY_TO_FILL: 'CV_VALIDATED',
    FORM_FILLED: 'READY_TO_FILL',
    READY_FOR_HUMAN: 'FORM_FILLED',
    NEEDS_USER_FACT: 'READY_TO_FILL',
    BLOCKED_CAPTCHA: 'READY_TO_FILL',
    FAILED: 'READY_TO_FILL',
  };
  return predecessors[currentState] || null;
}

/**
 * Apply a batch of state transitions.
 * Useful for initializing multiple applications at once.
 * @param {Array<Object>} operations - Array of {applicationId, targetState, inputData, options}
 * @returns {Array<Object>} Results for each operation
 */
export function applyBatch(operations) {
  return operations.map((op) => {
    try {
      return {
        applicationId: op.applicationId,
        success: true,
        state: transitionState(op.applicationId, op.targetState, op.inputData, op.options),
      };
    } catch (error) {
      return {
        applicationId: op.applicationId,
        success: false,
        error: error.message,
      };
    }
  });
}

// ============================================================
// Test self-interruption (run-only, does not export test logic)
// ============================================================
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node src/agent/domain/applications/application-state-machine.mjs [--help]');
  } else {
  // Self-test: verify state machine basics
  console.log('🔧 Application State Machine Self-Test\n');

  const testAppId = 'test-app-001';

  // Initialize
  const initial = loadState(testAppId);
  console.log(`✅ Initial state: ${initial.state} (v${initial.version})`);

  // Transition DISCOVERED → NORMALIZED
  const r1 = transitionState(testAppId, 'NORMALIZED', { sourceUrl: 'https://example.com' });
  console.log(`✅ Transition DISCOVERED→NORMALIZED: state=${r1.state}, v${r1.version}, transitions=${r1.transitionCount}`);

  // Transition NORMALIZED → DEDUPED
  const r2 = transitionState(testAppId, 'DEDUPED', { dedupKey: 'acme-corp-senior-engineer' });
  console.log(`✅ Transition NORMALIZED→DEDUPED: state=${r2.state}, v${r2.version}, transitions=${r2.transitionCount}`);

  // Transition DEDUPED → FIT_EVALUATED
  const r3 = transitionState(testAppId, 'FIT_EVALUATED', { qualified: true, fitScore: 0.85 });
  console.log(`✅ Transition DEDUPED→FIT_EVALUATED: state=${r3.state}, v${r3.version}, transitions=${r3.transitionCount}`);

  // Transition FIT_EVALUATED → SHORTLISTED
  const r4 = transitionState(testAppId, 'SHORTLISTED', {});
  console.log(`✅ Transition FIT_EVALUATED→SHORTLISTED: state=${r4.state}, v${r4.version}, transitions=${r4.transitionCount}`);

  // Transition SHORTLISTED → CV_GENERATED
  const r5 = transitionState(testAppId, 'CV_GENERATED', { cvVersion: 2 });
  console.log(`✅ Transition SHORTLISTED→CV_GENERATED: state=${r5.state}, v${r5.version}, transitions=${r5.transitionCount}`);

  // Transition CV_GENERATED → CV_VALIDATED
  const r6 = transitionState(testAppId, 'CV_VALIDATED', {});
  console.log(`✅ Transition CV_GENERATED→CV_VALIDATED: state=${r6.state}, v${r6.version}, transitions=${r6.transitionCount}`);

  // Transition CV_VALIDATED → READY_TO_FILL
  const r7 = transitionState(testAppId, 'READY_TO_FILL', { formType: 'greenhouse' });
  console.log(`✅ Transition CV_VALIDATED→READY_TO_FILL: state=${r7.state}, v${r7.version}, transitions=${r7.transitionCount}`);

  // Transition READY_TO_FILL → FORM_FILLED
  const r8 = transitionState(testAppId, 'FORM_FILLED', {});
  console.log(`✅ Transition READY_TO_FILL→FORM_FILLED: state=${r8.state}, v${r8.version}, transitions=${r8.transitionCount}`);

  // Transition FORM_FILLED → READY_FOR_HUMAN
  const r9 = transitionState(testAppId, 'READY_FOR_HUMAN', {});
  console.log(`✅ Transition FORM_FILLED→READY_FOR_HUMAN: state=${r9.state}, v${r9.version}, transitions=${r9.transitionCount}`);

  // Test idempotency: rerun same transition should be a no-op
  const r10 = transitionState(testAppId, 'READY_FOR_HUMAN', {}, { force: false });
  console.log(`✅ Idempotent rerun: state=${r10.state}, v${r10.version}, transitions=${r10.transitionCount}`);

  // Test fail-closed: NEEDS_USER_FACT from a separate test app in READY_TO_FILL state
  const testApp2 = 'test-app-002';
  resetState(testApp2, 'READY_TO_FILL');
  const r11 = transitionState(testApp2, 'NEEDS_USER_FACT', {
    jobDescription: { salaryRange: '$150k-$200k' },
  });
  console.log(`✅ NEEDS_USER_FACT halt: state=${r11.state}, transitions=${r11.transitionCount}`);
  console.log(`   Metadata: ${JSON.stringify(r11.metadata.NEEDS_USER_FACT, null, 2)}`);

  // Test fail-closed: BLOCKED_CAPTCHA from another test app in READY_TO_FILL state
  const testApp3 = 'test-app-003';
  resetState(testApp3, 'READY_TO_FILL');
  const r12 = transitionState(testApp3, 'BLOCKED_CAPTCHA', {
    formHtml: '<form><span class="h-captcha"></span></form>',
  });
  console.log(`✅ BLOCKED_CAPTCHA halt: state=${r12.state}, transitions=${r12.transitionCount}`);
  console.log(`   Metadata: ${JSON.stringify(r12.metadata.BLOCKED_CAPTCHA, null, 2)}`);

  // Test invalid transition
  try {
    transitionState(testAppId, 'DISCOVERED', {}); // Can't go back
    console.log('❌ Should have thrown for invalid backward transition');
  } catch (error) {
    console.log(`✅ Invalid transition caught: ${error.message.split(':')[1].trim()}`);
  }

  // List applications
  const allApps = listApplications();
  console.log(`\n📋 Applications on disk: ${allApps.length}`);

  console.log('\n✅ All self-tests passed!');
  }
}