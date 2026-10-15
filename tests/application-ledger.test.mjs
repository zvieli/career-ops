import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  APPLICATION_EVENT_TYPES,
  ApplicationEventStore,
  ApplicationArtifactStore,
  ApplicationLedger,
  ApplicationTimeline,
  createApplicationEventEmitter,
  recordJobDiscoveryEvent,
  semanticFitEventType
} from '../lib/application-ledger.mjs';
import { NotificationRouter, createTelegramAdapter, inspectTelegramSecretsEnv } from '../lib/notification-router.mjs';
import { ingestRecruiterEmails, validateInterviewContext } from '../lib/recruiter-email-monitor.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';

const APP_ID = 'app-0123456789abcdef01234567';
function tempRoot() { return mkdtempSync(join(tmpdir(), 'career-ops-ledger-')); }

test('an aborted scheduled event append does not write after waiting for its lock', async () => {
  const root = tempRoot();
  try {
    const store = new ApplicationEventStore({ dataRoot: root });
    let release;
    const lockHeld = withPipelineLock(store.filePath, () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const pending = store.append({ applicationId: APP_ID, type: 'JOB_DISCOVERED', producer: 'scheduled-shadow', idempotencyKey: 'cancelled', payload: {} }, { signal: controller.signal });
    controller.abort(Object.assign(new Error('Scheduled run cancelled.'), { code: 'SHADOW_CANCELLED' }));
    release();
    await lockHeld;
    await assert.rejects(pending, error => error.code === 'SHADOW_CANCELLED');
    assert.deepEqual(store.list(APP_ID), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('event store is append-only, idempotent by semantic key, and isolates application timelines', async () => {
  const root = tempRoot();
  try {
    const store = new ApplicationEventStore({ dataRoot: root, clock: () => new Date('2026-10-12T10:00:00.000Z') });
    const input = { applicationId: APP_ID, type: 'JOB_DISCOVERED', producer: 'legacy-autonomous', idempotencyKey: 'posting:abc', payload: { company: 'Example', role: 'Engineer' } };
    const first = await store.append(input);
    const duplicate = await store.append(input);
    assert.equal(first.event_id, duplicate.event_id);
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(store.append({ ...input, payload: { company: 'Changed payload' } }), /reused with a different payload/i);
    const next = await store.append({ ...input, type: 'FIT_REASONABLE', idempotencyKey: 'fit:evidence-1', occurredAt: '2026-10-12T10:01:00.000Z' });
    assert.notEqual(first.event_id, next.event_id);
    assert.equal(store.list(APP_ID).length, 2);
    assert.equal(store.list('app-ffffffffffffffffffffffff').length, 0);
    assert.ok(APPLICATION_EVENT_TYPES.includes('APPLICATION_SUBMITTED_CONFIRMED'));
    assert.ok(APPLICATION_EVENT_TYPES.includes('EVALUATION_RETRY_AUTHORIZED'));
    const lines = readFileSync(join(root, 'data', 'application-events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).sequence, 1);
    assert.equal(JSON.parse(lines[1]).sequence, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('event store rejects unsafe event payloads and corrupt ledgers without overwriting evidence', async () => {
  const root = tempRoot();
  try {
    const store = new ApplicationEventStore({ dataRoot: root });
    await assert.rejects(store.append({ applicationId: APP_ID, type: 'NOT_A_REAL_EVENT', producer: 'test', idempotencyKey: 'x' }), /event type/i);
    await assert.rejects(store.append({ applicationId: APP_ID, type: 'JOB_DISCOVERED', producer: 'test', idempotencyKey: 'x', payload: { access_token: 'must-not-persist' } }), /sensitive/i);
    await assert.rejects(store.append({ applicationId: APP_ID, type: 'JOB_DISCOVERED', producer: 'test', idempotencyKey: 'body', payload: { emailBody: 'do not persist raw mail' } }), /sensitive/i);
    await assert.rejects(store.append({ applicationId: APP_ID, type: 'ARTIFACT_STORED', producer: 'test', idempotencyKey: 'binary', payload: { bytes: Buffer.from('private') } }), /binary or date/i);
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'application-events.jsonl'), '{truncated\n');
    await assert.rejects(store.append({ applicationId: APP_ID, type: 'JOB_DISCOVERED', producer: 'test', idempotencyKey: 'y' }), /corrupt/i);
    assert.equal(readFileSync(join(root, 'data', 'application-events.jsonl'), 'utf8'), '{truncated\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('concurrent identical event appends produce one ledger record', async () => {
  const root = tempRoot();
  try {
    const store = new ApplicationEventStore({ dataRoot: root });
    const event = { applicationId: APP_ID, type: 'JOB_DISCOVERED', producer: 'legacy-autonomous', idempotencyKey: 'posting:one' };
    const results = await Promise.all(Array.from({ length: 8 }, () => store.append(event)));
    assert.equal(store.list(APP_ID).length, 1);
    assert.equal(results.filter(result => result.duplicate).length, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fit outcomes map to the shared semantic event vocabulary', () => {
  assert.equal(semanticFitEventType('STRONG'), 'FIT_REASONABLE');
  assert.equal(semanticFitEventType('REASONABLE'), 'FIT_REASONABLE');
  assert.equal(semanticFitEventType('REJECT'), 'FIT_REJECTED');
  assert.equal(semanticFitEventType('LONG_STRETCH'), 'FIT_REJECTED');
  assert.equal(semanticFitEventType('NEEDS_REVIEW'), 'FIT_NEEDS_REVIEW');
  assert.equal(semanticFitEventType('unknown'), null);
});

test('legacy and LangGraph adapters deduplicate the same semantic event across orchestrators', async () => {
  const root = tempRoot();
  try {
    const ledger = new ApplicationLedger({ dataRoot: root });
    const legacyEmit = createApplicationEventEmitter(ledger, 'legacy-autonomous');
    const graphEmit = createApplicationEventEmitter(ledger, 'langgraph');
    const legacy = await recordJobDiscoveryEvent(legacyEmit, APP_ID);
    const graph = await recordJobDiscoveryEvent(graphEmit, APP_ID);
    assert.equal(legacy.type, graph.type);
    assert.equal(legacy.event_id, graph.event_id);
    assert.equal(graph.duplicate, true);
    assert.deepEqual(ledger.timeline(APP_ID).map(event => event.type), ['JOB_DISCOVERED']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact store is content-addressed, private, immutable, and ledger-referenced', async () => {
  const root = tempRoot();
  try {
    const ledger = new ApplicationLedger({ dataRoot: root });
    const artifact = await ledger.storeArtifact({ applicationId: APP_ID, name: 'cv-final.pdf', content: Buffer.from('%PDF-test'), mediaType: 'application/pdf', producer: 'legacy-autonomous', idempotencyKey: 'cv:sha' });
    const duplicate = await ledger.storeArtifact({ applicationId: APP_ID, name: 'cv-final.pdf', content: Buffer.from('%PDF-test'), mediaType: 'application/pdf', producer: 'legacy-autonomous', idempotencyKey: 'cv:sha' });
    assert.equal(artifact.sha256, duplicate.sha256);
    assert.equal(artifact.artifact_id, duplicate.artifact_id);
    assert.equal(ledger.eventStore.list(APP_ID).filter(event => event.type === 'ARTIFACT_STORED').length, 1);
    const artifacts = new ApplicationArtifactStore({ dataRoot: root });
    assert.equal(artifacts.list(APP_ID).length, 1);
    const artifactPath = join(root, 'data', 'application-artifacts', artifact.relative_path);
    if (process.platform !== 'win32') assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
    writeFileSync(artifactPath, 'tampered');
    assert.throws(() => artifacts.put({ applicationId: APP_ID, name: 'cv-final.pdf', content: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }), /integrity verification/i);
    assert.throws(() => artifacts.list(APP_ID), /content-address verification/i);
    assert.throws(() => new ApplicationTimeline(ledger.eventStore).forApplication('../escape'), /application id/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact listing ignores active and abandoned publication temporaries', async () => {
  const root = tempRoot();
  let child;
  try {
    const store = new ApplicationArtifactStore({ dataRoot: root });
    const artifact = store.put({ applicationId: APP_ID, name: 'stable.pdf', content: Buffer.from('published'), mediaType: 'application/pdf' });
    const finalPath = join(root, 'data', 'application-artifacts', artifact.relative_path);
    const temporaryPath = join(dirname(finalPath), `.tmp-12345678-1234-1234-1234-123456789abc-${basename(finalPath)}`);
    const worker = `import { openSync, writeSync, closeSync } from 'node:fs'; const fd = openSync(${JSON.stringify(temporaryPath)}, 'wx', 0o600); writeSync(fd, 'partial'); process.stdout.write('READY\\n'); process.stdin.on('end', () => closeSync(fd));`;
    child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`temporary writer failed (${code}): ${stderr}`)));
    });
    await new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => chunk.includes('READY') && resolve());
      child.once('error', reject);
    });
    let duringPublication;
    let listingError;
    try { duringPublication = store.list(APP_ID); } catch (error) { listingError = error; }
    child.stdin.end();
    await closed;
    assert.ifError(listingError);
    assert.equal(duringPublication.length, 1);
    assert.equal(store.list(APP_ID).length, 1, 'an abandoned temporary must not become a listed artifact');
    assert.equal(readFileSync(finalPath, 'utf8'), 'published');
  } finally {
    if (child && child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('content-addressed artifact publication is atomic under cross-process contention', async () => {
  const root = tempRoot();
  try {
    const moduleUrl = new URL('../lib/application-ledger.mjs', import.meta.url).href;
    const worker = `import { ApplicationArtifactStore } from ${JSON.stringify(moduleUrl)}; new ApplicationArtifactStore({ dataRoot: ${JSON.stringify(root)} }).put({ applicationId: ${JSON.stringify(APP_ID)}, name: 'same.pdf', content: Buffer.from('same-artifact'), mediaType: 'application/pdf' });`;
    const runWorker = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`artifact child failed (${code}): ${stderr}`)));
    });
    await Promise.all(Array.from({ length: 4 }, runWorker));
    const artifacts = new ApplicationArtifactStore({ dataRoot: root }).list(APP_ID);
    assert.equal(artifacts.length, 1);
    assert.equal(readFileSync(join(root, 'data', 'application-artifacts', artifacts[0].relative_path), 'utf8'), 'same-artifact');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('notification router persists receipts, deduplicates delivery, and blocks missing Telegram config without network', async () => {
  const root = tempRoot();
  try {
    let sends = 0;
    const adapter = { id: 'fixture', isConfigured: () => true, send: async () => { sends++; return { status: 'DELIVERED' }; } };
    const router = new NotificationRouter({ dataRoot: root, adapters: [adapter] });
    const event = { event_id: 'evt-1', application_id: APP_ID, type: 'INTERVIEW_INVITE_RECEIVED', occurred_at: '2026-10-12T10:00:00.000Z', payload: { company: 'Example', role: 'Engineer' } };
    const first = await router.route(event);
    const second = await router.route(event);
    assert.equal(first[0].status, 'DELIVERED');
    assert.equal(second[0].status, 'DELIVERED');
    assert.equal(second[0].duplicate, true);
    assert.equal(sends, 1);
    const replay = await router.dispatchPending({ list: () => [event] });
    assert.equal(replay[0].duplicate, true);
    assert.equal(sends, 1);

    let fetchCalls = 0;
    const telegram = createTelegramAdapter({ token: '', chatId: '', fetchImpl: async () => { fetchCalls++; throw new Error('must not send'); } });
    const blocked = await telegram.send({ event_type: 'INTERVIEW_INVITE_RECEIVED' });
    assert.equal(blocked.status, 'BLOCKED_BY_CONFIGURATION');
    assert.equal(fetchCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uncertain notification delivery is never retried automatically', async () => {
  const root = tempRoot();
  try {
    let sends = 0;
    const adapter = { id: 'uncertain', isConfigured: () => true, send: async () => { sends++; return { status: 'DELIVERY_UNCONFIRMED' }; } };
    const router = new NotificationRouter({ dataRoot: root, adapters: [adapter] });
    const event = { event_id: 'evt-uncertain', application_id: APP_ID, type: 'FIT_REASONABLE', payload: {} };
    assert.equal((await router.route(event))[0].status, 'DELIVERY_UNCONFIRMED');
    assert.equal((await router.route(event))[0].status, 'DELIVERY_UNCONFIRMED');
    assert.equal(sends, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Telegram adapter sends only its bounded message and never exposes credentials in receipts', async () => {
  const token = 'fixture-secret-token';
  let request;
  const adapter = createTelegramAdapter({ token, chatId: '12345', fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  } });
  const result = await adapter.send({ event_type: 'FIT_REASONABLE', application_id: APP_ID, payload: { company: 'Example', role: 'Engineer', summary: 'Fit passed' } });
  assert.equal(result.status, 'DELIVERED');
  assert.equal(request.options.method, 'POST');
  assert.match(request.url, /api\.telegram\.org/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.ok(JSON.parse(request.options.body).text.length <= 1000);
});

test('Telegram secrets.env presence check exposes booleans only and adapter reads the documented path', async () => {
  const root = tempRoot();
  const secretsFile = join(root, '.config', 'career-ops', 'secrets.env');
  const oldToken = process.env.CAREER_OPS_TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.CAREER_OPS_TELEGRAM_CHAT_ID;
  delete process.env.CAREER_OPS_TELEGRAM_BOT_TOKEN;
  delete process.env.CAREER_OPS_TELEGRAM_CHAT_ID;
  try {
    assert.equal(inspectTelegramSecretsEnv({ secretsFile }).status, 'BLOCKED_BY_CONFIGURATION');
    mkdirSync(dirname(secretsFile), { recursive: true });
    writeFileSync(secretsFile, 'CAREER_OPS_TELEGRAM_BOT_TOKEN=fixture-never-print-this\nCAREER_OPS_TELEGRAM_CHAT_ID=12345\n', { mode: 0o600 });
    const status = inspectTelegramSecretsEnv({ secretsFile });
    assert.deepEqual(status, { file_present: true, file_readable: true, token_configured: true, chat_id_configured: true, status: 'CONFIGURED' });
    assert.doesNotMatch(JSON.stringify(status), /fixture-never-print-this|12345/);
    let requestUrl = '';
    const adapter = createTelegramAdapter({ secretsFile, fetchImpl: async (url) => {
      requestUrl = String(url);
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    } });
    assert.equal((await adapter.send({ event_id: 'evt-test', application_id: APP_ID, type: 'FIT_REASONABLE', payload: {} })).status, 'DELIVERED');
    assert.match(requestUrl, /fixture-never-print-this/);
  } finally {
    if (oldToken === undefined) delete process.env.CAREER_OPS_TELEGRAM_BOT_TOKEN; else process.env.CAREER_OPS_TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.CAREER_OPS_TELEGRAM_CHAT_ID; else process.env.CAREER_OPS_TELEGRAM_CHAT_ID = oldChat;
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent duplicate recruiter messages create one event receipt', async () => {
  const root = tempRoot();
  try {
    const ledger = new ApplicationLedger({ dataRoot: root });
    const applications = [{ application_id: APP_ID, num: '42', company: 'Example Corp', role: 'Backend Engineer', status: 'Applied', date: '2026-10-01' }];
    const message = { accountId: 'candidate-mailbox', messageId: 'msg-concurrent', receivedAt: '2026-10-12T10:00:00.000Z', from: 'recruiter@example.com', subject: 'Interview invitation: Backend Engineer', body: 'Interview invitation for the Backend Engineer role at Example Corp.' };
    await Promise.all(Array.from({ length: 5 }, () => ingestRecruiterEmails({ messages: [message], applications, ledger, dataRoot: root })));
    assert.equal(ledger.eventStore.list(APP_ID).filter(item => item.type === 'INTERVIEW_INVITE_RECEIVED').length, 1);
    assert.equal(readFileSync(join(root, 'data', 'recruiter-email-receipts.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid email timestamps are review-only and do not create application events', async () => {
  const root = tempRoot();
  try {
    const ledger = new ApplicationLedger({ dataRoot: root });
    const applications = [{ application_id: APP_ID, num: '42', company: 'Example Corp', role: 'Backend Engineer', status: 'Applied', date: '2026-10-01' }];
    const messages = [null, undefined, 0, 'not-a-date', '2026-02-30T10:00:00Z', '2026-10-12T24:00:00Z'].map((receivedAt, index) => ({
      accountId: 'candidate-mailbox', messageId: `msg-invalid-date-${index}`, receivedAt,
      from: 'recruiter@example.com', subject: 'Update: Backend Engineer',
      body: 'We would like to speak about the Backend Engineer role at Example Corp.'
    }));
    const result = await ingestRecruiterEmails({ messages, applications, ledger, dataRoot: root });
    assert.deepEqual(result.map(item => item.status), Array(6).fill('NEEDS_REVIEW'));
    assert.equal(ledger.eventStore.list(APP_ID).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recruiter email ingestion deduplicates mailbox IDs, requires unique high-confidence correlation, and never mutates tracker status', async () => {
  const root = tempRoot();
  try {
    const ledger = new ApplicationLedger({ dataRoot: root });
    const applications = [{ application_id: APP_ID, num: '42', company: 'Example Corp', role: 'Backend Engineer', status: 'Applied', date: '2026-10-01' }];
    const message = { accountId: 'candidate-mailbox', messageId: 'msg-1', receivedAt: '2026-10-12T10:00:00.000Z', from: 'recruiter@example.com', subject: 'Interview invitation: Backend Engineer', body: 'We would like to schedule an interview for the Backend Engineer role at Example Corp.' };
    const first = await ingestRecruiterEmails({ messages: [message], applications, ledger, dataRoot: root });
    const duplicate = await ingestRecruiterEmails({ messages: [message], applications, ledger, dataRoot: root });
    assert.equal(first[0].status, 'RECORDED');
    assert.equal(duplicate[0].status, 'DUPLICATE');
    const event = ledger.eventStore.list(APP_ID).find(item => item.type === 'INTERVIEW_INVITE_RECEIVED');
    assert.ok(event);
    assert.equal(JSON.stringify(event).includes(message.body), false);
    assert.equal(validateInterviewContext({ classification: 'Interview', match: { confidence: 'high' }, application: applications[0], receivedAt: message.receivedAt }).status, 'VALID');
    assert.equal(validateInterviewContext({ classification: 'Interview', match: { confidence: 'high' }, application: applications[0], receivedAt: null }).status, 'NEEDS_REVIEW');
    assert.notEqual(applications[0].status, 'Interview');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
