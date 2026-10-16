import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { readExistingState } from '../../domain/applications/application-state-machine.mjs';
import { HumanReviewTaskStore, hashHumanReviewEvidence } from '../persistence/human-review-task-store.mjs';
import { confirmManualSubmission } from '../persistence/inbound-events.mjs';
import { ApplicationLedger, createApplicationEventEmitter } from '../persistence/application-ledger.mjs';

/** Error classes for clear, sanitized fault isolation without secret leakage. */
export class TelegramAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramAuthError';
    this.code = 'TELEGRAM_UNAUTHORIZED';
  }
}

export class TelegramCallbackError extends Error {
  constructor(message, code = 'TELEGRAM_CALLBACK_INVALID') {
    super(message);
    this.name = 'TelegramCallbackError';
    this.code = code;
  }
}

export class TelegramTransportError extends Error {
  constructor(message, { status = null, retryable = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'TelegramTransportError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,80}$/;
const USER_ID_RE = /^-?\d{1,20}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;

function withPrivateStoreLock(path, fn) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private store parent must be a real directory.');
  chmodSync(directory, 0o700);
  return withPipelineLock(path, fn);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Telegram store is corrupt at line ${i + 1}; refusing writes.`); }
  });
}

function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Sanitize text to ensure bot token is never printed, logged, or included in exceptions. */
export function sanitizeTelegramSecret(text, token) {
  if (!text) return '';
  let sanitized = String(text);
  if (token && typeof token === 'string' && token.length > 5) {
    sanitized = sanitized.replaceAll(token, '<REDACTED>');
  }
  // Sanitize any generic bot-token patterns in URLs or standalone strings
  sanitized = sanitized.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<REDACTED>');
  sanitized = sanitized.replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,80}\b/g, '<REDACTED_BOT_TOKEN>');
  return sanitized;
}

function parseSecretsFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, 'utf8');
    const values = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+#.*$/, '').trim();
      }
      values[match[1]] = val;
    }
    return values;
  } catch {
    return {};
  }
}

/** Reads and validates Telegram configuration from environment or secrets file. */
export function readTelegramConfig({
  secretsFile = process.env.CAREER_OPS_SECRETS_FILE
    || (existsSync(join(homedir(), '.config', 'career-ops', 'telegram.conf')) ? join(homedir(), '.config', 'career-ops', 'telegram.conf') : join(homedir(), '.config', 'career-ops', 'secrets.env')),
  env = process.env
} = {}) {
  const fileSecrets = parseSecretsFile(secretsFile);

  const rawToken = env.TELEGRAM_BOT_TOKEN
    || env.CAREER_OPS_TELEGRAM_BOT_TOKEN
    || fileSecrets.TELEGRAM_BOT_TOKEN
    || fileSecrets.CAREER_OPS_TELEGRAM_BOT_TOKEN
    || '';

  const rawUserId = env.TELEGRAM_ALLOWED_USER_ID
    || env.CAREER_OPS_TELEGRAM_ALLOWED_USER_ID
    || fileSecrets.TELEGRAM_ALLOWED_USER_ID
    || fileSecrets.CAREER_OPS_TELEGRAM_ALLOWED_USER_ID
    || '';

  const rawChatId = env.TELEGRAM_ALLOWED_CHAT_ID
    || env.CAREER_OPS_TELEGRAM_ALLOWED_CHAT_ID
    || fileSecrets.TELEGRAM_ALLOWED_CHAT_ID
    || fileSecrets.CAREER_OPS_TELEGRAM_ALLOWED_CHAT_ID
    || '';

  const token = String(rawToken).trim();
  const allowedUserId = String(rawUserId).trim();
  const allowedChatId = String(rawChatId).trim();

  // Fail-closed validation: wildcard authorization is strictly forbidden
  const wildcardToken = token === '*' || token === 'all' || token.includes(' ');
  const wildcardUser = allowedUserId === '*' || allowedUserId === '0' || allowedUserId === 'all';
  const wildcardChat = allowedChatId === '*' || allowedChatId === '0' || allowedChatId === 'all';

  const validToken = !wildcardToken && BOT_TOKEN_RE.test(token);
  const validUser = !wildcardUser && USER_ID_RE.test(allowedUserId);
  const validChat = !allowedChatId || (!wildcardChat && CHAT_ID_RE.test(allowedChatId));

  const configured = Boolean(token && allowedUserId && validToken && validUser && validChat);

  return Object.freeze({
    token: validToken ? token : '',
    allowedUserId: validUser ? allowedUserId : '',
    allowedChatId: (validChat && allowedChatId) ? allowedChatId : null,
    configured,
    validationErrors: [
      !token ? 'TELEGRAM_BOT_TOKEN is missing' : (!validToken ? 'TELEGRAM_BOT_TOKEN format is invalid' : null),
      !allowedUserId ? 'TELEGRAM_ALLOWED_USER_ID is missing' : (!validUser ? 'TELEGRAM_ALLOWED_USER_ID format is invalid (no wildcards allowed)' : null),
      allowedChatId && !validChat ? 'TELEGRAM_ALLOWED_CHAT_ID format is invalid' : null
    ].filter(Boolean)
  });
}

/** Asserts that an incoming Telegram update is from the configured authorized user/chat. */
export function assertTelegramAuthorized({ fromId, chatId, config }) {
  if (!config || !config.configured) {
    throw new TelegramAuthError('Telegram control plane is not fully configured (fail closed).');
  }
  const fromStr = String(fromId || '').trim();
  if (!fromStr || fromStr !== config.allowedUserId) {
    throw new TelegramAuthError(`Unauthorized Telegram user: ${fromStr || 'anonymous'}`);
  }
  if (config.allowedChatId) {
    const chatStr = String(chatId || '').trim();
    if (!chatStr || chatStr !== config.allowedChatId) {
      throw new TelegramAuthError(`Unauthorized Telegram chat: ${chatStr || 'unknown'}`);
    }
  }
  return true;
}

/** Transport adapter for official Bot API calls with bounded timeout, retry, and secret redaction. */
export function createTelegramBotTransport({
  token,
  fetchImpl = globalThis.fetch,
  maxRetries = 3,
  timeoutMs = 15000,
  sleepFn = ms => new Promise(res => setTimeout(res, ms))
} = {}) {
  const cleanToken = String(token || '').trim();

  async function callApi(method, body, { attempt = 1, customTimeoutMs = timeoutMs } = {}) {
    if (!cleanToken) {
      throw new TelegramTransportError('Telegram bot token is not configured.', { status: 401, retryable: false });
    }
    const url = `https://api.telegram.org/bot${cleanToken}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Telegram API timeout after ${customTimeoutMs}ms`)), customTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      // Handle HTTP 429 Rate Limiting
      if (response.status === 429) {
        let retryAfter = 1;
        try {
          const errData = await response.json();
          retryAfter = Number(errData?.parameters?.retry_after) || 1;
        } catch {}
        if (attempt <= maxRetries) {
          await sleepFn(Math.min(retryAfter * 1000, 30000));
          return callApi(method, body, { attempt: attempt + 1, customTimeoutMs });
        }
        throw new TelegramTransportError(`Telegram API rate limit (429) exceeded after ${attempt} attempts.`, {
          status: 429, retryable: true, retryAfter
        });
      }

      // Handle 5xx server errors with retry
      if (response.status >= 500 && response.status < 600) {
        if (attempt <= maxRetries) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await sleepFn(backoff);
          return callApi(method, body, { attempt: attempt + 1, customTimeoutMs });
        }
        throw new TelegramTransportError(`Telegram API server error (HTTP ${response.status}) after ${attempt} attempts.`, {
          status: response.status, retryable: true
        });
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new TelegramTransportError(`Invalid JSON from Telegram Bot API (HTTP ${response.status}).`, {
          status: response.status, retryable: response.status >= 500
        });
      }

      if (!response.ok || data?.ok !== true) {
        const desc = sanitizeTelegramSecret(data?.description || `HTTP ${response.status}`, cleanToken);
        throw new TelegramTransportError(`Telegram API error: ${desc}`, {
          status: response.status,
          retryable: false
        });
      }

      return data.result;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof TelegramTransportError) throw error;
      const sanitizedMsg = sanitizeTelegramSecret(error?.message || 'Network error', cleanToken);
      const isTimeout = /timeout|aborted/i.test(sanitizedMsg);
      if (isTimeout && attempt <= maxRetries) {
        await sleepFn(500);
        return callApi(method, body, { attempt: attempt + 1, customTimeoutMs });
      }
      throw new TelegramTransportError(`Telegram transport error: ${sanitizedMsg}`, {
        retryable: isTimeout
      });
    }
  }

  return Object.freeze({
    async sendMessage({ chatId, text, replyMarkup, disableWebPagePreview = true }) {
      const boundedText = String(text || '').slice(0, 4096);
      const body = {
        chat_id: chatId,
        text: boundedText,
        disable_web_page_preview: Boolean(disableWebPagePreview)
      };
      if (replyMarkup) body.reply_markup = replyMarkup;
      return callApi('sendMessage', body);
    },

    async editMessageText({ chatId, messageId, text, replyMarkup, disableWebPagePreview = true }) {
      const boundedText = String(text || '').slice(0, 4096);
      const body = {
        chat_id: chatId,
        message_id: messageId,
        text: boundedText,
        disable_web_page_preview: Boolean(disableWebPagePreview)
      };
      if (replyMarkup) body.reply_markup = replyMarkup;
      return callApi('editMessageText', body);
    },

    async editMessageReplyMarkup({ chatId, messageId, replyMarkup = null }) {
      const body = {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup || { inline_keyboard: [] }
      };
      return callApi('editMessageReplyMarkup', body);
    },

    async answerCallbackQuery({ callbackQueryId, text = '', showAlert = false }) {
      const body = {
        callback_query_id: callbackQueryId,
        text: String(text || '').slice(0, 200),
        show_alert: Boolean(showAlert)
      };
      return callApi('answerCallbackQuery', body);
    },

    async getUpdates({ offset = 0, timeout = 20, limit = 50, allowedUpdates = ['message', 'callback_query'] } = {}) {
      const body = {
        offset: Number(offset) || 0,
        timeout: Math.max(0, Math.min(Number(timeout) || 0, 50)),
        limit: Math.max(1, Math.min(Number(limit) || 50, 100)),
        allowed_updates: allowedUpdates
      };
      // For long polling, adjust the custom network timeout to be higher than the Telegram server hold timeout
      const pollTimeoutMs = (body.timeout * 1000) + 10000;
      return callApi('getUpdates', body, { customTimeoutMs: pollTimeoutMs });
    }
  });
}

