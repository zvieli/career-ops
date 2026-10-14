#!/usr/bin/env node
/**
 * lib/run-reporter.mjs — Records structured JSON run receipts and generates
 * human-readable summaries with PII/credential redaction.
 *
 * Persists one receipt file per run under data/runs/{run_id}.json.
 * All credentials, emails, phone numbers, and bearer tokens are redacted
 * from the output before persisting.
 *
 * Run-id format: {ISO-timestamp}-{short-uuid} (deterministic from start time)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

/**
 * Sanitizes/redacts PII and credentials from a string value.
 * Redacts: email addresses, phone numbers, bearer tokens, API keys.
 *
 * @param {unknown} value - Value to redact
 * @returns {string} Redacted string
 */
function redactValue(value) {
  if (value === null || value === undefined || value === '') return String(value);

  const str = String(value);

  // Redact email addresses
  const redactEmail = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]');

  // Redact phone numbers (various formats)
  const redactPhone = redactEmail.replace(
    /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    '[redacted]'
  );

  // Redact bearer tokens and API keys
  const redactToken = redactPhone.replace(
    /(sk|key|token|secret|bearer|api[-_]?key)([-_=:\s"']+)[A-Za-z0-9._-]{8,}/gi,
    '$1$2[redacted]'
  );

  // Redact credit card-like numbers (13-16 digits)
  const redactCard = redactToken.replace(/\b\d{13,16}\b/g, '[redacted]');

  return redactCard;
}

/**
 * Sanitizes/redacts PII and credentials from an object recursively.
 * @param {unknown} obj - Object to redact
 * @returns {unknown} Redacted object
 */
export function redactObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (typeof obj !== 'object') return redactValue(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = redactObject(value);
  }
  return result;
}

/**
 * Generates a deterministic run ID from the start timestamp.
 * Format: {ISO-timestamp}-{sha256-hex-slice}
 *
 * @param {Date} startedAt - The run start time
 * @returns {string} Unique run ID
 */
function generateRunId(startedAt) {
  const dateObj = startedAt instanceof Date ? startedAt : new Date(startedAt || Date.now());
  const timestamp = dateObj.toISOString().replace(/[:.]/g, '-');
  const hash = createHash('sha256').update(dateObj.toString()).digest('hex').slice(0, 8);
  return `${timestamp}-${hash}`;
}

/**
 * Creates the data/runs directory if it doesn't exist.
 */
function ensureRunsDir(dataRoot = getCareerOpsRoot()) {
  const runsDir = resolve(dataRoot, 'data', 'runs');
  if (!existsSync(runsDir)) {
    mkdirSync(runsDir, { recursive: true });
  }
  return runsDir;
}

/**
 * Persists a structured run receipt JSON file.
 *
 * @param {Object} receipt - The run receipt object to persist
 * @param {string} runId - The unique run identifier
 * @returns {string} The path to the persisted file
 */
function persistReceipt(receipt, runId, dataRoot = getCareerOpsRoot()) {
  const runsDir = ensureRunsDir(dataRoot);
  const receiptPath = join(runsDir, `${runId}.json`);

  // Redact any PII/credentials before writing
  const sanitized = redactObject(receipt);

  writeFileSync(receiptPath, JSON.stringify(sanitized, null, 2));
  return receiptPath;
}

