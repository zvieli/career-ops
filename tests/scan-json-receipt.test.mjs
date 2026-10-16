import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { appendProviderIdentity, atomicWriteFile, collectSeenUrls, createAutonomousQueueJobs, formatPipelineOffer, formatScanHistoryRow, isIgnorableDirectoryFsyncError, rethrowProviderIdentityIntegrityError, runScanDiscoveryTasks, scanHistoryStatusForVerifiedOffer, shouldDedupScanHistoryRow, toJsonJobReceipt, verifyOffers, actionableVerifiedOffers, isValidNormalizedJob } from '../scan.mjs';
import { SCAN_HISTORY_COLUMNS } from '../lib/scan-history-columns.mjs';
import { filesystemPrivacyCapabilities } from '../src/agent/infrastructure/persistence/filesystem-privacy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scan.mjs');

function workspace(portals) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-scan-receipt-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'portals.yml'), portals);
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');
  return root;
}

function runJson(root) {
  return spawnSync(process.execPath, [SCAN, '--dry-run', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_PORTALS: join(root, 'portals.yml'),
      CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
      CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
      CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv'),
    },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('normalization validity rejects empty, malformed, credentialed, and unsupported jobs but allows missing company for board fallback', () => {
  assert.equal(isValidNormalizedJob({ title: '', url: 'https://jobs.example/1' }), false);
  assert.equal(isValidNormalizedJob({ title: 'Engineer', url: '' }), false);
  assert.equal(isValidNormalizedJob({ title: 'Engineer', url: 'not a url' }), false);
  assert.equal(isValidNormalizedJob({ title: 'Engineer', url: 'file:///tmp/job' }), false);
  assert.equal(isValidNormalizedJob({ title: 'Engineer', url: 'https://user:pass@jobs.example/1' }), false);
  assert.equal(isValidNormalizedJob({ title: 'Engineer', company: '', url: 'https://jobs.example/1' }), true);
});

test('scanner provider identity accumulation rejects overflow instead of dropping identity evidence', () => {
  const existing = Array.from({ length: 20 }, (_, index) => ({ provider: `source-${index}`, id: `id-${index}` }));
  const before = structuredClone(existing);
  assert.throws(() => appendProviderIdentity(existing, 'source-overflow', 'id-overflow'), /provider-scoped identity limit/);
  assert.deepEqual(existing, before, 'overflow does not mutate or truncate existing identity evidence');
  assert.equal(appendProviderIdentity(existing.slice(0, 19), 'source-19', 'id-19').length, 20);
  assert.throws(() => appendProviderIdentity([], 'source', 'x'.repeat(201)), /provider-scoped identity limit/);
  assert.throws(() => appendProviderIdentity([{ provider: 'same-source', id: 'first' }], 'same-source', 'different'), /identity conflict/);
});

test('scanner integrity failure aborts before queue and history persistence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-scan-integrity-'));
  try {
    const queuePath = join(root, 'data', 'autonomous-pending.json');
    const historyPath = join(root, 'data', 'scan-history.tsv');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(queuePath, '{"jobs":[]}\n');
    writeFileSync(historyPath, 'history-before\n');
    const queueBefore = readFileSync(queuePath, 'utf8');
    const historyBefore = readFileSync(historyPath, 'utf8');
    const overflow = Array.from({ length: 20 }, (_, index) => ({ provider: `source-${index}`, id: `id-${index}` }));
    await assert.rejects(runScanDiscoveryTasks([async () => {
      try { appendProviderIdentity(overflow, 'source-overflow', 'id-overflow'); }
      catch (error) { rethrowProviderIdentityIntegrityError(error); }
    }], 1, async () => {
      writeFileSync(queuePath, 'queue-corrupted\n');
      writeFileSync(historyPath, 'history-corrupted\n');
    }), /provider-scoped identity limit/);
    assert.equal(readFileSync(queuePath, 'utf8'), queueBefore);
    assert.equal(readFileSync(historyPath, 'utf8'), historyBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('job receipt preserves exact ATS identity and liveness verification status', () => {
  const receipt = toJsonJobReceipt({ company: 'Acme', title: 'Engineer', url: 'https://boards.greenhouse.io/acme/jobs/123', location: 'Remote', postedAt: 123, externalId: '123', requisitionId: 'REQ-123', source: 'greenhouse-api' }, 'active');
  assert.deepEqual(receipt, {
    company: 'Acme', title: 'Engineer', url: 'https://boards.greenhouse.io/acme/jobs/123', location: 'Remote',
    postedAt: 123, externalId: '123', requisitionId: 'REQ-123', provider: 'greenhouse-api',
    discovered_via: ['greenhouse-api'], authoritative_provider: 'greenhouse',
    source_urls: ['https://boards.greenhouse.io/acme/jobs/123'], provider_ids: [{ provider: 'greenhouse-api', id: '123' }],
    verification_status: 'active'
  });
});

test('atomicWriteFile replaces content without leaving a temporary file', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-'));
  try {
    const target = join(root, 'pipeline.md');
    writeFileSync(target, 'before\n');
    atomicWriteFile(target, 'after\n');
    assert.equal(readFileSync(target, 'utf-8'), 'after\n');
    assert.deepEqual(readdirSync(root), ['pipeline.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile preserves restrictive destination permissions where POSIX modes apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-mode-'));
  try {
    const target = join(root, 'pipeline.md');
    writeFileSync(target, 'before\n');
    chmodSync(target, 0o600);
    atomicWriteFile(target, 'after\n');
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile preserves a destination symlink and replaces its target', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-symlink-'));
  try {
    const target = join(root, 'pipeline-target.md');
    const link = join(root, 'pipeline.md');
    writeFileSync(target, 'before\n');
    try { symlinkSync(target, link, 'file'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`File symlink creation unavailable: ${error.code}`);
      return;
    }
    atomicWriteFile(link, 'after\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(target, 'utf-8'), 'after\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomicWriteFile cannot be redirected through the old predictable temporary path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-atomic-temp-link-'));
  try {
    const target = join(root, 'pipeline.md');
    const victim = join(root, 'victim.md');
    const predictableTemp = `${target}.tmp-${process.pid}`;
    writeFileSync(victim, 'untouched\n');
    try { symlinkSync(victim, predictableTemp, 'file'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`File symlink creation unavailable: ${error.code}`);
      return;
    }
    atomicWriteFile(target, 'pipeline\n');
    assert.equal(readFileSync(target, 'utf-8'), 'pipeline\n');
    assert.equal(readFileSync(victim, 'utf-8'), 'untouched\n');
    assert.equal(lstatSync(predictableTemp).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only unsupported directory fsync errors are ignored on Windows', () => {
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EPERM' }, 'win32'), true);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EACCES' }, 'win32'), true);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EINVAL' }, 'linux'), true);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'EPERM' }, 'darwin'), false);
  assert.equal(isIgnorableDirectoryFsyncError({ code: 'ENOSPC' }, 'win32'), false);
});

test('--json emits exactly one clean successful receipt', () => {
  const root = workspace('tracked_companies: []\njob_boards: []\n');
  try {
    const result = runJson(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.match(receipt.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(receipt, {
      version: 'careerops.scan.receipt@1',
      date: receipt.date,
      scanned: 0,
      skipped: 0,
      found: 0,
      filtered: 0,
      duplicates: 0,
      added: 0,
      added_urls: [],
      added_jobs: [],
      errors: [],
      source_metrics: [],
      unverified_zero: [],
      dry_run: true,
    });
    assert.match(result.stderr, /Portal Scan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--json returns exit 2 and structured errors for a partial failure', () => {
  const root = workspace([
    'tracked_companies:',
    '  - name: Broken Co',
    '    provider: provider-that-does-not-exist',
    'job_boards: []',
    '',
  ].join('\n'));
  try {
    const result = runJson(root);
    assert.equal(result.status, 2, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.version, 'careerops.scan.receipt@1');
    assert.equal(receipt.dry_run, true);
    assert.deepEqual(receipt.errors, [{
      company: 'Broken Co',
      error: 'unknown provider: provider-that-does-not-exist',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source metrics count a failed local-parser attempt once when no fallback resolves', () => {
  const root = workspace([
    'tracked_companies:',
    '  - name: Parser Failure',
    '    careers_url: https://example.test/careers',
    '    parser:',
    '      command: node',
    '      script: tests/fixtures/failing-discovery-parser.mjs',
    'job_boards: []',
    '',
  ].join('\n'));
  try {
    const result = runJson(root);
    assert.equal(result.status, 2);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt.source_metrics, [{
      source: 'local-parser', attempts: 1, successes: 0, failures: 1,
      jobs_discovered_raw: 0, jobs_normalized: 0, jobs_duplicate: 0, jobs_unique: 0,
      jobs_hydration_attempted: 0, jobs_hydrated_full: 0, jobs_hydrated_partial: 0, jobs_hydration_failed: 0,
      jobs_liveness_checked: 0, jobs_live: 0, jobs_closed: 0, jobs_liveness_unknown: 0, jobs_liveness_blocked: 0,
      jobs_authoritative_destination_resolved: 0, cross_source_duplicates_resolved: 0,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('liveness verification returns the time at which the API verdict was obtained', async () => {
  const offer = { url: 'https://boards.greenhouse.io/example/jobs/123', company: 'Example', title: 'Engineer' };
  const before = Date.now();
  const result = await verifyOffers([offer], {}, {
    checkApi: async () => ({ result: 'active' }),
    loadPlaywright: async () => { throw new Error('API verdict should not require browser fallback'); }
  });
  const verifiedAt = Date.parse(result.verificationTimeByOffer.get(offer));
  assert.equal(result.verificationStatusByOffer.get(offer), 'active');
  assert.ok(Number.isFinite(verifiedAt) && verifiedAt >= before && verifiedAt <= Date.now());
});

test('autonomous queue includes only active employer postings and retains their actual verification timestamp', () => {
  const active = { url: 'https://boards.greenhouse.io/a/jobs/1', company: 'A', title: 'Engineer', source: 'greenhouse-api' };
  const uncertain = { url: 'https://boards.greenhouse.io/b/jobs/2', company: 'B', title: 'Engineer', source: 'greenhouse-api' };
  const absent = { url: 'https://boards.greenhouse.io/c/jobs/3', company: 'C', title: 'Engineer', source: 'greenhouse-api' };
  const aggregator = { url: 'https://www.linkedin.com/jobs/view/4', company: 'D', title: 'Engineer', source: 'linkedin' };
  const status = new Map([[active, 'active'], [uncertain, 'uncertain'], [aggregator, 'active']]);
  const times = new Map([[active, '2026-10-13T12:00:00.000Z'], [uncertain, '2026-10-13T12:01:00.000Z']]);
  assert.deepEqual(createAutonomousQueueJobs([active, uncertain, absent, aggregator], status, times), [{
    company: 'A', title: 'Engineer', url: active.url, location: '', postedAt: null,
    externalId: '', requisitionId: '', provider: 'greenhouse-api',
    discovered_via: ['greenhouse-api'], authoritative_provider: 'greenhouse', source_urls: [active.url], provider_ids: [],
    verification_status: 'active', liveness_verified_at: '2026-10-13T12:00:00.000Z'
  }]);
});

test('uncertain liveness is eligible on the next scan using both history and pending-pipeline inputs', () => {
  const uncertain = { url: 'https://boards.greenhouse.io/b/jobs/2', company: 'B', title: 'Engineer', source: 'greenhouse-api' };
  const status = new Map([[uncertain, 'uncertain']]);
  assert.equal(scanHistoryStatusForVerifiedOffer('uncertain'), 'verification_uncertain');
  assert.equal(scanHistoryStatusForVerifiedOffer('active'), 'added');
  assert.equal(scanHistoryStatusForVerifiedOffer(undefined), 'added');
  assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-10-13', status: 'verification_uncertain' }), false);
  const pipelineOffers = actionableVerifiedOffers([uncertain], status);
  const pipelineText = ['# Pipeline', '## Pending', ...pipelineOffers.map(formatPipelineOffer), ''].join('\n');
  const historyText = `${SCAN_HISTORY_COLUMNS.join('\t')}\n${formatScanHistoryRow(uncertain, '2026-10-13', 'verification_uncertain')}\n`;
  const seenOnNextScan = collectSeenUrls({ scanHistoryText: historyText, pipelineText });
  assert.equal(seenOnNextScan.seen.has('https://boards.greenhouse.io/b/jobs/2'), false);
});

test('uncertain liveness is written with a non-pinning history status', () => {
  const root = workspace('tracked_companies: []\njob_boards: []\n');
  try {
    const scanUrl = new URL('../scan.mjs', import.meta.url).href;
    const script = [
      `import { appendToScanHistory } from ${JSON.stringify(scanUrl)};`,
      "const active = { url: 'https://boards.greenhouse.io/a/jobs/1', company: 'A', title: 'Engineer', source: 'greenhouse-api' };",
      "const uncertain = { url: 'https://boards.greenhouse.io/b/jobs/2', company: 'B', title: 'Engineer', source: 'greenhouse-api' };",
      "await appendToScanHistory([active, uncertain], '2026-10-13', 'added', { statusByOffer: new Map([[active, 'active'], [uncertain, 'uncertain']]) });"
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: {
        ...process.env,
        CAREER_OPS_ROOT: root,
        CAREER_OPS_PORTALS: join(root, 'portals.yml'),
        CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
        CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
        CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv')
      },
      encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(join(root, 'data', 'scan-history.tsv'), 'utf8').trimEnd().split('\n');
    assert.match(rows[1], /\tadded\t/);
    assert.match(rows[2], /\tverification_uncertain\t/);
    assert.equal(shouldDedupScanHistoryRow({ firstSeen: '2026-10-13', status: rows[2].split('\t')[5] }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('autonomous queue is durably merged before scan history marks postings seen', () => {
  const source = readFileSync(SCAN, 'utf8');
  const queueWrite = source.indexOf('await mergeAutonomousPendingJobs(AUTONOMOUS_QUEUE_PATH, pendingJobs)');
  const pipelineWrite = source.indexOf('await appendToPipeline(actionableOffers)');
  const historyWrite = source.indexOf("await appendToScanHistory(verifiedOffers, date, 'added', { statusByOffer: livenessStatusByOffer })");
  assert.ok(queueWrite >= 0 && pipelineWrite > queueWrite && historyWrite > pipelineWrite);
  assert.match(source, /actionableVerifiedOffers\(verifiedOffers, livenessStatusByOffer\)/);
  assert.match(source, /autonomousQueueMode && \(!args\.includes\('--verify'\) \|\| !jsonMode \|\| dryRun\)/);
});

test('a receipt larger than the pipe buffer drains completely', () => {
  const script = [
    `import { emitJsonReceipt } from ${JSON.stringify(new URL('../scan.mjs', import.meta.url).href)};`,
    "const added_urls = Array.from({ length: 20000 }, (_, i) => `https://example.invalid/very/long/job/posting/path/number/${i}`);",
    "emitJsonReceipt({ version: 'careerops.scan.receipt@1', added_urls }, 0);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.added_urls.length, 20000);
  assert.ok(Buffer.byteLength(result.stdout) > 65536);
});