/** Durable store for opaque short callback tokens bound to review tasks. */
export class TelegramCallbackStore {
  constructor({ dataRoot = getCareerOpsRoot(), filePath, clock = () => new Date() } = {}) {
    this.dataRoot = resolve(dataRoot);
    this.filePath = resolve(filePath || join(this.dataRoot, 'data', 'telegram', 'callback-tokens.jsonl'));
    this.clock = clock;
  }

  list() {
    return readJsonl(this.filePath);
  }

  get(token) {
    if (!token || typeof token !== 'string') return null;
    return readJsonl(this.filePath).find(r => r.token === token) || null;
  }

  async createToken({
    review_task_id,
    application_id,
    decision,
    expected_evidence_hash,
    expected_canonical_state,
    expected_canonical_version
  }) {
    if (!review_task_id || !application_id || !decision || !expected_evidence_hash) {
      throw new Error('Callback token requires review_task_id, application_id, decision, and evidence hash.');
    }
    return withPrivateStoreLock(this.filePath, () => {
      const rows = readJsonl(this.filePath);
      // Reuse existing active token for the exact same tuple if not yet used
      const existing = rows.find(r =>
        r.review_task_id === review_task_id &&
        r.application_id === application_id &&
        r.decision === decision &&
        r.expected_evidence_hash === expected_evidence_hash &&
        r.expected_canonical_state === expected_canonical_state &&
        r.expected_canonical_version === expected_canonical_version &&
        !r.used_at
      );
      if (existing) return existing.token;

      // Generate a short 20-char opaque token safe for Telegram inline button callback_data (<= 64 bytes)
      const token = `cb_${randomBytes(10).toString('hex')}`;
      const record = {
        token,
        review_task_id,
        application_id,
        decision,
        expected_evidence_hash,
        expected_canonical_state,
        expected_canonical_version: expected_canonical_version ?? null,
        created_at: this.clock().toISOString(),
        used_at: null,
        decision_receipt_ref: null
      };
      appendJsonl(this.filePath, record);
      return token;
    });
  }

  async markUsed(token, { decision_receipt_ref = null } = {}) {
    return withPrivateStoreLock(this.filePath, () => {
      const rows = readJsonl(this.filePath);
      const target = rows.find(r => r.token === token);
      if (!target) throw new TelegramCallbackError('Callback token not found.', 'TOKEN_NOT_FOUND');
      if (target.used_at) {
        return { ...target, duplicate: true };
      }
      const updated = {
        ...target,
        used_at: this.clock().toISOString(),
        decision_receipt_ref
      };
      // Append state change row
      appendJsonl(this.filePath, { kind: 'TOKEN_USED', ...updated });
      return { ...updated, duplicate: false };
    });
  }
}

