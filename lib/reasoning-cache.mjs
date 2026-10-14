// @ts-check
/**
 * reasoning-cache.mjs — Persistent Disk Cache for LLM Reasoning
 *
 * Keyed by SHA256(jd_text + candidate_profile_hash + prompt_version + model_id)
 * Cache directory: data/cache/reasoning/ under CareerOps data root
 *
 * Stored payload:
 * - provider: string
 * - model: string
 * - created_at: string (ISO 8601)
 * - schema_version: string
 * - extracted_fields: object (required/preferred YOE, degree, GPA, role family, confidence, etc.)
 * - evidence_quotes: string[] | object[] (mandatory evidence spans)
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  renameSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isZeroCostModel } from './zero-cost-router.mjs';

export const SCHEMA_VERSION = '2.0.0';

/**
 * Accept cache only when all current provenance and evidence checks pass.
 * @param {any} entry
 * @param {{ prompt_version: string, schema_version: string, candidate_profile_hash: string, job_description_hash: string }} expected
 * @param {(quotes: string[]) => boolean} validateEvidence
 * @returns {boolean}
 */
export function validateReasoningCacheEntry(entry, expected, validateEvidence) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.model_id !== 'string' || !isZeroCostModel(entry.model_id)) return false;
  if (entry.provider !== entry.model_id.split('/')[0]) return false;
  if (entry.schema_version !== expected.schema_version || entry.prompt_version !== expected.prompt_version) return false;
  if (entry.candidate_profile_hash !== expected.candidate_profile_hash) return false;
  if (entry.job_description_hash !== expected.job_description_hash) return false;
  if (entry.validation_status !== 'PASS') return false;
  if (typeof entry.created_at !== 'string' || Number.isNaN(Date.parse(entry.created_at))) return false;
  if (!Array.isArray(entry.evidence_quotes) || entry.evidence_quotes.length === 0) return false;
  return typeof validateEvidence === 'function' && validateEvidence(entry.evidence_quotes);
}

/**
 * Resolve reasoning cache directory
 * @param {string} [dataRoot]
 * @returns {string}
 */
export function getReasoningCacheDir(dataRoot) {
  const root = dataRoot || getCareerOpsRoot();
  return resolve(root, 'data', 'cache', 'reasoning');
}

/**
 * Compute SHA256 cache key
 * SHA256(jd_text + candidate_profile_hash + prompt_version + model_id)
 * Accepts either an object { jd_text, candidate_profile_hash, prompt_version, model_id }
 * or individual parameters (jdText, candidateProfileHash, promptVersion, modelId).
 *
 * @param {string | object} jdTextOrOptions
 * @param {string} [candidateProfileHash]
 * @param {string} [promptVersion]
 * @param {string} [modelId]
 * @returns {string} SHA256 hex digest
 */
export function computeReasoningCacheKey(
  jdTextOrOptions,
  candidateProfileHash,
  promptVersion,
  modelId
) {
  let jd = '';
  let profileHash = '';
  let pVer = '';
  let mId = '';

  if (typeof jdTextOrOptions === 'object' && jdTextOrOptions !== null) {
    jd = jdTextOrOptions.jd_text ?? jdTextOrOptions.jdText ?? '';
    profileHash = jdTextOrOptions.candidate_profile_hash ?? jdTextOrOptions.candidateProfileHash ?? '';
    pVer = jdTextOrOptions.prompt_version ?? jdTextOrOptions.promptVersion ?? '';
    mId = jdTextOrOptions.model_id ?? jdTextOrOptions.modelId ?? '';
  } else {
    jd = jdTextOrOptions ?? '';
    profileHash = candidateProfileHash ?? '';
    pVer = promptVersion ?? '';
    mId = modelId ?? '';
  }

  const raw = `${jd}${profileHash}${pVer}${mId}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Get file path for a cache key
 * @param {string} key
 * @param {string} [dataRoot]
 * @returns {string}
 */
export function getReasoningCachePath(key, dataRoot) {
  const dir = getReasoningCacheDir(dataRoot);
  return join(dir, `${key}.json`);
}

/**
 * Read entry from reasoning cache
 * @param {string} key
 * @param {{ dataRoot?: string, maxAgeMs?: number }} [options]
 * @returns {object | null}
 */
export function getReasoningCache(key, options = {}) {
  if (!key || typeof key !== 'string') return null;
  const filePath = getReasoningCachePath(key, options.dataRoot);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf8');
    const entry = JSON.parse(raw);

    if (options.maxAgeMs && entry.created_at) {
      const createdTime = new Date(entry.created_at).getTime();
      if (!Number.isNaN(createdTime) && Date.now() - createdTime > options.maxAgeMs) {
        return null;
      }
    }

    return entry;
  } catch {
    return null;
  }
}

/**
 * Write entry to reasoning cache atomically
 * @param {string} key
 * @param {object} payload
 * @param {{ dataRoot?: string }} [options]
 * @returns {object} Stored cache entry
 */
export function setReasoningCache(key, payload, options = {}) {
  if (!key || typeof key !== 'string') {
    throw new Error('reasoning-cache: invalid key provided');
  }

  const dir = getReasoningCacheDir(options.dataRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const targetPath = getReasoningCachePath(key, options.dataRoot);
  const tempPath = join(dir, `${key}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

  const entry = {
    key,
    provider: payload.provider || 'unknown',
    model: payload.model || 'unknown',
    model_id: payload.model_id || 'unknown',
    model_version: payload.model_version ?? null,
    prompt_version: payload.prompt_version || null,
    candidate_profile_hash: payload.candidate_profile_hash || null,
    job_description_hash: payload.job_description_hash || null,
    validation_status: payload.validation_status || 'UNVALIDATED',
    created_at: payload.created_at || new Date().toISOString(),
    schema_version: payload.schema_version || SCHEMA_VERSION,
    extracted_fields: payload.extracted_fields || payload.extractedFields || {},
    evidence_quotes: payload.evidence_quotes || payload.evidenceQuotes || []
  };

  const serialized = JSON.stringify(entry, null, 2);
  writeFileSync(tempPath, serialized, 'utf8');

  try {
    renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {}
    writeFileSync(targetPath, serialized, 'utf8');
  }

  return entry;
}

/**
 * Delete a specific entry from reasoning cache
 * @param {string} key
 * @param {{ dataRoot?: string }} [options]
 * @returns {boolean} True if file was deleted, false otherwise
 */
export function deleteReasoningCache(key, options = {}) {
  const filePath = getReasoningCachePath(key, options.dataRoot);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear all cache entries in reasoning cache directory
 * @param {{ dataRoot?: string }} [options]
 * @returns {number} Count of removed entries
 */
export function clearReasoningCache(options = {}) {
  const dir = getReasoningCacheDir(options.dataRoot);
  if (!existsSync(dir)) return 0;

  let count = 0;
  const files = readdirSync(dir);
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        unlinkSync(join(dir, file));
        count++;
      } catch {}
    }
  }
  return count;
}
