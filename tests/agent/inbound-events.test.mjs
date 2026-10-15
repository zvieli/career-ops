import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmManualSubmission, ingestInboundEvents, UserFactStore } from '../../src/agent/infrastructure/persistence/inbound-events.mjs';
import { HumanReviewTaskStore } from '../../src/agent/infrastructure/persistence/human-review-task-store.mjs';

const app = { application_id: 'app-0123456789abcdef01234567', provider: 'fixture', company: 'Acme', role: 'Engineer', provider_application_id: 'p-1' };
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'inbound-test-')); return { root, path: join(root, 'events.jsonl'), cleanup: () => rmSync(root, { recursive: true, force: true }) }; };

test('inbound events exact-match only; unmatched is explicit and interview asks injected high-priority review', async () => {
  const f = fixture(); const calls = [], reviews = [];
  try {
    const out = await ingestInboundEvents({ storePath: f.path, dataRoot: f.root, applications: [app], emitEvent: async e => { calls.push(e); return { event_id: 'evt' }; }, emitUnmatchedEvent: async e => { calls.push(e); return { event_id: 'unmatched' }; }, requestHighPriorityReview: async r => reviews.push(r), events: [
      { kind: 'interview_invite', provider: 'fixture', sourceId: 'mail-1', providerApplicationId: 'p-1' },
      { kind: 'recruiter_message', provider: 'fixture', sourceId: 'mail-2', company: 'Acme', role: 'Engineer X' }
    ] });
    assert.equal(out[0].application_id, app.application_id); assert.equal(out[1].type, 'UNMATCHED_INBOUND_EVENT');
    assert.equal(reviews.length, 1); assert.equal(reviews[0].applicationId, app.application_id); assert.equal(reviews[0].eventId, 'evt'); assert.equal(reviews[0].priority, 100); assert.match(reviews[0].reviewTaskId, /^rev-/);
    assert.equal(calls.length, 2); assert.doesNotMatch(readFileSync(f.path, 'utf8'), /mail-1|mail-2/);
    assert.equal(new HumanReviewTaskStore({ dataRoot: f.root }).list({ applicationId: app.application_id }).filter(task => task.review_type === 'INTERVIEW_INVITE_RECEIVED').length, 1);
  } finally { f.cleanup(); }
});

test('inbound events reject contradictory identifiers and never fall through from an unknown authoritative ID', async () => {
  const f = fixture(); const appB = { ...app, application_id: 'app-aaaaaaaaaaaaaaaaaaaaaaaa', provider_application_id: 'p-2', thread_id: 'thread-b' }; let matched = 0; const unmatched = [];
  try {
    const result = await ingestInboundEvents({ storePath: f.path, dataRoot: f.root, applications: [app, appB], emitEvent: async () => { matched++; return { event_id: 'bad' }; }, emitUnmatchedEvent: async event => { unmatched.push(event); }, events: [
      { kind: 'recruiter_message', provider: 'fixture', sourceId: 'conflict', providerApplicationId: 'p-1', threadId: 'thread-b' },
      { kind: 'recruiter_message', provider: 'fixture', sourceId: 'unknown', providerApplicationId: 'missing', company: 'Acme', role: 'Engineer' },
      { kind: 'recruiter_message', provider: 'fixture', sourceId: 'ambiguous', company: 'Acme', role: 'Engineer' }
    ] });
    assert.equal(matched, 0); assert.equal(unmatched.length, 3); assert.ok(result.every(item => item.type === 'UNMATCHED_INBOUND_EVENT'));
  } finally { f.cleanup(); }
});

test('user facts require explicit value/provenance; concurrent identical provision is idempotent and conflict rejected', async () => {
  const f = fixture(); const store = new UserFactStore({ filePath: f.path, dataRoot: f.root });
  try {
    const request = await store.request({ applicationId: app.application_id, field: 'work_authorization', prompt: 'Provide status', sensitive: true, currentState: 'READY_FOR_HUMAN', currentVersion: 4, evidenceHash: 'a'.repeat(64) });
    const results = await Promise.all([store.provide({ requestId: request.request_id, value: 'Citizen', currentState: 'READY_FOR_HUMAN', currentVersion: 4 }), store.provide({ requestId: request.request_id, value: 'Citizen', currentState: 'READY_FOR_HUMAN', currentVersion: 4 })]);
    assert.ok(results.every(row => row.provenance === 'HUMAN_EXPLICIT' && row.sensitive));
    await assert.rejects(store.provide({ requestId: request.request_id, value: 'Unknown', currentState: 'READY_FOR_HUMAN', currentVersion: 4 }), /Conflicting/);
    assert.equal(store.reviewTaskStore.get(request.review_task_id).status, 'DECIDED');
    assert.match(readFileSync(f.path, 'utf8'), /Citizen/);
  } finally { f.cleanup(); }
});

test('fact-supply receipt binds value across a crash between decision and private persistence', async () => {
  const f = fixture(); let crash = true;
  const store = new UserFactStore({ filePath: f.path, dataRoot: f.root, onBoundary: async boundary => { if (boundary === 'fact-decision-persisted' && crash) { crash = false; throw new Error('simulated crash'); } } });
  try {
    const request = await store.request({ applicationId: app.application_id, field: 'work_authorization', prompt: 'Provide status', currentState: 'READY_FOR_HUMAN', currentVersion: 4, evidenceHash: 'b'.repeat(64) });
    const args = { requestId: request.request_id, currentState: 'READY_FOR_HUMAN', currentVersion: 4 };
    await assert.rejects(store.provide({ ...args, value: 'Citizen' }), /simulated crash/);
    await assert.rejects(store.provide({ ...args, value: 'Permanent Resident' }), /replay bindings conflict/);
    const recovered = await store.provide({ ...args, value: 'Citizen' });
    assert.equal(recovered.value, 'Citizen');
    assert.equal(store.reviewTaskStore.getDecisionReceipt(request.review_task_id).decision_value_hash.length, 64);
  } finally { f.cleanup(); }
});

test('manual submission confirmation emits only explicit assertion, is idempotent and rejects conflicting app', async () => {
  const f = fixture(); const calls = [];
  try {
    const args = { applicationId: app.application_id, confirmationId: 'click-confirm-1', assertedBy: 'local-human', storePath: f.path, applicationExists: () => true, emitEvent: async e => { calls.push(e); return { event_id: 'evt-confirm' }; } };
    const [a, b] = await Promise.all([confirmManualSubmission(args), confirmManualSubmission(args)]);
    assert.equal(calls.length, 1); assert.ok(b.duplicate); assert.equal(a.event_id, 'evt-confirm');
    assert.equal(calls[0].type, 'APPLICATION_SUBMITTED_CONFIRMED'); assert.equal(calls[0].payload.assertion, 'HUMAN_EXPLICIT');
    await assert.rejects(confirmManualSubmission({ ...args, applicationId: 'app-aaaaaaaaaaaaaaaaaaaaaaaa' }), /Conflicting/);
  } finally { f.cleanup(); }
});