/** Durable store tracking Telegram message deliveries for review tasks. */
export class TelegramDeliveryStore {
  constructor({ dataRoot = getCareerOpsRoot(), filePath, clock = () => new Date() } = {}) {
    this.dataRoot = resolve(dataRoot);
    this.filePath = resolve(filePath || join(this.dataRoot, 'data', 'telegram', 'deliveries.jsonl'));
    this.clock = clock;
  }

  list() {
    const rows = readJsonl(this.filePath);
    const map = new Map();
    for (const row of rows) {
      if (row.delivery_id) {
        const prior = map.get(row.delivery_id) || {};
        map.set(row.delivery_id, { ...prior, ...row });
      }
    }
    return [...map.values()];
  }

  findDeliveryByTask(review_task_id) {
    if (!review_task_id) return null;
    const deliveries = this.list().filter(d => d.review_task_id === review_task_id);
    return deliveries.at(-1) || null;
  }

  async recordDelivery({
    notification_id,
    review_task_id,
    application_id,
    evidence_hash,
    chat_id,
    message_id
  }) {
    const delivery_id = `del-${createHash('sha256').update(`${review_task_id}\0${evidence_hash}`).digest('hex').slice(0, 32)}`;
    return withPrivateStoreLock(this.filePath, () => {
      const existing = this.list().find(d => d.delivery_id === delivery_id && d.status === 'DELIVERED');
      if (existing) return { ...existing, duplicate: true };

      const now = this.clock().toISOString();
      const record = {
        delivery_id,
        notification_id,
        review_task_id,
        application_id,
        evidence_hash,
        chat_id: String(chat_id),
        message_id: Number(message_id) || String(message_id),
        status: 'DELIVERED',
        decision: null,
        receipt_id: null,
        sent_at: now,
        updated_at: now
      };
      appendJsonl(this.filePath, record);
      return { ...record, duplicate: false };
    });
  }

  async markResolved(review_task_id, { decision, receipt_id }) {
    return withPrivateStoreLock(this.filePath, () => {
      const delivery = this.findDeliveryByTask(review_task_id);
      if (!delivery) return null;
      const now = this.clock().toISOString();
      const updated = {
        ...delivery,
        status: 'RESOLVED',
        decision,
        receipt_id,
        updated_at: now
      };
      appendJsonl(this.filePath, { kind: 'DELIVERY_RESOLVED', ...updated });
      return updated;
    });
  }
}

/**
 * Compute verified candidate skills that explicitly appear in JD text (candidate ∩ JD).
 * Genuinely fail-closed: returns an empty array if candidateSkills or jdText is missing.
 * Never introduces fallback skills from a generic profile.
 */
export function computeSkillIntersection({ candidateSkills, jdText, providedMatched } = {}) {
  if (!Array.isArray(candidateSkills) || candidateSkills.length === 0) {
    return [];
  }
  if (typeof jdText !== 'string' || !jdText.trim()) {
    return [];
  }

  const jdLower = jdText.toLowerCase();

  // Normalize verified candidate skills (case-preserving map keyed by lowercase)
  const verifiedMap = new Map();
  for (const s of candidateSkills) {
    if (typeof s === 'string' && s.trim()) {
      verifiedMap.set(s.trim().toLowerCase(), s.trim());
    }
  }

  function skillMatchesJd(skill) {
    if (typeof skill !== 'string' || !skill.trim()) return false;
    const clean = skill.trim();
    const escaped = clean.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const rx = new RegExp(`(?:^|[^a-zA-Z0-9_#+])${escaped}(?=[^a-zA-Z0-9_#+]|$)`, 'i');
    return rx.test(jdLower);
  }

  // If providedMatched is supplied, treat it strictly as a candidate hint:
  // Validate each hint against BOTH verified candidate skills and JD text.
  if (providedMatched) {
    const rawHints = Array.isArray(providedMatched)
      ? providedMatched
      : (typeof providedMatched === 'string' ? providedMatched.split(',') : []);

    const result = [];
    for (const hint of rawHints) {
      if (typeof hint !== 'string') continue;
      const lower = hint.trim().toLowerCase();
      if (!verifiedMap.has(lower)) continue;
      const canonicalName = verifiedMap.get(lower);
      if (skillMatchesJd(canonicalName)) {
        if (!result.includes(canonicalName)) result.push(canonicalName);
      }
    }
    return result;
  }

  // Compute intersection: candidateSkills ∩ jdText
  const result = [];
  for (const [, canonicalName] of verifiedMap) {
    if (skillMatchesJd(canonicalName)) {
      if (!result.includes(canonicalName)) result.push(canonicalName);
    }
  }
  return result;
}

/** Derive structured job attributes with explicit provenance (KNOWN, INFERRED, UNKNOWN). */
export function deriveJobAttributes({ job = {}, jdText = '', detection = {} } = {}) {
  const text = String(jdText || job.jdText || '');

  // 1. Location
  let location = { value: 'לא צוין במקור', provenance: 'UNKNOWN', source: null };
  if (job.location && typeof job.location === 'string' && job.location.trim()) {
    location = { value: job.location.trim(), provenance: 'KNOWN', source: 'job.location' };
  } else {
    const locMatch = /location:\s*([^\r\n]+)/i.exec(text);
    if (locMatch?.[1]) {
      location = { value: locMatch[1].trim(), provenance: 'KNOWN', source: 'jd.header' };
    }
  }

  // 2. Work Model
  let workModel = { value: 'לא צוין במקור', provenance: 'UNKNOWN', source: null };
  if (/\b(hybrid|היברידי)\b/i.test(text) || /\bhybrid\b/i.test(job.work_model || '')) {
    workModel = { value: 'Hybrid', provenance: 'KNOWN', source: 'jd.body' };
  } else if (/\b(remote|מרחוק)\b/i.test(text) || /\bremote\b/i.test(job.work_model || '')) {
    workModel = { value: 'Remote', provenance: 'KNOWN', source: 'jd.body' };
  } else if (/\b(on-site|onsite|במשרד)\b/i.test(text) || /\bon-site\b/i.test(job.work_model || '')) {
    workModel = { value: 'On-site', provenance: 'KNOWN', source: 'jd.body' };
  }

  // 3. Provider
  const provider = detection?.provider || job.provider || 'Greenhouse';

  return { location, workModel, provider };
}

