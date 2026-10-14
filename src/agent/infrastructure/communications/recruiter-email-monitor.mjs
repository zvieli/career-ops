import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { classifyReply, extractDomain, matchCandidates } from '../../../../reply-matcher.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function readReceipts(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const receipts = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    try { receipts.push(JSON.parse(lines[index])); }
    catch { throw new Error(`Recruiter email receipt store is corrupt at line ${index + 1}; refusing to continue.`); }
  }
  return receipts;
}

function appendReceipt(filePath, receipt) {
  const fd = openSync(filePath, 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(receipt)}\n`, null, 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function validReceivedAt(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , zoneHourText, zoneMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const zoneHour = Number(zoneHourText || 0);
  const zoneMinute = Number(zoneMinuteText || 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || !daysInMonth || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
  const date = new Date(value.trim());
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const POST_APPLICATION_STATES = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer']);

export function validateInterviewContext({ classification, match, application, receivedAt }) {
  if (classification !== 'Interview') return { status: 'NOT_AN_INTERVIEW_INVITE', reason: 'reply classification is not Interview' };
  if (!match || match.confidence !== 'high') return { status: 'NEEDS_REVIEW', reason: 'interview invite lacks a unique high-confidence application match' };
  if (!application || !POST_APPLICATION_STATES.has(String(application.status || '').replace(/\*/g, '').trim())) {
    return { status: 'NEEDS_REVIEW', reason: 'application is not in a post-application lifecycle state' };
  }
  if (!validReceivedAt(receivedAt)) return { status: 'NEEDS_REVIEW', reason: 'received timestamp is missing or invalid' };
  return { status: 'VALID' };
}

/**
 * Ingest normalized messages from an already-authorized mailbox adapter.
 * This function never fetches mail, sends mail, or changes tracker state.
 * Message bodies are used transiently for matching/classification and are not persisted.
 */
export async function ingestRecruiterEmails({
  messages,
  applications,
  followups = [],
  ledger,
  dataRoot = getCareerOpsRoot(),
  receiptPath
} = {}) {
  if (!Array.isArray(messages) || !Array.isArray(applications)) throw new Error('messages and applications must be arrays.');
  if (!ledger || typeof ledger.recordEvent !== 'function') throw new Error('Recruiter email ingestion requires an ApplicationLedger-compatible object.');
  const filePath = resolve(receiptPath || join(dataRoot, 'data', 'recruiter-email-receipts.jsonl'));
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const results = [];

  for (const message of messages) {
    const accountId = String(message?.accountId || '').trim();
    const messageId = String(message?.messageId || '').trim();
    if (!accountId || !messageId) throw new Error('Authorized mailbox messages require accountId and messageId.');
    const sourceKey = hash(`${accountId}\0${messageId}`);
    const result = await withPipelineLock(filePath, async () => {
      const previous = readReceipts(filePath).find(receipt => receipt.source_key_hash === sourceKey);
      if (previous) return { status: 'DUPLICATE', application_id: previous.application_id || null, event_id: previous.event_id || null };

      const candidate = {
        message_id: sourceKey,
        from: String(message.from || ''),
        subject: String(message.subject || ''),
        body_snippet: String(message.body || '').slice(0, 20_000)
      };
      const matches = matchCandidates([candidate], applications, followups);
      const match = matches[0];
      const classification = classifyReply(candidate);
      let application = null;
      if (match?.application_num !== undefined) {
        application = applications.find(app => String(app.num) === String(match.application_num)) || null;
      }
      const isInterviewInvite = classification.type === 'Interview'
        || (classification.type === 'Need Action' && classification.suggestedTrackerUpdate === 'Interview');
      const interviewContext = isInterviewInvite
        ? validateInterviewContext({ classification: 'Interview', match, application, receivedAt: message.receivedAt })
        : null;
      const receivedAt = validReceivedAt(message.receivedAt);
      const uniquelyCorrelated = Boolean(application?.application_id && match?.confidence === 'high');
      const accepted = classification.type !== 'Noise' && Boolean(receivedAt) && uniquelyCorrelated
        && (!isInterviewInvite || interviewContext.status === 'VALID');
      let event = null;

      if (accepted) {
        const eventType = isInterviewInvite ? 'INTERVIEW_INVITE_RECEIVED' : 'RECRUITER_MESSAGE_RECEIVED';
        event = await ledger.recordEvent({
          applicationId: application.application_id,
          type: eventType,
          producer: 'authorized-email-monitor',
          idempotencyKey: `mail:${sourceKey}`,
          occurredAt: receivedAt,
          payload: {
            source_account_hash: hash(accountId),
            source_message_hash: hash(messageId),
            received_at: receivedAt,
            sender_domain: extractDomain(candidate.from),
            subject_hash: hash(candidate.subject),
            classification: classification.type,
            evidence: classification.evidence.slice(0, 10),
            tracker_row: String(application.num),
            company: application.company,
            role: application.role,
            suggested_state: classification.suggestedTrackerUpdate,
            interview_context_validated: isInterviewInvite ? true : undefined
          }
        });
      }

      const status = classification.type === 'Noise' ? 'IGNORED_NOISE' : accepted ? 'RECORDED' : 'NEEDS_REVIEW';
      const receipt = {
        schema_version: 1,
        source_key_hash: sourceKey,
        application_id: accepted ? application.application_id : null,
        event_id: event?.event_id || null,
        classification: classification.type,
        status,
        reason: status === 'NEEDS_REVIEW'
          ? (interviewContext?.reason || (!receivedAt ? 'received timestamp is missing or invalid' : 'unique high-confidence application match unavailable'))
          : undefined,
        received_at: receivedAt,
        recorded_at: new Date().toISOString()
      };
      appendReceipt(filePath, receipt);
      return { status, application_id: receipt.application_id, event_id: receipt.event_id, reason: receipt.reason };
    });
    results.push(result);
  }
  return results;
}