/**
 * Records a structured JSON run receipt.
 *
 * Captures: started_at, finished_at, jobs_fetched, new_jobs, duplicates,
 * deterministic_rejects, system1_calls, system2_calls, cache_hits,
 * shortlisted, cv_generated, cv_validated, forms_filled, ready_for_human,
 * needs_user_fact, blocked_captcha, errors.
 *
 * @param {Object} options - Run metadata
 * @param {Date} [options.started_at] - Run start time (defaults to now)
 * @param {Date} [options.finished_at] - Run finish time (defaults to now)
 * @param {number} [options.jobs_fetched=0] - Total job postings fetched
 * @param {number} [options.new_jobs=0] - New/unique job postings
 * @param {number} [options.duplicates=0] - Duplicate postings filtered
 * @param {number} [options.deterministic_rejects=0] - Deterministic rejects
 * @param {number} [options.system1_calls=0] - System1 LLM calls
 * @param {number} [options.system2_calls=0] - System2 LLM calls
 * @param {number} [options.cache_hits=0] - Cache hits
 * @param {number} [options.shortlisted=0] - Shortlisted candidates
 * @param {number} [options.cv_generated=0] - CVs generated
 * @param {number} [options.cv_validated=0] - CVs validated
 * @param {number} [options.forms_filled=0] - Forms filled
 * @param {boolean} [options.ready_for_human=false] - Ready for human review
 * @param {boolean} [options.needs_user_fact=false] - Needs user fact
 * @param {boolean} [options.blocked_captcha=false] - Blocked by CAPTCHA
 * @param {boolean} [options.quota_observable=false] - Whether provider quota could be queried
 * @param {boolean} [options.quota_known=false] - Whether a finite provider quota value is known
 * @param {string|number} [options.quota_remaining=UNKNOWN] - Remaining provider quota, independent of provider-call success
 * @param {string} [options.quota_status=UNKNOWN] - Quota observability status
 * @param {string} [options.provider_call_status=NOT_ATTEMPTED] - Actual provider call outcome
 * @param {string} [options.provider_usable=UNKNOWN] - Observed exact-inventory provider usability, independent of quota knowledge
 * @param {Array<Object>} [options.provider_availability_overrides=[]] - Safe operator-confirmed provider skip records, expiry, and active/expired status
 * @param {Array<Object>} [options.models_used=[]] - Attempted model IDs, exact inventory/cost provenance, quota evidence, and tier
 * @param {number} [options.pending_jobs_before=0] - Active durable queue size before this run processes jobs
 * @param {number} [options.pending_jobs_after=0] - Active durable queue size after this run processes jobs
 * @param {number} [options.pending_jobs_processed=0] - Number of durable queue entries attempted
 * @param {number} [options.blocked_jobs=0] - Durable queue entries held for manual review
 * @param {Array<string>} [options.errors=[]] - Errors encountered
 * @returns {string} The run ID of the persisted receipt
 */
export function recordRun({
  run_id = null,
  started_at = new Date(),
  finished_at = new Date(),
  jobs_fetched = 0,
  new_jobs = 0,
  duplicates = 0,
  deterministic_rejects = 0,
  system1_calls = 0,
  system2_calls = 0,
  cache_hits = 0,
  shortlisted = 0,
  cv_generated = 0,
  cv_validated = 0,
  forms_filled = 0,
  ready_for_human = false,
  needs_user_fact = false,
  blocked_captcha = false,
  quota_observable = false,
  quota_known = false,
  quota_remaining = 'UNKNOWN',
  quota_status = 'UNKNOWN',
  provider_call_status = 'NOT_ATTEMPTED',
  provider_usable = 'UNKNOWN',
  provider_availability_overrides = [],
  models_used = [],
  pending_jobs_before = 0,
  pending_jobs_after = 0,
  pending_jobs_processed = 0,
  blocked_jobs = 0,
  errors = [],
  dataRoot = getCareerOpsRoot(),
}) {
  const startDate = started_at instanceof Date ? started_at : new Date(started_at || Date.now());
  const finishDate = finished_at instanceof Date ? finished_at : new Date(finished_at || Date.now());
  const runId = run_id || generateRunId(startDate);
  const receipt = {
    run_id: runId,
    started_at: startDate.toISOString(),
    finished_at: finishDate.toISOString(),
    jobs_fetched,
    new_jobs,
    duplicates,
    deterministic_rejects,
    system1_calls,
    system2_calls,
    cache_hits,
    shortlisted,
    cv_generated,
    cv_validated,
    forms_filled,
    ready_for_human,
    needs_user_fact,
    blocked_captcha,
    quota_observable,
    quota_known,
    quota_remaining,
    quota_status,
    provider_call_status,
    provider_usable,
    provider_availability_overrides,
    models_used,
    pending_jobs_before,
    pending_jobs_after,
    pending_jobs_processed,
    blocked_jobs,
    errors: errors.map(e => redactValue(e)),
  };

  const receiptPath = persistReceipt(receipt, runId, dataRoot);
  return runId;
}