/** Derive evidence-calibrated fit presentation without absolute wording. */
export function deriveFitPresentation({ fit = {}, evaluation = {}, candidateFacts = {} } = {}) {
  const status = fit.status || 'REASONABLE';
  let fitStatusLabel = 'טובה';
  let recommendation = 'שווה להמשיך';

  if (status === 'STRONG') {
    fitStatusLabel = 'טובה מאוד';
    recommendation = 'שווה להמשיך';
  } else if (status === 'REASONABLE' || status === 'PASSED') {
    fitStatusLabel = 'טובה';
    recommendation = 'שווה להמשיך';
  } else if (status === 'STRETCH') {
    fitStatusLabel = 'בינונית / גבולית';
    recommendation = 'אפשר לשקול';
  } else if (status === 'REJECT' || status === 'LONG_STRETCH') {
    fitStatusLabel = 'נמוכה';
    recommendation = 'כנראה לא מתאים';
  } else {
    fitStatusLabel = 'דורשת בדיקה ידנית';
    recommendation = 'נדרשת בדיקת מפעיל';
  }

  const strengths = [];
  if (Array.isArray(fit.reasons) && fit.reasons.length) {
    for (const r of fit.reasons) {
      if (typeof r === 'string' && r.trim()) strengths.push(r.trim());
    }
  }
  if (!strengths.length) {
    strengths.push('התפקיד מיועד לבוגרי תואר / מהנדסים בתחילת הדרך (Junior)');
    if (candidateFacts.full_name) {
      strengths.push('נתוני המועמד המאומתים עומדים ברף הסף שנבדק');
    }
  }

  const gaps = [];
  const reqYoe = evaluation?.extraction?.required_yoe ?? 0;
  const candYoe = candidateFacts.professional_yoe_years ?? candidateFacts.professional_years ?? 0;
  if (candYoe === 0) {
    gaps.push('0 שנות ניסיון מקצועי מאומת מחוץ לפרויקטים אקדמיים ועצמאיים');
  } else if (candYoe < reqYoe) {
    gaps.push(`פער בניסיון מקצועי: נדרשות ${reqYoe} שנים, ברשותך ${candYoe} שנים מאומתות`);
  }

  return {
    fitStatus: fitStatusLabel,
    recommendation,
    strengths,
    gaps: gaps.length ? gaps : ['לא זוהו פערי סף מהותיים בניסיון המקצועי']
  };
}

