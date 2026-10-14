import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';

export const APPLICATION_EVENT_TYPES = Object.freeze([
  'JOB_DISCOVERED', 'JOB_HYDRATED', 'JOB_EVALUATED', 'EVALUATION_RETRY_AUTHORIZED', 'FIT_REASONABLE', 'FIT_REJECTED',
  'FIT_NEEDS_REVIEW', 'CANDIDATE_REVIEW_PAUSED', 'CANDIDATE_REVIEW_RESUMED',
  'CV_GENERATED', 'PDF_VALIDATED', 'APPLICATION_PREPARED',
  'FORM_PREFILLED', 'APPLICATION_SUBMITTED_CONFIRMED', 'RECRUITER_MESSAGE_RECEIVED',
  'INTERVIEW_INVITE_RECEIVED', 'APPLICATION_STATUS_CHANGED', 'ARTIFACT_STORED'
]);

const APPLICATION_ID = /^app-[a-f0-9]{24}$/i;
const SECRET_FIELD = /(?:access.?token|api.?key|authorization|credential|password|secret|(?:^|_)(?:body|raw_body|email_body|message_body|raw_message)(?:_|$))/i;
const MAX_EVENT_BYTES = 64 * 1024;
const ARTIFACT_TEMPORARY = /^\.tmp-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-[a-f0-9]{64}-[a-z0-9._-]{1,100}$/i;

export function assertApplicationId(applicationId) {
  if (typeof applicationId !== 'string' || !APPLICATION_ID.test(applicationId)) {
    throw new Error('Invalid application id; expected app- followed by 24 hexadecimal characters.');
  }
  return applicationId;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertNoSecrets(value, path = 'payload') {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Date) {
    throw new Error(`Binary or date values are not permitted in application event metadata: ${path}`);
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) assertNoSecrets(value[index], `${path}[${index}]`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (SECRET_FIELD.test(normalizedKey)) throw new Error(`Sensitive field is not permitted in application events: ${path}.${key}`);
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function parseJsonl(filePath, label) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const records = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    try { records.push(JSON.parse(lines[index])); }
    catch { throw new Error(`${label} is corrupt at line ${index + 1}; refusing to append or overwrite evidence.`); }
  }
  return records;
}

