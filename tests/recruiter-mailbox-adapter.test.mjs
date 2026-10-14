// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationLedger } from '../lib/application-ledger.mjs';
import { assertRecruiterMailboxAdapter, ingestMailboxPage } from '../lib/recruiter-mailbox-adapter.mjs';

const APP_ID = 'app-0123456789abcdef01234567';
const applications = [{ application_id: APP_ID, num: '42', company: 'Example Corp', role: 'Backend Engineer', status: 'Applied', date: '2026-10-01' }];

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-mailbox-contract-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('provider-neutral mailbox adapter contract requires only list, normalize, and cursor operations', () => {
  assert.throws(() => assertRecruiterMailboxAdapter({}), /listMessagesSince/);
  const adapter = { listMessagesSince() {}, getNormalizedMessage() {}, persistCursor() {} };
  assert.equal(assertRecruiterMailboxAdapter(adapter), adapter);
});

test('mailbox cursor persists only after durable evidence-only ingestion receipts; replay is deduplicated', async () => {
  await withTempRoot(async (root) => {
    const ledger = new ApplicationLedger({ dataRoot: root });
    const receiptPath = join(root, 'data', 'recruiter-email-receipts.jsonl');
    const cursorWrites = [];
    const adapter = {
      async listMessagesSince(cursor) {
        assert.equal(cursor, 'cursor-before');
        return { messages: [{ messageId: 'message-1' }], nextCursor: 'cursor-after' };
      },
      async getNormalizedMessage(messageId) {
        return {
          accountId: 'fixture-account', messageId,
          from: 'recruiter@example.com', subject: 'Interview invitation: Backend Engineer',
          body: 'Interview invitation for Backend Engineer at Example Corp. BODY_MUST_NOT_PERSIST',
          receivedAt: '2026-10-12T10:00:00.000Z'
        };
      },
      async persistCursor(cursor) {
        assert.equal(readFileSync(receiptPath, 'utf8').includes('message-1'), false);
        assert.equal(ledger.timeline(APP_ID).length, 1);
        cursorWrites.push(cursor);
      }
    };
    const first = await ingestMailboxPage({ adapter, cursor: 'cursor-before', applications, ledger, dataRoot: root, receiptPath });
    assert.deepEqual(first, { messages_seen: 1, statuses: ['RECORDED'], cursor_persisted: true });
    const second = await ingestMailboxPage({ adapter, cursor: 'cursor-before', applications, ledger, dataRoot: root, receiptPath });
    assert.deepEqual(second.statuses, ['DUPLICATE']);
    assert.deepEqual(cursorWrites, ['cursor-after', 'cursor-after']);
    assert.equal(ledger.timeline(APP_ID).length, 1);
    const persisted = readFileSync(receiptPath, 'utf8');
    assert.doesNotMatch(persisted, /BODY_MUST_NOT_PERSIST|recruiter@example\.com|Interview invitation/);
  });
});

test('mailbox cursor is not advanced when a page cannot be normalized or ingested', async () => {
  await withTempRoot(async (root) => {
    const ledger = new ApplicationLedger({ dataRoot: root });
    let cursorWrites = 0;
    const adapter = {
      async listMessagesSince() { return { messages: [{ messageId: 'first' }, { messageId: 'second' }], nextCursor: 'next' }; },
      async getNormalizedMessage(messageId) {
        if (messageId === 'second') throw new Error('fixture normalization interrupted');
        return { accountId: 'account', messageId, from: 'x@example.com', subject: 'x', body: 'x', receivedAt: 'not-a-date' };
      },
      async persistCursor() { cursorWrites++; }
    };
    await assert.rejects(ingestMailboxPage({ adapter, cursor: null, applications, ledger, dataRoot: root }), /fixture normalization interrupted/);
    assert.equal(cursorWrites, 0);
  });
});