/**
 * Generates a human-readable summary of the run receipt.
 *
 * @param {Object} receipt - The run receipt object
 * @returns {string} Human-readable summary
 */
function generateSummary(receipt) {
  const lines = [
    `Run ID: ${receipt.run_id}`,
    `Started at: ${receipt.started_at}`,
    `Finished at: ${receipt.finished_at}`,
    '',
    'Statistics:',
    `  Jobs fetched: ${receipt.jobs_fetched}`,
    `  New jobs: ${receipt.new_jobs}`,
    `  Duplicates filtered: ${receipt.duplicates}`,
    `  Deterministic rejects: ${receipt.deterministic_rejects}`,
    `  System1 calls: ${receipt.system1_calls}`,
    `  System2 calls: ${receipt.system2_calls}`,
    `  Cache hits: ${receipt.cache_hits}`,
    `  Shortlisted: ${receipt.shortlisted}`,
    `  CV generated: ${receipt.cv_generated}`,
    `  CV validated: ${receipt.cv_validated}`,
    `  Forms filled: ${receipt.forms_filled}`,
    `  Ready for human: ${receipt.ready_for_human}`,
    `  Needs user fact: ${receipt.needs_user_fact}`,
    `  Blocked by CAPTCHA: ${receipt.blocked_captcha}`,
    `  Provider quota observable: ${receipt.quota_observable}`,
    `  Provider quota known: ${receipt.quota_known}`,
    `  Provider quota remaining: ${receipt.quota_remaining}`,
    `  Provider quota status: ${receipt.quota_status}`,
    `  Provider usable: ${receipt.provider_usable}`,
    `  Provider call status: ${receipt.provider_call_status}`,
    `  Pending jobs before/after: ${receipt.pending_jobs_before || 0}/${receipt.pending_jobs_after || 0}`,
    `  Pending jobs processed: ${receipt.pending_jobs_processed || 0}`,
    `  Blocked queue jobs: ${receipt.blocked_jobs || 0}`,
    `  Models used: ${receipt.models_used?.length || 0}`,
    '',
    'Errors:',
  ];

  if (receipt.errors.length === 0) {
    lines.push('  (none)');
  } else {
    receipt.errors.forEach((err, i) => {
      lines.push(`  ${i + 1}. ${err}`);
    });
  }

  return lines.join('\n');
}

/**
 * Reads a run receipt by run ID.
 *
 * @param {string} runId - The run identifier
 * @returns {Object|null} The receipt object or null if not found
 */
export function readReceipt(runId) {
  const runsDir = resolve(getCareerOpsRoot(), 'data', 'runs');
  const receiptPath = join(runsDir, `${runId}.json`);

  if (!existsSync(receiptPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(receiptPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Lists all run receipts in the data/runs directory.
 *
 * @returns {Array<Object>} Array of run receipt objects
 */
export function listReceipts() {
  const runsDir = resolve(getCareerOpsRoot(), 'data', 'runs');

  if (!existsSync(runsDir)) {
    return [];
  }

  const files = readdirSync(runsDir);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const path = join(runsDir, f);
      try {
        return JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(r => r !== null);
}

/**
 * Gets the human-readable summary for a run receipt.
 *
 * @param {string} runId - The run identifier
 * @returns {string|null} The summary or null if not found
 */
export function getSummary(runId) {
  const receipt = readReceipt(runId);
  if (!receipt) return null;
  return generateSummary(receipt);
}
