// @ts-check
/**
 * zero-cost-router.mjs — Zero-Incremental-Cost LLM Model Router
 *
 * Enforces strict financial fail-closed policy:
 * Only exact provider/model IDs in the adjacent inventory with
 * incremental_cost === "zero" and automation_access === true are admitted.
 * Quota status and physical-model provenance remain explicitly unknown.
 * No substring matching, no fake -free names, and zero paid API fallbacks.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVENTORY_PATH = join(__dirname, 'zero-cost-model-inventory.json');

/**
 * Load verified zero-cost models from single source of truth
 * @returns {Map<string, { provider: string, model: string, access_type: string, incremental_cost: string, automation_access: boolean }>}
 */
export function loadVerifiedModelInventory() {
  if (!existsSync(INVENTORY_PATH)) {
    throw new Error(`zero-cost-router: Missing inventory file at ${INVENTORY_PATH}`);
  }
  const raw = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  const map = new Map();
  for (const entry of raw) {
    if (entry.incremental_cost === 'zero' && entry.automation_access === true) {
      map.set(entry.model_id, entry);
    }
  }
  return map;
}

// Single source of truth loaded into memory
const VERIFIED_MODELS = loadVerifiedModelInventory();

export const ZERO_COST_REGISTRY = {
  // Tier 1: System 1 (Fast Extraction & Triage)
  system1: {
    primary: 'antigravity/gemini-3.8-flash',
    fallbacks: [
      'openai-codex/gpt-6-luna',
      'opencode/nemotron-3.5-lightning-free',
      'kilo/nvidia/nemotron-3.5-lightning:free',
      'ollama/qwen2.5-coder:3b'
    ]
  },
  // Tier 2: System 2 (Deep Ambiguity Reasoning & CV Tailoring)
  system2: {
    primary: 'openai-codex/gpt-6.1-sol',
    fallbacks: [
      'antigravity/gemini-3.1-pro',
      'ollama/qwen2.5-coder:3b'
    ]
  }
};

/**
 * Strict exact allowlist check: model must exist in verified inventory
 * @param {string} modelId
 * @returns {boolean}
 */
export function isZeroCostModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  return VERIFIED_MODELS.has(modelId);
}

/**
 * Resolve the authorized model chain for a given task tier
 * @param {'system1' | 'system2'} tier
 * @param {{ unavailableProviders?: string[] }} [options] - Active provider exclusions; never changes chain order or inventory policy
 * @returns {string[]}
 */
export function resolveZeroCostChain(tier, { unavailableProviders = [] } = {}) {
  const config = ZERO_COST_REGISTRY[tier];
  if (!config) {
    throw new Error(`zero-cost-router: Unknown tier "${tier}". Must be system1 or system2.`);
  }

  const candidates = [config.primary, ...config.fallbacks];
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      deduped.push(c);
    }
  }

  // Provider availability is an operator-supplied skip only; the exact inventory
  // and configured chain order remain authoritative for every attempted model.
  const unavailable = new Set(unavailableProviders);
  // Filter strictly through verified inventory allowlist and active availability.
  const approved = deduped.filter((modelId) => isZeroCostModel(modelId) && !unavailable.has(modelId.split('/')[0]));

  if (approved.length === 0) {
    throw new Error(`zero-cost-router: No verified zero-cost models available for tier ${tier}. Refusing paid API fallback.`);
  }

  return approved;
}
