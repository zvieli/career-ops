import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDER_AVAILABILITY_PATH,
  readProviderAvailability,
  writeProviderAvailabilityOverride
} from '../lib/provider-availability.mjs';

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-provider-availability-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const now = new Date('2026-10-14T06:14:32.000Z');
const future = '2026-10-21T06:14:32.000Z';

test('provider availability override is local, time-bounded, and audited as user-confirmed rather than runtime evidence', async () => {
  await withRoot(async (dataRoot) => {
    assert.equal(existsSync(join(dataRoot, 'data', PROVIDER_AVAILABILITY_PATH)), false);
    const record = writeProviderAvailabilityOverride({
      dataRoot, provider: 'antigravity', unavailableUntil: future,
      reason: 'quota_exhausted', source: 'user_confirmed', now
    });
    assert.deepEqual(record, {
      provider: 'antigravity', unavailable_until: future, reason: 'quota_exhausted',
      source: 'user_confirmed', status: 'active'
    });
    const loaded = readProviderAvailability({ dataRoot, now });
    assert.deepEqual(loaded.unavailableProviders, ['antigravity']);
    assert.deepEqual(loaded.overrides, [record]);
    const path = join(dataRoot, 'data', PROVIDER_AVAILABILITY_PATH);
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(persisted.provider_status.antigravity, {
      unavailable_until: future, reason: 'quota_exhausted', source: 'user_confirmed'
    });
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(persisted), /token|secret|credential|stderr|PROVIDER_EXECUTION_FAILED/i);
  });
});

test('expired provider override is inactive automatically and remains visible for audit', async () => {
  await withRoot(async (dataRoot) => {
    writeProviderAvailabilityOverride({
      dataRoot, provider: 'antigravity', unavailableUntil: '2026-10-14T06:14:31.999Z',
      reason: 'quota_exhausted', source: 'user_confirmed', now: new Date('2026-10-14T06:00:00Z')
    });
    const loaded = readProviderAvailability({ dataRoot, now });
    assert.deepEqual(loaded.unavailableProviders, []);
    assert.equal(loaded.overrides[0].status, 'expired');
  });
});

test('provider availability overrides reject unknown providers, malformed dates, long windows, and extra fields', async () => {
  await withRoot(async (dataRoot) => {
    assert.throws(() => writeProviderAvailabilityOverride({
      dataRoot, provider: 'openai', unavailableUntil: future, reason: 'quota_exhausted', source: 'user_confirmed', now
    }), /provider/i);
    assert.throws(() => writeProviderAvailabilityOverride({
      dataRoot, provider: 'antigravity', unavailableUntil: 'next week', reason: 'quota_exhausted', source: 'user_confirmed', now
    }), /timestamp/i);
    assert.throws(() => writeProviderAvailabilityOverride({
      dataRoot, provider: 'antigravity', unavailableUntil: '2026-12-01T00:00:00.000Z', reason: 'quota_exhausted', source: 'user_confirmed', now
    }), /30 days/i);
    assert.throws(() => writeProviderAvailabilityOverride({
      dataRoot, provider: 'antigravity', unavailableUntil: future, reason: 'quota_exhausted', source: 'inferred', now
    }), /source/i);
    const path = join(dataRoot, 'data', PROVIDER_AVAILABILITY_PATH);
    writeProviderAvailabilityOverride({ dataRoot, provider: 'antigravity', unavailableUntil: future, reason: 'quota_exhausted', source: 'user_confirmed', now });
    writeFileSync(path, JSON.stringify({ schema_version: 1, provider_status: { antigravity: {
      unavailable_until: future, reason: 'quota_exhausted', source: 'user_confirmed', api_key: 'must-not-be-accepted'
    } } }));
    assert.throws(() => readProviderAvailability({ dataRoot, now }), /unsupported|extra|field/i);
  });
});