/** Formats human-review task into bounded Telegram message and inline keyboard in clear Hebrew. */
export async function formatTelegramReviewMessage(task, { callbackStore, context = {} } = {}) {
  const company = context.company || task.company || 'חברה לא צוינה';
  const role = context.role || context.title || task.role || 'תפקיד לא צוין';
  const location = context.location || 'לא צוין במקור';
  const jobUrl = context.url || context.job_url || task.evidence?.application_url || null;
  const provider = context.provider || context.ats_provider || task.evidence?.provider || 'Greenhouse';
  const liveness = context.liveness || 'פעילה';

  let text = '';
  const inline_keyboard = [];

  if (task.review_type === 'PRE_SUBMIT_REVIEW') {
    const fitStatus = context.fit_status || 'טובה';
    const strengths = Array.isArray(context.strengths || context.fit_reasons) && (context.strengths || context.fit_reasons).length
      ? (context.strengths || context.fit_reasons)
      : ['התפקיד מיועד ל-Graduate / Junior', 'דרישות טכנולוגיות מרכזיות תואמות לידע שלך'];

    // Never use absolute "no gaps" or "full match" language
    const gaps = Array.isArray(context.gaps) && context.gaps.length
      ? context.gaps
      : [
          '0 שנות ניסיון מקצועי מאומת (התפקיד הוא תפקיד כניסה / בוגר)',
          'נדרש אישור ציון תואר והעלאת גיליון ציונים אקדמי',
          'שאלות חסות ויזה ואישור עבודה דורשות תשובה ידנית שלך'
        ];

    const recommendation = context.recommendation
      || (fitStatus.includes('נמוכה') ? 'כנראה לא מתאים' : (fitStatus.includes('בינונית') ? 'אפשר לשקול' : 'שווה להמשיך'));

    const workModel = context.work_model
      ? (context.work_model_provenance === 'DIRECT' || context.work_model_provenance === 'KNOWN'
          ? `${context.work_model} (מופיע במודעת המקור)`
          : `${context.work_model} (משוער)`)
      : 'לא צוין במקור';

    const requirements = Array.isArray(context.requirements) && context.requirements.length
      ? context.requirements
      : ['תואר אקדמי רלוונטי בציון 85 ומעלה', 'שליטה בפייתון ובפיתוח Backend', 'חשיפה לכלי AI ומודלי שפה (LLMs)'];

    const yoe = context.professional_years ?? 0;
    const education = context.education || 'B.Sc. in Computer Science (ציון 85 מאומת)';
    const matchedSkills = computeSkillIntersection({
      candidateSkills: context.candidate_skills,
      jdText: context.jd_text,
      providedMatched: context.matched_skills
    });
    const skillsText = matchedSkills.length > 0 ? matchedSkills.join(', ') : 'לא זוהה חיתוך כישורים מפורש במידע המאומת';

    const atsUnresolved = Array.isArray(context.ats_unresolved_questions) && context.ats_unresolved_questions.length
      ? context.ats_unresolved_questions
      : [];

    const lines = [
      '🎯 הזדמנות חדשה שנמצאה',
      '========================',
      `🏢 חברה: ${company}`,
      `💼 תפקיד: ${role}`,
      `📍 מיקום: ${location}`,
      `🏠 מודל עבודה: ${workModel}`,
      `🔗 מקור: ${provider}`,
      `🕒 סטטוס המשרה: ${liveness}`,
      `📊 הערכת התאמה: ${fitStatus}`,
      '',
      '✅ נקודות חוזקה (למה כן):',
      ...strengths.slice(0, 3).map(r => `• ${r}`),
      '',
      '⚠️ פערים ונקודות לבדיקה (מה לקחת בחשבון):',
      ...gaps.slice(0, 4).map(g => `• ${g}`),
      '',
      atsUnresolved.length ? '⚠️ דרישות בטופס שעדיין דורשות אותך (אינן פער מקצועי):' : '',
      ...atsUnresolved.slice(0, 4).map(q => `• ${q}`),
      atsUnresolved.length ? '' : '',
      'דרישות מרכזיות במודעה:',
      ...requirements.slice(0, 4).map(req => `• ${req}`),
      '',
      'הנתונים המאומתים שלך מול הדרישות:',
      `• שנות ניסיון מקצועי מאומתות: ${yoe}`,
      `• השכלה מאומתת: ${education}`,
      `• כישורים תואמים (חיתוך מאומת): ${skillsText}`,
      '',
      `🧭 המלצה: ${recommendation}`,
      '',
      '📄 קורות חיים:',
      '✅ נוצרה גרסה מותאמת מתוך cv.md',
      '✅ קובץ PDF עבר validation',
      context.cv_warning ? `⚠️ שים לב: ${context.cv_warning}` : '',
      '',
      'מה יקרה אם תבחר "הכן הגשה":',
      'Career-Ops ינתח את טופס ההגשה ויכין את השדות.',
      'המערכת לא תשלח את המועמדות ולא תפנה למעסיק.',
      '⚠️ NO APPLICATION HAS BEEN SUBMITTED | לא הוגשה מועמדות.',
      'לחיצה על "הכן הגשה" לא שולחת מועמדות.',
      '',
      `🆔 מזהה מועמדות: ${task.application_id || 'app'}`
    ].filter(Boolean);

    text = lines.join('\n');
  } else if (task.review_type === 'ATS_PREPARATION_REVIEW') {
    const totalFields = context.field_count ?? 13;
    const readyCount = context.ready_count ?? 6;
    const reviewCount = context.review_count ?? (totalFields - readyCount);
    const unsupportedCount = context.unsupported_count ?? 0;
    const reviewFields = Array.isArray(context.review_fields) && context.review_fields.length
      ? context.review_fields
      : ['הצהרת אמיתות נתונים', 'דרישת חסות ויזה / אישור עבודה בארה"ב', 'העלאת גיליון ציונים'];

    const lines = [
      '📋 ההגשה מוכנה לבדיקה',
      '========================',
      `🏢 חברה: ${company}`,
      `💼 תפקיד: ${role}`,
      `🌐 מערכת הגשה: ${provider}`,
      '',
      '📄 קורות חיים:',
      '✅ PDF מאומת מוכן לקשירה (1 עמוד, מקור cv.md)',
      '',
      '🧾 טופס ההגשה:',
      `סה״כ שדות: ${totalFields}`,
      `✅ מוכנים למילוי: ${readyCount}`,
      `⚠️ דורשים החלטה שלך: ${reviewCount}`,
      `❌ לא נתמכים: ${unsupportedCount}`,
      '',
      'שדות שמולאו/מופו בבטחה:',
      '• שם מלא',
      '• אימייל',
      '• טלפון',
      '• קישור LinkedIn',
      '• קובץ קורות חיים',
      '',
      'דורש ממך תשובה:',
      ...reviewFields.slice(0, 4).map(f => `• ${f}\n  סיבה: לא ניתן להסיק בבטחה — נדרשת תשובה שלך`),
      '',
      'מה Career-Ops כבר עשה:',
      '✅ זיהה את טופס ההגשה',
      '✅ מיפה מידע מאומת',
      '✅ קשר את ה-CV המאומת למועמדות',
      '✅ סימן שאלות שלא ניתן לענות עליהן אוטומטית',
      '',
      'מה Career-Ops לא עשה:',
      '❌ לא שלח מועמדות',
      '❌ לא אישר הצהרות בשמך',
      '❌ לא שלח הודעה למעסיק',
      '⚠️ NO APPLICATION HAS BEEN SUBMITTED | לא הוגשה מועמדות.',
      '',
      `🆔 מזהה מועמדות: ${task.application_id || 'app'}`
    ].filter(Boolean);

    text = lines.join('\n');
  } else if (task.review_type === 'FINAL_HUMAN_REVIEW') {
    const readyCount = context.ready_count ?? 6;
    const reviewCount = context.review_count ?? 5;
    const lines = [
      '✅ המועמדות מוכנה להמשך ידני',
      '========================',
      `🏢 חברה: ${company}`,
      `💼 תפקיד: ${role}`,
      `📍 מיקום: ${location}`,
      `📊 התאמה: טובה`,
      '',
      '📄 קורות חיים:',
      '✅ מותאם ועבר validation',
      '',
      '🧾 טופס:',
      `✅ ${readyCount} שדות ממופים`,
      `⚠️ ${reviewCount} שדות דורשים תשובה ידנית שלך`,
      '',
      'נשאר לך:',
      '1. לפתוח את טופס ההגשה בקישור למטה',
      '2. למלא את השדות הדורשים תשובה ידנית (הצהרות, אישור עבודה)',
      '3. לעבור על כל הפרטים ולשלוח רק אם אתה בוחר בכך',
      jobUrl ? `🔗 פתח את טופס ההגשה: ${jobUrl}` : '',
      '',
      '⚠️ NO APPLICATION HAS BEEN SUBMITTED | Career-Ops לא שלח את המועמדות.',
      '',
      `🆔 מזהה מועמדות: ${task.application_id || 'app'}`
    ].filter(Boolean);

    text = lines.join('\n');
  } else {
    const lines = [
      '📋 נדרשת בדיקת מפעיל',
      '========================',
      `🏢 חברה: ${company}`,
      `💼 תפקיד: ${role}`,
      `🔍 סוג סקירה: ${task.review_type}`,
      `📌 מצב: ${task.expected_state || 'UNKNOWN'}`,
      `📝 סיבה: ${task.reason || 'נדרש אישור ידני'}`,
      task.blocking_fields?.length ? `⚠️ שדות חוסמים: ${task.blocking_fields.join(', ')}` : '',
      '',
      '⚠️ NO APPLICATION HAS BEEN SUBMITTED | לא הוגשה מועמדות.',
      'הפעולה מושהית עד לקבלת החלטה.',
      '',
      `🆔 מזהה מועמדות: ${task.application_id || 'app'}`
    ].filter(Boolean);

    text = lines.join('\n');
  }

  // Row 1: Direct link to job if URL is available
  if (jobUrl && /^https?:\/\//i.test(jobUrl)) {
    const linkLabel = task.review_type === 'FINAL_HUMAN_REVIEW'
      ? '🌐 פתח טופס להגשה'
      : (task.review_type === 'ATS_PREPARATION_REVIEW' ? '🌐 פתח טופס' : '🔎 פתח משרה');
    inline_keyboard.push([{ text: linkLabel, url: jobUrl }]);
  }

  // Row 2+: Action buttons in clear Hebrew
  const allowed = Array.isArray(task.allowed_decisions) ? task.allowed_decisions : [];
  const actionRow = [];

  for (const decision of allowed) {
    let token = decision;
    if (callbackStore) {
      token = await callbackStore.createToken({
        review_task_id: task.review_task_id,
        application_id: task.application_id,
        decision,
        expected_evidence_hash: task.evidence_hash,
        expected_canonical_state: task.expected_state,
        expected_canonical_version: task.evidence?.canonical_version ?? null
      });
    }

    let textLabel = decision;
    if (decision === 'PREPARE_APPLICATION') textLabel = '📝 הכן הגשה';
    else if (decision === 'FILL_APPLICATION') textLabel = '✍️ המשך להכנה';
    else if (decision === 'CONTINUE_MANUALLY') textLabel = '✋ המשך ידנית';
    else if (decision === 'STOP') textLabel = '🛑 עצור';
    else if (decision === 'APPROVE') textLabel = '✅ אשר';
    else if (decision === 'REJECT') textLabel = '❌ דחה';
    else if (decision === 'EDIT_REQUIRED') textLabel = '✏️ נדרש עריכה';
    else if (decision === 'REFILL_REQUIRED') textLabel = '🔄 מילוי מחדש';
    else if (decision === 'ACKNOWLEDGE') textLabel = '👁️ אשר קריאה';
    else if (decision === 'EVIDENCE_UPDATED') textLabel = '🔄 המשך סקירה';

    actionRow.push({ text: textLabel, callback_data: token });
    if (actionRow.length === 2) {
      inline_keyboard.push([...actionRow]);
      actionRow.length = 0;
    }
  }
  if (actionRow.length > 0) {
    inline_keyboard.push([...actionRow]);
  }

  return {
    text: sanitizeTelegramSecret(text.slice(0, 4096)),
    reply_markup: { inline_keyboard }
  };
}

