import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationIdentity, resolveApplicationIdentity } from '../../../lib/application-identity.mjs';

test('SAME_JOB_RERUN_SAME_ID', () => {
  const job = { provider: 'greenhouse', company: 'Acme', requisitionId: 'REQ-12', title: 'Engineer', url: 'https://boards.greenhouse.io/acme/jobs/12' };
  assert.equal(createApplicationIdentity(job).application_id, createApplicationIdentity(job).application_id);
});

test('SAME_JOB_DIFFERENT_SOURCE_SAME_ID_WHEN_CANONICAL_ID_MATCHES', () => {
  const base = { company: 'Acme, Inc.', requisitionId: 'Req-12', title: 'Engineer' };
  const a = createApplicationIdentity({ ...base, provider: 'greenhouse' });
  const b = createApplicationIdentity({ ...base, provider: 'linkedin' });
  assert.equal(a.application_id, b.application_id);
});

test('DIFFERENT_REQ_SAME_TITLE_DIFFERENT_ID', () => {
  const base = { company: 'Acme', title: 'Engineer' };
  assert.notEqual(
    createApplicationIdentity({ ...base, requisitionId: 'REQ-12' }).application_id,
    createApplicationIdentity({ ...base, requisitionId: 'REQ-13' }).application_id
  );
});

test('DIFFERENT_COMPANY_SAME_TITLE_DIFFERENT_ID', () => {
  const base = { title: 'Engineer', requisitionId: 'REQ-12' };
  assert.notEqual(
    createApplicationIdentity({ ...base, company: 'Acme' }).application_id,
    createApplicationIdentity({ ...base, company: 'Beta' }).application_id
  );
});

test('cross-source URL alias reconciles a requisition ID with an ATS external ID', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-identity-'));
  try {
    const url = 'https://boards.greenhouse.io/acme/jobs/123';
    const sourceA = resolveApplicationIdentity({ company: 'Acme', provider: 'greenhouse-api', requisitionId: 'REQ-123', externalId: '123', url }, { dataRoot });
    const sourceB = resolveApplicationIdentity({ company: 'Acme', provider: 'ats-import', externalId: '123', url }, { dataRoot });
    assert.equal(sourceA.application_id, sourceB.application_id);
    assert.equal(sourceB.identity_basis, 'reconciled_alias');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('identity registry refuses conflicting requisitions on one URL', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-identity-'));
  try {
    const url = 'https://boards.greenhouse.io/acme/jobs/123';
    resolveApplicationIdentity({ company: 'Acme', requisitionId: 'REQ-123', url }, { dataRoot });
    assert.throws(() => resolveApplicationIdentity({ company: 'Acme', requisitionId: 'REQ-999', url }, { dataRoot }), /identity conflict/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('AMBIGUOUS_FINGERPRINT_NO_FALSE_MERGE', () => {
  const job = { company: 'Acme', title: 'Engineer', location: 'Tel Aviv' };
  const a = createApplicationIdentity(job);
  const b = createApplicationIdentity(job);
  assert.notEqual(a.application_id, b.application_id);
  assert.equal(a.mergeable, false);
  assert.equal(a.identity_basis, 'ambiguous');
});
