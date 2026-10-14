import { ingestRecruiterEmails } from './recruiter-email-monitor.mjs';

export function assertRecruiterMailboxAdapter(adapter) {
  for (const method of ['listMessagesSince', 'getNormalizedMessage', 'persistCursor']) {
    if (typeof adapter?.[method] !== 'function') throw new Error(`Mailbox adapter is missing required method: ${method}.`);
  }
  return adapter;
}

/**
 * Ingest one provider-neutral mailbox page. Cursor persistence happens only
 * after every normalized message has a durable ingestion receipt. Replaying a
 * page after a crash is safe because the email monitor deduplicates message IDs.
 */
export async function ingestMailboxPage({
  adapter,
  cursor,
  applications,
  followups = [],
  ledger,
  dataRoot,
  receiptPath
} = {}) {
  assertRecruiterMailboxAdapter(adapter);
  if (cursor !== null && cursor !== undefined && typeof cursor !== 'string') throw new Error('Mailbox cursor must be an opaque string or null.');
  const page = await adapter.listMessagesSince(cursor ?? null);
  if (!page || !Array.isArray(page.messages) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
    throw new Error('Mailbox adapter must return { messages: [{ messageId }], nextCursor }.');
  }

  const normalized = [];
  for (const item of page.messages) {
    const messageId = String(item?.messageId || '').trim();
    if (!messageId) throw new Error('Mailbox message listing contains an empty messageId.');
    const message = await adapter.getNormalizedMessage(messageId);
    if (!message || String(message.messageId || '').trim() !== messageId
      || typeof message.accountId !== 'string' || !message.accountId.trim()) {
      throw new Error('Mailbox adapter returned a message without matching normalized account/message identity.');
    }
    normalized.push({
      accountId: message.accountId,
      messageId,
      from: typeof message.from === 'string' ? message.from : '',
      subject: typeof message.subject === 'string' ? message.subject : '',
      body: typeof message.body === 'string' ? message.body : '',
      receivedAt: message.receivedAt
    });
  }

  const results = await ingestRecruiterEmails({ messages: normalized, applications, followups, ledger, dataRoot, receiptPath });
  await adapter.persistCursor(page.nextCursor);
  return {
    messages_seen: normalized.length,
    statuses: results.map((result) => result.status),
    cursor_persisted: true
  };
}