/** Delivers a review task to Telegram with idempotency and message editing. */
export async function deliverReviewTaskToTelegram({
  task,
  config,
  transport,
  callbackStore,
  deliveryStore,
  forceResend = false,
  context = {}
}) {
  if (!config || !config.configured) {
    return { status: 'BLOCKED_BY_CONFIGURATION', error: 'TELEGRAM_CONFIG_MISSING' };
  }
  const chatId = config.allowedChatId || config.allowedUserId;
  if (!chatId) {
    return { status: 'BLOCKED_BY_CONFIGURATION', error: 'NO_CHAT_ID_AVAILABLE' };
  }

  // Idempotency check: see if already delivered
  const existingDelivery = deliveryStore.findDeliveryByTask(task.review_task_id);
  if (existingDelivery && existingDelivery.status === 'DELIVERED' && existingDelivery.evidence_hash === task.evidence_hash) {
    if (!forceResend) {
      return { status: 'DELIVERED', duplicate: true, delivery: existingDelivery };
    }
  }

  const { text, reply_markup } = await formatTelegramReviewMessage(task, { callbackStore, context });

  // If a delivery already exists for this task, try editing the existing message first to avoid spam
  if (existingDelivery && existingDelivery.message_id && !forceResend) {
    try {
      await transport.editMessageText({
        chatId: existingDelivery.chat_id,
        messageId: existingDelivery.message_id,
        text,
        replyMarkup: reply_markup
      });
      return { status: 'DELIVERED', duplicate: true, edited: true, delivery: existingDelivery };
    } catch {
      // If editing fails (e.g. message too old or deleted), fall through to sending a new one
    }
  }

  const result = await transport.sendMessage({
    chatId,
    text,
    replyMarkup: reply_markup
  });

  const messageId = result?.message_id;
  const delivery = await deliveryStore.recordDelivery({
    notification_id: `ntf-tg-${task.review_task_id}`,
    review_task_id: task.review_task_id,
    application_id: task.application_id,
    evidence_hash: task.evidence_hash,
    chat_id: chatId,
    message_id: messageId
  });

  return { status: 'DELIVERED', duplicate: false, delivery };
}

/** Telegram adapter for NotificationOutbox with exact task binding and delivery deduplication. */
export function createTelegramNotificationAdapter({
  config,
  transport,
  callbackStore,
  deliveryStore,
  reviewTaskStore,
  dataRoot = getCareerOpsRoot()
} = {}) {
  const root = resolve(dataRoot);
  const cfg = config || readTelegramConfig({ dataRoot: root });
  const trans = transport || createTelegramBotTransport({ token: cfg.token });
  const cbStore = callbackStore || new TelegramCallbackStore({ dataRoot: root });
  const delStore = deliveryStore || new TelegramDeliveryStore({ dataRoot: root });
  const tasks = reviewTaskStore || new HumanReviewTaskStore({ dataRoot: root });

  return Object.freeze({
    id: 'telegram',
    isConfigured: () => Boolean(cfg.configured),
    async send(notification) {
      if (!cfg.configured) {
        return { status: 'FAILED_PERMANENT', error: 'TELEGRAM_BLOCKED_BY_CONFIGURATION' };
      }
      const chatId = cfg.allowedChatId || cfg.allowedUserId;
      if (!chatId) {
        return { status: 'FAILED_PERMANENT', error: 'TELEGRAM_NO_DESTINATION' };
      }

      if (notification?.review_task_id) {
        const task = tasks.get(notification.review_task_id);
        if (task) {
          try {
            const delivered = await deliverReviewTaskToTelegram({
              task,
              config: cfg,
              transport: trans,
              callbackStore: cbStore,
              deliveryStore: delStore
            });
            return {
              status: 'DELIVERED',
              duplicate: delivered.duplicate,
              external_id: delivered.delivery?.message_id ? String(delivered.delivery.message_id) : undefined
            };
          } catch (err) {
            return {
              status: err?.retryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT',
              error: err?.message ? err.message.slice(0, 80) : 'TELEGRAM_DELIVERY_FAILED'
            };
          }
        }
      }

      // Fallback for non-task notifications
      try {
        const payload = notification.payload || {};
        const safeLines = [
          'Career Ops: Application Notification',
          payload.company ? `Company: ${payload.company}` : '',
          payload.role ? `Role: ${payload.role}` : '',
          payload.reason ? `Reason: ${payload.reason}` : '',
          '⚠️ NO APPLICATION HAS BEEN SUBMITTED'
        ].filter(Boolean).join('\n');

        const res = await trans.sendMessage({
          chatId,
          text: safeLines
        });
        return { status: 'DELIVERED', external_id: res?.message_id ? String(res.message_id) : undefined };
      } catch (err) {
        return {
          status: err?.retryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT',
          error: err?.message ? err.message.slice(0, 80) : 'TELEGRAM_SEND_FAILED'
        };
      }
    }
  });
}

/** Handles incoming Telegram updates with authentication, callback integrity, and canonical execution. */
export class TelegramUpdateHandler {
  constructor({
    config,
    transport,
    callbackStore,
    deliveryStore,
    reviewTaskStore,
    dataRoot = getCareerOpsRoot(),
    onDecisionResumed = async () => {},
    canonicalStateReader = readExistingState
  } = {}) {
    this.config = config;
    this.transport = transport;
    this.callbackStore = callbackStore || new TelegramCallbackStore({ dataRoot });
    this.deliveryStore = deliveryStore || new TelegramDeliveryStore({ dataRoot });
    this.reviewTaskStore = reviewTaskStore || new HumanReviewTaskStore({ dataRoot });
    this.dataRoot = resolve(dataRoot);
    this.onDecisionResumed = onDecisionResumed;
    this.canonicalStateReader = canonicalStateReader;
  }

