import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { ZERO_COST_REGISTRY } from './zero-cost-router.mjs';

export const PROVIDER_AVAILABILITY_PATH = 'provider-status/status.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_UNAVAILABILITY_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_REASONS = new Set(['quota_exhausted']);
const ALLOWED_SOURCES = new Set(['user_confirmed']);
const KNOWN_PROVIDERS = new Set(Object.values(ZERO_COST_REGISTRY)
  .flatMap(({ primary, fallbacks }) => [primary, ...fallbacks])
  .map((modelId) => modelId.split('/')[0]));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} contains unsupported or missing fields.`);
  }
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('unavailable_until must be an ISO timestamp with an explicit timezone.');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('unavailable_until must be a valid ISO timestamp.');
  return new Date(time);
}

function statusPath(dataRoot) {
  return join(resolve(dataRoot), 'data', PROVIDER_AVAILABILITY_PATH);
}

function validateStoredStatus(parsed) {
  assertExactKeys(parsed, ['schema_version', 'provider_status'], 'Provider availability file');
  if (parsed.schema_version !== 1) throw new Error('Unsupported provider availability schema_version.');
  if (!isRecord(parsed.provider_status)) throw new Error('provider_status must be an object.');
  for (const [provider, entry] of Object.entries(parsed.provider_status)) {
    if (!KNOWN_PROVIDERS.has(provider)) throw new Error(`Unknown provider in provider_status: ${provider}.`);
    assertExactKeys(entry, ['unavailable_until', 'reason', 'source'], `provider_status.${provider}`);
    parseTimestamp(entry.unavailable_until);
    if (!ALLOWED_REASONS.has(entry.reason)) throw new Error(`Unsupported provider_status.${provider}.reason.`);
    if (!ALLOWED_SOURCES.has(entry.source)) throw new Error(`Unsupported provider_status.${provider}.source.`);
  }
  return parsed;
}

function readStored(dataRoot) {
  const path = statusPath(dataRoot);
  if (!existsSync(path)) return { schema_version: 1, provider_status: {} };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Provider availability file is corrupt at ${path}; refusing to ignore or rewrite it.`, { cause: error }); }
  return validateStoredStatus(parsed);
}

function asNow(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Provider availability clock must be a valid date.');
  return date;
}

export function readProviderAvailability({ dataRoot = getCareerOpsRoot(), now = new Date() } = {}) {
  const current = asNow(now).getTime();
  const stored = readStored(dataRoot);
  const overrides = Object.entries(stored.provider_status).sort(([left], [right]) => left.localeCompare(right)).map(([provider, entry]) => {
    const unavailableUntil = parseTimestamp(entry.unavailable_until).toISOString();
    const active = current < Date.parse(unavailableUntil);
    return {
      provider, unavailable_until: unavailableUntil, reason: entry.reason,
      source: entry.source, status: active ? 'active' : 'expired'
    };
  });
  return {
    overrides,
    unavailableProviders: overrides.filter((entry) => entry.status === 'active').map((entry) => entry.provider)
  };
}

export function writeProviderAvailabilityOverride({
  dataRoot = getCareerOpsRoot(), provider, unavailableUntil, reason, source, now = new Date()
} = {}) {
  if (typeof provider !== 'string' || !KNOWN_PROVIDERS.has(provider)) throw new Error('Provider override requires a provider in the verified zero-cost chains.');
  if (!ALLOWED_REASONS.has(reason)) throw new Error('Provider override reason must be quota_exhausted.');
  if (!ALLOWED_SOURCES.has(source)) throw new Error('Provider override source must be user_confirmed.');
  const current = asNow(now).getTime();
  const until = parseTimestamp(unavailableUntil);
  const duration = until.getTime() - current;
  if (duration <= 0) throw new Error('Provider override unavailable_until must be in the future.');
  if (duration > MAX_UNAVAILABILITY_MS) throw new Error('Provider override may not exceed 30 days.');

  const path = statusPath(dataRoot);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  const stored = readStored(dataRoot);
  stored.provider_status[provider] = {
    unavailable_until: until.toISOString(), reason, source
  };
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = openSync(temporaryPath, 'wx', FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
    chmodSync(path, FILE_MODE);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return readProviderAvailability({ dataRoot, now }).overrides.find((entry) => entry.provider === provider);
}