function appendDurably(filePath, record) {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error('Application event exceeds the 64 KiB record limit.');
  const fd = openSync(filePath, 'a', 0o600);
  try {
    writeSync(fd, line, null, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    const ignorable = ['EINVAL', 'ENOTSUP', 'ENOSYS'].includes(error?.code)
      || (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code));
    if (!ignorable) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function publishArtifact(finalPath, bytes) {
  const temporaryPath = join(dirname(finalPath), `.tmp-${randomUUID()}-${basename(finalPath)}`);
  let fd;
  try {
    fd = openSync(temporaryPath, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      // A hard link publishes the already-complete inode atomically and fails
      // with EEXIST rather than replacing an artifact written by another run.
      linkSync(temporaryPath, finalPath);
      fsyncDirectory(dirname(finalPath));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readFileSync(finalPath);
      if (sha256(existing) !== sha256(bytes) || !existing.equals(bytes)) {
        throw new Error('Existing content-addressed artifact failed integrity verification.');
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporaryPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export class ApplicationEventStore {
  constructor({ dataRoot = getCareerOpsRoot(), filePath, clock = () => new Date() } = {}) {
    this.dataRoot = resolve(dataRoot);
    this.filePath = resolve(filePath || join(this.dataRoot, 'data', 'application-events.jsonl'));
    this.clock = clock;
  }

  list(applicationId = null) {
    if (applicationId !== null) assertApplicationId(applicationId);
    const records = parseJsonl(this.filePath, 'Application event store');
    let previousSequence = 0;
    const eventIds = new Set();
    for (const record of records) {
      if (!Number.isSafeInteger(record.sequence) || record.sequence !== previousSequence + 1
        || !APPLICATION_ID.test(record.application_id || '')
        || !APPLICATION_EVENT_TYPES.includes(record.type)
        || !/^evt-[a-f0-9]{32}$/.test(record.event_id || '')
        || eventIds.has(record.event_id)
        || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
        throw new Error('Application event store contains an invalid, duplicated, or non-monotonic record; refusing to continue.');
      }
      assertNoSecrets(record.payload);
      eventIds.add(record.event_id);
      previousSequence = record.sequence;
    }
    return applicationId === null ? records : records.filter(record => record.application_id === applicationId);
  }

  async append({ applicationId, type, producer, idempotencyKey, occurredAt, payload = {} }) {
    assertApplicationId(applicationId);
    if (!APPLICATION_EVENT_TYPES.includes(type)) throw new Error(`Unsupported application event type: ${type}`);
    if (typeof producer !== 'string' || !producer.trim() || producer.length > 80) throw new Error('Application event producer is required (max 80 characters).');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 500) throw new Error('Application event idempotencyKey is required (max 500 characters).');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Application event payload must be an object.');
    assertNoSecrets(payload);
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) throw new Error('Application event payload must be JSON serializable.');
    const safePayload = JSON.parse(serializedPayload);
    const time = occurredAt === undefined ? this.clock() : new Date(occurredAt);
    if (!(time instanceof Date) || !Number.isFinite(time.getTime())) throw new Error('Application event occurredAt must be a valid date.');
    const keyDigest = sha256(`${applicationId}\0${type}\0${idempotencyKey}`);
    const eventId = `evt-${keyDigest.slice(0, 32)}`;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    return withPipelineLock(this.filePath, () => {
      const records = this.list();
      const existing = records.find(record => record.event_id === eventId);
      if (existing) {
        if (JSON.stringify(existing.payload) !== JSON.stringify(safePayload)) {
          throw new Error('Application event idempotency key was reused with a different payload.');
        }
        return { ...existing, duplicate: true };
      }
      const record = {
        schema_version: 1,
        sequence: records.length ? records.at(-1).sequence + 1 : 1,
        event_id: eventId,
        application_id: applicationId,
        type,
        producer: producer.trim(),
        idempotency_key_hash: keyDigest,
        occurred_at: time.toISOString(),
        recorded_at: this.clock().toISOString(),
        payload: safePayload
      };
      appendDurably(this.filePath, record);
      return { ...record, duplicate: false };
    });
  }
}

export class ApplicationArtifactStore {
  constructor({ dataRoot = getCareerOpsRoot() } = {}) {
    this.dataRoot = resolve(dataRoot);
    this.artifactRoot = join(this.dataRoot, 'data', 'application-artifacts');
  }

  put({ applicationId, name, content, mediaType = 'application/octet-stream' }) {
    assertApplicationId(applicationId);
    if (typeof name !== 'string' || !name.trim()) throw new Error('Artifact name is required.');
    if (typeof content !== 'string' && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) throw new Error('Artifact content must be a string or byte array.');
    if (typeof mediaType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) throw new Error('Artifact mediaType must be a valid type/subtype.');
    const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'artifact';
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const digest = sha256(bytes);
    const directory = join(this.artifactRoot, applicationId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const absolutePath = join(directory, `${digest}-${safeName}`);
    publishArtifact(absolutePath, bytes);
    return {
      artifact_id: `sha256:${digest}`,
      application_id: applicationId,
      name: safeName,
      media_type: mediaType,
      sha256: digest,
      size_bytes: bytes.length,
      relative_path: `${applicationId}/${digest}-${safeName}`
    };
  }

  list(applicationId) {
    assertApplicationId(applicationId);
    const directory = join(this.artifactRoot, applicationId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && !ARTIFACT_TEMPORARY.test(entry.name))
      .map(entry => {
        const absolutePath = join(directory, entry.name);
        const bytes = readFileSync(absolutePath);
        const digest = sha256(bytes);
        if (!entry.name.startsWith(`${digest}-`)) throw new Error(`Application artifact failed content-address verification: ${entry.name}`);
        return { artifact_id: `sha256:${digest}`, application_id: applicationId, name: entry.name.slice(65), sha256: digest, size_bytes: statSync(absolutePath).size, relative_path: `${applicationId}/${entry.name}` };
      });
  }
}

export class ApplicationTimeline {
  constructor(eventStore) {
    if (!eventStore || typeof eventStore.list !== 'function') throw new Error('ApplicationTimeline requires an ApplicationEventStore-compatible source.');
    this.eventStore = eventStore;
  }

  forApplication(applicationId) {
    assertApplicationId(applicationId);
    return this.eventStore.list(applicationId).sort((left, right) => left.sequence - right.sequence);
  }
}

export class ApplicationLedger {
  constructor({ dataRoot = getCareerOpsRoot(), eventStore, artifactStore, clock } = {}) {
    this.eventStore = eventStore || new ApplicationEventStore({ dataRoot, clock });
    this.artifactStore = artifactStore || new ApplicationArtifactStore({ dataRoot });
    this.applicationTimeline = new ApplicationTimeline(this.eventStore);
  }

  recordEvent(event) { return this.eventStore.append(event); }

  async storeArtifact({ producer = 'application-ledger', idempotencyKey, ...artifact }) {
    const stored = this.artifactStore.put(artifact);
    const event = await this.recordEvent({
      applicationId: artifact.applicationId,
      type: 'ARTIFACT_STORED',
      producer,
      idempotencyKey: idempotencyKey || `artifact:${stored.sha256}`,
      payload: { artifact_id: stored.artifact_id, name: stored.name, media_type: stored.media_type, sha256: stored.sha256, size_bytes: stored.size_bytes, relative_path: stored.relative_path }
    });
    return { ...stored, event_id: event.event_id };
  }

  timeline(applicationId) { return this.applicationTimeline.forApplication(applicationId); }
}

export function recordJobDiscoveryEvent(emit, applicationId) {
  if (typeof emit !== 'function') throw new Error('Job discovery event requires an application event emitter.');
  assertApplicationId(applicationId);
  return emit(applicationId, 'JOB_DISCOVERED', `posting:${applicationId}`, {});
}

export function semanticFitEventType(status) {
  if (status === 'STRONG' || status === 'REASONABLE') return 'FIT_REASONABLE';
  if (status === 'REJECT' || status === 'LONG_STRETCH') return 'FIT_REJECTED';
  if (status === 'NEEDS_REVIEW') return 'FIT_NEEDS_REVIEW';
  return null;
}

export function createApplicationEventEmitter(ledger, producer) {
  if (!ledger || typeof ledger.recordEvent !== 'function') throw new Error('Event emitter requires an ApplicationLedger-compatible object.');
  return (applicationId, type, idempotencyKey, payload = {}, occurredAt) => ledger.recordEvent({ applicationId, type, producer, idempotencyKey, payload, occurredAt });
}
