import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { withPipelineLock } from '../pipeline-lock.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { assertApplicationId } from './application-ledger.mjs';

const NOTIFIABLE_EVENTS = new Set([
  'FIT_REASONABLE', 'CV_GENERATED', 'APPLICATION_PREPARED', 'FORM_PREFILLED',
  'APPLICATION_SUBMITTED_CONFIRMED', 'RECRUITER_MESSAGE_RECEIVED', 'INTERVIEW_INVITE_RECEIVED'
]);

function readOutbox(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    try { records.push(JSON.parse(lines[index])); }
    catch { throw new Error(`Notification outbox is corrupt at line ${index + 1}; refusing to append.`); }
  }
  return records;
}

function appendOutbox(filePath, record) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const fd = openSync(filePath, 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function safeText(event) {
  const clean = value => String(value || '').replace(/[\r\n\t\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, 120);
  const company = clean(event.payload?.company);
  const role = clean(event.payload?.role);
  const labels = {
    FIT_REASONABLE: 'Candidate-fit review completed',
    CV_GENERATED: 'CV generated',
    APPLICATION_PREPARED: 'Application package prepared',
    FORM_PREFILLED: 'Application form prefilled; submission was not performed',
    APPLICATION_SUBMITTED_CONFIRMED: 'Application submission confirmed',
    RECRUITER_MESSAGE_RECEIVED: 'Recruiter message received',
    INTERVIEW_INVITE_RECEIVED: 'Interview invitation received'
  };
  return [
    `Career Ops: ${labels[event.type] || 'Application update'}`,
    company ? `Company: ${company}` : '',
    role ? `Role: ${role}` : '',
    `Application: ${event.application_id}`
  ].filter(Boolean).join('\n').slice(0, 1000);
}

function readTelegramSecrets(secretsFile = process.env.CAREER_OPS_SECRETS_FILE || join(homedir(), '.config', 'career-ops', 'secrets.env')) {
  if (!existsSync(secretsFile)) return { file_present: false, token: '', chat_id: '' };
  let source;
  try { source = readFileSync(secretsFile, 'utf8'); }
  catch { return { file_present: true, unreadable: true, token: '', chat_id: '' }; }
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(CAREER_OPS_TELEGRAM_BOT_TOKEN|CAREER_OPS_TELEGRAM_CHAT_ID)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value.trim();
  }
  return { file_present: true, token: values.CAREER_OPS_TELEGRAM_BOT_TOKEN || '', chat_id: values.CAREER_OPS_TELEGRAM_CHAT_ID || '' };
}

/** Report credential presence only; never returns or logs secret values. */
export function inspectTelegramSecretsEnv({ secretsFile = process.env.CAREER_OPS_SECRETS_FILE || join(homedir(), '.config', 'career-ops', 'secrets.env') } = {}) {
  const config = readTelegramSecrets(secretsFile);
  const token_configured = Boolean(process.env.CAREER_OPS_TELEGRAM_BOT_TOKEN || config.token);
  const chat_id_configured = Boolean(process.env.CAREER_OPS_TELEGRAM_CHAT_ID || config.chat_id);
  const configured = token_configured && chat_id_configured;
  return { file_present: config.file_present, file_readable: config.unreadable !== true, token_configured, chat_id_configured, status: configured ? 'CONFIGURED' : 'BLOCKED_BY_CONFIGURATION' };
}

export function createTelegramAdapter(options = {}) {
  const secrets = readTelegramSecrets(options.secretsFile);
  const token = options.token ?? process.env.CAREER_OPS_TELEGRAM_BOT_TOKEN ?? secrets.token;
  const chatId = options.chatId ?? process.env.CAREER_OPS_TELEGRAM_CHAT_ID ?? secrets.chat_id;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const botToken = String(token || '').trim();
  const destination = String(chatId || '').trim();
  return {
    id: 'telegram',
    isConfigured: () => Boolean(botToken && destination),
    async send(event) {
      if (!botToken || !destination) return { status: 'BLOCKED_BY_CONFIGURATION' };
      if (typeof fetchImpl !== 'function') return { status: 'FAILED', error: 'FETCH_UNAVAILABLE' };
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: destination, text: safeText(event), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) return { status: 'FAILED', error: `HTTP_${response.status}` };
        const result = await response.json();
        if (result?.ok !== true) return { status: 'FAILED', error: 'TELEGRAM_REJECTED' };
        return { status: 'DELIVERED', external_id: result.result?.message_id === undefined ? undefined : String(result.result.message_id) };
      } catch {
        // Fetch errors can contain the bot-token URL; never persist or print them.
        return { status: 'DELIVERY_UNCONFIRMED', error: 'NETWORK_ERROR' };
      }
    }
  };
}