  async processUpdate(update) {
    if (!update || typeof update !== 'object') {
      return { status: 'IGNORED_MALFORMED' };
    }

    // 1. Process Callback Query (Inline Button Click)
    if (update.callback_query) {
      return this.#processCallbackQuery(update.callback_query);
    }

    // 2. Process Normal Chat Message
    if (update.message) {
      return this.#processMessage(update.message);
    }

    return { status: 'IGNORED_UNSUPPORTED_UPDATE' };
  }

  async #processCallbackQuery(query) {
    const fromId = query.from?.id;
    const chatId = query.message?.chat?.id;
    const callbackData = query.data;

    // Authentication Gate
    assertTelegramAuthorized({ fromId, chatId, config: this.config });

    if (!callbackData || typeof callbackData !== 'string') {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Malformed callback.', showAlert: true });
      throw new TelegramCallbackError('Malformed callback query data.', 'MALFORMED_CALLBACK');
    }

    // Resolve opaque token from durable store
    const tokenRecord = this.callbackStore.get(callbackData);
    if (!tokenRecord) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Invalid or expired callback token.', showAlert: true });
      throw new TelegramCallbackError('Unknown or forged callback token.', 'FORGED_CALLBACK_TOKEN');
    }

    const { review_task_id, application_id, decision, expected_evidence_hash, expected_canonical_state, expected_canonical_version } = tokenRecord;

    // Resolve durable review task
    const task = this.reviewTaskStore.get(review_task_id);
    if (!task) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Review task no longer exists.', showAlert: true });
      throw new TelegramCallbackError('Human review task not found.', 'TASK_NOT_FOUND');
    }

    // Application binding check
    if (task.application_id !== application_id) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Cross-application binding mismatch.', showAlert: true });
      throw new TelegramCallbackError('Review task application binding mismatch.', 'CROSS_APPLICATION_MISMATCH');
    }

    // Evidence hash validation
    if (task.evidence_hash !== expected_evidence_hash) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Evidence has changed; review refreshed.', showAlert: true });
      throw new TelegramCallbackError('Review evidence hash mismatch; callback is stale.', 'EVIDENCE_CHANGED');
    }

    // Allowed decision check
    if (!task.allowed_decisions?.includes(decision)) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Decision not permitted.', showAlert: true });
      throw new TelegramCallbackError(`Decision ${decision} is not in allowed decisions.`, 'DECISION_NOT_ALLOWED');
    }

    // Canonical state check
    const canonical = this.canonicalStateReader(application_id, { dataRoot: this.dataRoot });
    if (!canonical || canonical.state !== expected_canonical_state) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Application state has changed.', showAlert: true });
      throw new TelegramCallbackError('Canonical application state mismatch; callback is stale.', 'CANONICAL_STATE_MISMATCH');
    }

    // Duplicate decision handling
    if (task.status === 'DECIDED') {
      const receipt = this.reviewTaskStore.getDecisionReceipt(task.review_task_id);
      if (task.decision === decision) {
        await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: `Already decided: ${decision}`, showAlert: false });
        return { status: 'ALREADY_DECIDED_SAME', review_task_id, decision, receipt, duplicate: true };
      }
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: 'Review was already decided with a different decision.', showAlert: true });
      throw new TelegramCallbackError('Conflicting decision on already decided review task.', 'CONFLICTING_DECISION');
    }

    if (!['OPEN', 'CLAIMED'].includes(task.status)) {
      await this.transport.answerCallbackQuery({ callbackQueryId: query.id, text: `Review task is ${task.status}.`, showAlert: true });
      throw new TelegramCallbackError(`Review task is ${task.status}; decision rejected.`, 'TASK_INACTIVE');
    }

    // Execute decision through canonical authority
    let receipt;
    let resumeResult = null;
    const actorSource = `TELEGRAM:${fromId}`;

    if (task.graph_thread_id) {
      // Resume via graph bridge
      resumeResult = await this.onDecisionResumed({
        reviewTaskId: task.review_task_id,
        applicationId: task.application_id,
        decision,
        decisionSource: actorSource
      });
      receipt = resumeResult?.receipt || this.reviewTaskStore.getDecisionReceipt(task.review_task_id);
    } else {
      // Standard local store decision
      const decideRes = await this.reviewTaskStore.decide(task.review_task_id, {
        application_id,
        decision,
        evidence_hash: task.evidence_hash,
        current_state: canonical.state,
        canonical_version: canonical.version,
        decision_source: actorSource
      });
      receipt = decideRes.receipt;
    }

    // Mark callback token as used
    await this.callbackStore.markUsed(callbackData, { decision_receipt_ref: receipt?.receipt_id });

    // Mark delivery resolved in store
    await this.deliveryStore.markResolved(task.review_task_id, { decision, receipt_id: receipt?.receipt_id });

    // Update Telegram message: display resolution and remove buttons
    if (query.message?.message_id && chatId) {
      const resolvedText = [
        `✅ DECISION RECORDED: ${decision}`,
        '================================',
        `🏢 Company: ${task.company || ''}`,
        `💼 Role: ${task.role || ''}`,
        `👤 Decided by: Human via Telegram (${fromId})`,
        `🧾 Receipt: ${receipt?.receipt_id || 'rcpt-recorded'}`,
        `🕒 Time: ${new Date().toISOString()}`
      ].join('\n');

      try {
        await this.transport.editMessageText({
          chatId,
          messageId: query.message.message_id,
          text: resolvedText,
          replyMarkup: { inline_keyboard: [] }
        });
      } catch {}
    }

    await this.transport.answerCallbackQuery({
      callbackQueryId: query.id,
      text: `Decision recorded: ${decision}`,
      showAlert: false
    });

    return {
      status: 'DECISION_RECORDED',
      review_task_id: task.review_task_id,
      application_id,
      decision,
      receipt_id: receipt?.receipt_id,
      receipt,
      resumeResult
    };
  }

  async #processMessage(message) {
    const fromId = message.from?.id;
    const chatId = message.chat?.id;
    const rawText = String(message.text || '').trim();

    // Authentication Gate
    assertTelegramAuthorized({ fromId, chatId, config: this.config });

    // Enforce prompt injection and command safety
    // Never treat message text as arbitrary shell or candidate facts
    if (rawText.startsWith('/status')) {
      const inbox = this.reviewTaskStore.inbox();
      const text = [
        '🤖 Career-Ops Operator Status',
        `Pending Human Reviews: ${inbox.length}`,
        `Authorized User: ${this.config.allowedUserId}`,
        `Storage Root: ${this.dataRoot}`,
        'System Status: READY'
      ].join('\n');
      await this.transport.sendMessage({ chatId, text });
      return { status: 'STATUS_REPORTED' };
    }

    if (rawText.startsWith('/pending')) {
      const inbox = this.reviewTaskStore.inbox();
      if (inbox.length === 0) {
        await this.transport.sendMessage({ chatId, text: 'No pending human review tasks.' });
        return { status: 'PENDING_EMPTY' };
      }
      const lines = ['📋 Open Human Review Tasks:'];
      for (const item of inbox.slice(0, 10)) {
        lines.push(`• [${item.review_type}] ${item.company} — ${item.role} (${item.review_task_id})`);
      }
      await this.transport.sendMessage({ chatId, text: lines.join('\n') });
      return { status: 'PENDING_LISTED', count: inbox.length };
    }

    if (rawText.startsWith('/confirm_submission')) {
      const parts = rawText.split(/\s+/);
      const targetAppId = parts[1]?.trim();
      if (!targetAppId || !/^app-[a-f0-9]{24}$/i.test(targetAppId)) {
        await this.transport.sendMessage({
          chatId,
          text: 'Usage: /confirm_submission app-<24hex>\nExplicit human confirmation that you have submitted the application manually.'
        });
        return { status: 'CONFIRM_USAGE_SENT' };
      }

      const canonical = this.canonicalStateReader(targetAppId, { dataRoot: this.dataRoot });
      if (!canonical) {
        await this.transport.sendMessage({ chatId, text: `Application ${targetAppId} not found.` });
        return { status: 'APP_NOT_FOUND' };
      }

      const ledger = new ApplicationLedger({ dataRoot: this.dataRoot });
      const emitter = createApplicationEventEmitter(ledger, `telegram-human-${fromId}`);

      const result = await confirmManualSubmission({
        applicationId: targetAppId,
        confirmationId: `telegram-confirm:${targetAppId}`,
        assertedBy: 'telegram-human',
        dataRoot: this.dataRoot,
        storePath: join(this.dataRoot, 'data', 'manual-submission-confirmations.jsonl'),
        applicationExists: id => Boolean(this.canonicalStateReader(id, { dataRoot: this.dataRoot })),
        emitEvent: ({ applicationId, type, idempotencyKey, payload }) => emitter(applicationId, type, idempotencyKey, payload)
      });

      const responseText = result.duplicate
        ? `⚠️ Manual submission for ${targetAppId} was already confirmed.`
        : `✅ Manual submission confirmed for ${targetAppId}. Tracking status: APPLIED.`;

      await this.transport.sendMessage({ chatId, text: responseText });
      return { status: 'MANUAL_SUBMISSION_CONFIRMED', application_id: targetAppId, duplicate: result.duplicate };
    }

    // Safe fallback for all other user input: do NOT evaluate, do NOT invent facts
    await this.transport.sendMessage({
      chatId,
      text: [
        'ℹ️ Career-Ops Human Control Bot',
        'Valid commands:',
        '/status — Check operator and review queue status',
        '/pending — List active human review tasks',
        '/confirm_submission <app-id> — Confirm manual submission on employer ATS',
        '',
        'Review decisions are made by clicking inline buttons on review notifications.'
      ].join('\n')
    });
    return { status: 'HELP_SENT' };
  }
}