export class NotificationRouter {
  constructor({ dataRoot, adapters = [], outboxPath, clock = () => new Date() } = {}) {
    if (!Array.isArray(adapters)) throw new Error('Notification adapters must be an array.');
    this.dataRoot = resolve(dataRoot || getCareerOpsRoot());
    this.outboxPath = resolve(outboxPath || join(this.dataRoot, 'data', 'notifications', 'outbox.jsonl'));
    this.adapters = adapters;
    this.clock = clock;
  }

  async dispatchPending(eventStore) {
    if (!eventStore || typeof eventStore.list !== 'function') throw new Error('dispatchPending requires an ApplicationEventStore-compatible source.');
    const results = [];
    for (const event of eventStore.list()) results.push(...await this.route(event));
    return results;
  }

  async route(event) {
    if (!event || typeof event.event_id !== 'string' || !NOTIFIABLE_EVENTS.has(event.type)) return [];
    assertApplicationId(event.application_id);
    const results = [];
    for (const adapter of this.adapters) {
      if (!adapter || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(adapter.id || '') || typeof adapter.send !== 'function') {
        throw new Error('Notification adapter must have a safe id and send(event) method.');
      }
      const notificationId = `ntf-${createHash('sha256').update(`${event.event_id}\0${adapter.id}`).digest('hex').slice(0, 32)}`;
      mkdirSync(dirname(this.outboxPath), { recursive: true, mode: 0o700 });
      const previous = await withPipelineLock(this.outboxPath, () => {
        const records = readOutbox(this.outboxPath);
        const latest = [...records].reverse().find(record => record.notification_id === notificationId);
        if (latest?.status === 'DELIVERED') return { record: latest, duplicate: true };
        if (latest?.status === 'ATTEMPT_STARTED' || latest?.status === 'DELIVERY_UNCONFIRMED') return { record: latest, uncertain: true };
        if (latest?.status === 'FAILED') return { record: latest, duplicate: true };
        let configured = false;
        try { configured = adapter.isConfigured ? adapter.isConfigured() === true : true; }
        catch { configured = false; }
        if (!configured && latest?.status === 'BLOCKED_BY_CONFIGURATION') return { record: latest, blocked: true, duplicate: true };
        if (!configured) {
          const blocked = { schema_version: 1, notification_id: notificationId, event_id: event.event_id,
            application_id: event.application_id, channel: adapter.id, status: 'BLOCKED_BY_CONFIGURATION',
            attempt: latest?.attempt || 0, recorded_at: this.clock().toISOString() };
          appendOutbox(this.outboxPath, blocked);
          return { record: blocked, blocked: true };
        }
        const started = { schema_version: 1, notification_id: notificationId, event_id: event.event_id,
          application_id: event.application_id, channel: adapter.id, status: 'ATTEMPT_STARTED',
          attempt: (latest?.attempt || 0) + 1, recorded_at: this.clock().toISOString() };
        appendOutbox(this.outboxPath, started);
        return { record: started, started: true };
      });
      if (!previous.started) {
        results.push({ channel: adapter.id, status: previous.blocked ? 'BLOCKED_BY_CONFIGURATION' : previous.uncertain ? 'DELIVERY_UNCONFIRMED' : previous.record.status, duplicate: previous.duplicate === true || previous.uncertain === true });
        continue;
      }

      let delivery;
      try { delivery = await adapter.send({ ...event, notification_text: safeText(event) }); }
      catch { delivery = { status: 'DELIVERY_UNCONFIRMED', error: 'ADAPTER_EXCEPTION' }; }
      const allowedStatuses = new Set(['DELIVERED', 'FAILED', 'DELIVERY_UNCONFIRMED', 'BLOCKED_BY_CONFIGURATION']);
      const status = allowedStatuses.has(delivery?.status) ? delivery.status : 'FAILED';
      const receipt = { schema_version: 1, notification_id: notificationId, event_id: event.event_id,
        application_id: event.application_id, channel: adapter.id, status, attempt: previous.record.attempt,
        error: typeof delivery?.error === 'string' && /^[A-Z0-9_:-]{1,80}$/i.test(delivery.error) ? delivery.error : (delivery?.error ? 'ADAPTER_ERROR' : undefined),
        external_id: typeof delivery?.external_id === 'string' ? delivery.external_id.slice(0, 80) : undefined,
        recorded_at: this.clock().toISOString() };
      await withPipelineLock(this.outboxPath, () => appendOutbox(this.outboxPath, receipt));
      results.push({ channel: adapter.id, status, duplicate: false });
    }
    return results;
  }
}