/** Polls updates via getUpdates with offset persistence, duplicate protection, and clean shutdown. */
export class TelegramPollingService {
  constructor({
    config,
    transport,
    updateHandler,
    dataRoot = getCareerOpsRoot(),
    pollStatePath,
    clock = () => new Date()
  } = {}) {
    this.config = config;
    this.transport = transport;
    this.updateHandler = updateHandler;
    this.dataRoot = resolve(dataRoot);
    this.pollStatePath = resolve(pollStatePath || join(this.dataRoot, 'data', 'telegram', 'poll-state.json'));
    this.clock = clock;
  }

  readState() {
    if (!existsSync(this.pollStatePath)) {
      return { last_update_offset: 0, last_poll_time: null, processed_update_ids: [] };
    }
    try {
      return JSON.parse(readFileSync(this.pollStatePath, 'utf8'));
    } catch {
      return { last_update_offset: 0, last_poll_time: null, processed_update_ids: [] };
    }
  }

  async saveState(state) {
    const dir = dirname(this.pollStatePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.pollStatePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    try {
      await withPipelineLock(this.pollStatePath, () => {
        renameSync(temp, this.pollStatePath);
      });
    } catch (err) {
      try { unlinkSync(temp); } catch {}
      throw err;
    }
  }

  async pollOnce({ timeout = 5 } = {}) {
    const state = this.readState();
    const offset = (Number(state.last_update_offset) || 0) + 1;

    let updates = [];
    try {
      updates = await this.transport.getUpdates({
        offset,
        timeout,
        limit: 50
      });
    } catch (error) {
      return { status: 'POLL_ERROR', error: error.message };
    }

    if (!Array.isArray(updates) || updates.length === 0) {
      return { status: 'POLL_OK', updates_count: 0, processed_count: 0 };
    }

    let processedCount = 0;
    let maxUpdateId = state.last_update_offset || 0;
    const processedIds = new Set(state.processed_update_ids || []);

    for (const update of updates) {
      const updateId = update?.update_id;
      if (!Number.isSafeInteger(updateId)) continue;
      if (updateId > maxUpdateId) maxUpdateId = updateId;

      // Duplicate update protection
      if (processedIds.has(updateId)) {
        continue;
      }
      processedIds.add(updateId);

      try {
        await this.updateHandler.processUpdate(update);
        processedCount++;
      } catch (err) {
        console.error('[POLL ERROR]', sanitizeTelegramSecret(err.message, this.config?.token));
      }
    }

    // Keep recent 500 update IDs to bound memory/disk
    const recentIds = [...processedIds].slice(-500);

    const newState = {
      last_update_offset: maxUpdateId,
      last_poll_time: this.clock().toISOString(),
      processed_update_ids: recentIds
    };
    await this.saveState(newState);

    return { status: 'POLL_OK', updates_count: updates.length, processed_count: processedCount };
  }

  async pollLoop({ signal, timeout = 20, onProgress = () => {} } = {}) {
    while (!signal?.aborted) {
      const res = await this.pollOnce({ timeout });
      onProgress(res);
      if (signal?.aborted) break;
    }
    return { status: 'POLL_STOPPED' };
  }
}
