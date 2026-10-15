import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';

export const RUN_STATUSES = Object.freeze(['CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const EVENTS = new Set(RUN_STATUSES);
const MAX_LINE_BYTES = 64 * 1024;

function ledgerPath(dataRoot = getCareerOpsRoot()) {
  return resolve(dataRoot, 'data/runs/agent-runs.jsonl');
}
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function withLedgerLock(filePath, operation) {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) throw new Error('Run ledger directory must be private and not a symlink.');
  const lockPath = `${filePath}.lock`;
  let fd;
  try { fd = openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reapPath = `${lockPath}.reap`;
    let reapFd;
    try { reapFd = openSync(reapPath, 'wx', 0o600); }
    catch (reap) { if (reap.code === 'EEXIST') throw new Error('Run ledger lock recovery is busy; refusing write.'); throw reap; }
    let reaped = false;
    try {
      let lock;
      try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { throw new Error('Run ledger lock is unreadable; refusing write.'); }
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('Run ledger lock is invalid; refusing write.');
      try { process.kill(lock.pid, 0); throw new Error('Run ledger is locked by another writer.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      const current = lstatSync(lockPath);
      if (current.ino !== lock.ino || current.dev !== lock.dev) throw new Error('Run ledger lock changed during recovery.');
      unlinkSync(lockPath); reaped = true;
    } finally { closeSync(reapFd); try { unlinkSync(reapPath); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; } }
    if (!reaped) throw new Error('Run ledger lock recovery failed.');
    try { fd = openSync(lockPath, 'wx', 0o600); } catch (retry) { if (retry.code === 'EEXIST') throw new Error('Run ledger is locked by another writer.'); throw retry; }
  }
  try {
    fchmodSync(fd, 0o600);
    const stat = lstatSync(lockPath);
    writeSync(fd, JSON.stringify({ pid: process.pid, ino: stat.ino, dev: stat.dev, token: randomUUID() }));
    return operation();
  } finally { closeSync(fd); try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid run record');
  if (typeof record.run_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(record.run_id)) throw new Error('Invalid run_id');
  if (typeof record.event_id !== 'string' || !record.event_id || typeof record.event !== 'string' || !EVENTS.has(record.event)) throw new Error('Invalid event identity');
  if (!RUN_STATUSES.includes(record.status) || record.status !== record.event) throw new Error('Invalid run status');
  if (!validTimestamp(record.timestamp) || typeof record.trigger !== 'string' || record.trigger.length > 80 || typeof record.mode !== 'string' || record.mode.length > 80) throw new Error('Invalid run metadata');
  if (!validTimestamp(record.started_at) || (record.completed_at !== null && !validTimestamp(record.completed_at))) throw new Error('Invalid lifecycle timestamps');
  if (record.outcome !== undefined && (record.status !== 'COMPLETED' || !['COMPLETED', 'DEGRADED'].includes(record.outcome))) throw new Error('Invalid run outcome');
  if (!Array.isArray(record.stages) || record.stages.length > 100 || !record.stages.every(v => typeof v === 'string' && v.length <= 120 && !/[\r\n\u0000-\u001f]/.test(v))) throw new Error('Invalid stages');
  if (!record.counters || typeof record.counters !== 'object' || Array.isArray(record.counters) || Object.values(record.counters).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error('Invalid counters');
  if (!Array.isArray(record.warnings) || record.warnings.length > 100 || !record.warnings.every(v => typeof v === 'string' && v.length <= 160 && !/[\r\n\u0000-\u001f]/.test(v))) throw new Error('Invalid warnings');
  if (record.failure_class !== null && !['JOB_LOCAL_FAILURE', 'PROVIDER_FAILURE', 'RUN_FATAL_FAILURE', 'SECURITY_FAILURE', 'TRANSIENT_NETWORK', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'MALFORMED_RESPONSE', 'PERMANENT_CONFIGURATION'].includes(record.failure_class)) throw new Error('Invalid failure_class');
  if (typeof record.config_fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(record.config_fingerprint) || (record.code_version !== null && !/^[a-f0-9]{7,64}$/i.test(record.code_version))) throw new Error('Invalid version/fingerprint');
  return record;
}

function readRecords(filePath) {
  let stat;
  try { stat = lstatSync(filePath); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Run ledger must be a private regular file.');
  if (stat.size > 100 * 1024 * 1024) throw new Error('Run ledger exceeds the 100 MiB read limit; operator review/archival is required.');
  const text = readFileSync(filePath, 'utf8');
  if (text && !text.endsWith('\n')) throw new Error('Run ledger has an incomplete trailing record');
  const lines = text.split('\n');
  lines.pop();
  return lines.map((line, index) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`Run ledger line ${index + 1} exceeds limit`);
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`Run ledger line ${index + 1} is malformed`); }
    return validateRecord(record);
  });
}
function appendRecord(record, filePath) {
  const line = JSON.stringify(validateRecord(record));
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('Run record exceeds size limit');
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) throw new Error('Run ledger directory must be private and not a symlink.');
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Safe no-follow ledger writes are unavailable on this platform.');
  try { const existing = lstatSync(filePath); if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Run ledger destination must be a regular file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(filePath, flags, 0o600);
  try {
    const descriptor = fstatSync(fd);
    if (!descriptor.isFile()) throw new Error('Run ledger descriptor is not a regular file.');
    fchmodSync(fd, 0o600); writeSync(fd, `${line}\n`); fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Append a new run's CREATED lifecycle event. Duplicate run IDs are rejected. */
export function createRun(input, options = {}) {
  const filePath = options.filePath ?? ledgerPath(options.dataRoot);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const record = {
    run_id: input.run_id, event_id: input.event_id ?? 'CREATED', event: 'CREATED', status: 'CREATED', timestamp,
    trigger: input.trigger, mode: input.mode, started_at: input.started_at ?? timestamp, completed_at: null,
    stages: input.stages ?? [], counters: input.counters ?? {}, warnings: input.warnings ?? [],
    failure_class: null, config_fingerprint: input.config_fingerprint, code_version: input.code_version ?? null,
  };
  return withLedgerLock(filePath, () => {
    const records = readRecords(filePath);
    if (records.some(row => row.run_id === record.run_id)) throw new Error(`Run already exists: ${record.run_id}`);
    appendRecord(record, filePath);
    return record;
  });
}

/** Append an idempotent lifecycle event; event IDs are unique within each run. */
export function appendRunEvent(runId, event, patch = {}, options = {}) {
  if (!EVENTS.has(event) || event === 'CREATED') throw new Error('Invalid lifecycle event');
  const filePath = options.filePath ?? ledgerPath(options.dataRoot);
  return withLedgerLock(filePath, () => {
    const records = readRecords(filePath).filter(row => row.run_id === runId);
    if (!records.length) throw new Error(`Unknown run: ${runId}`);
    const eventId = patch.event_id ?? event;
    const existing = records.find(row => row.event_id === eventId);
    if (existing) {
      const requested = { ...existing, ...patch, event_id: eventId, event, status: event };
      if (JSON.stringify(requested) !== JSON.stringify(existing)) throw new Error('Conflicting duplicate run event.');
      return existing;
    }
    const prior = records.at(-1);
    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(event);
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(prior.status)) throw new Error('Run is already terminal.');
    if (event === 'RUNNING' && !['CREATED', 'RUNNING'].includes(prior.status)) throw new Error('Invalid run lifecycle transition.');
    if (terminal && prior.status !== 'RUNNING' && !(event === 'EXPIRED' && prior.status === 'CREATED')) throw new Error('Invalid run lifecycle transition.');
    const timestamp = patch.timestamp ?? new Date().toISOString();
    if (!validTimestamp(timestamp) || Date.parse(timestamp) < Date.parse(prior.timestamp)) throw new Error('Run event timestamp moved backward.');
    const record = validateRecord({ ...prior, ...patch, run_id: runId, event_id: eventId, event, status: event,
      timestamp, completed_at: terminal ? (patch.completed_at ?? timestamp) : null });
    appendRecord(record, filePath);
    return record;
  });
}

export function listRuns(options = {}) {
  const records = readRecords(options.filePath ?? ledgerPath(options.dataRoot));
  const latest = new Map();
  for (const record of records) latest.set(record.run_id, record);
  return [...latest.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
}
export function getRun(runId, options = {}) {
  const rows = readRecords(options.filePath ?? ledgerPath(options.dataRoot)).filter(row => row.run_id === runId);
  return rows.at(-1) ?? null;
}
export function summarizeRuns(options = {}) {
  const runs = listRuns(options);
  const statuses = Object.fromEntries(RUN_STATUSES.map(status => [status, 0]));
  const counters = {};
  for (const run of runs) {
    statuses[run.status]++;
    for (const [key, value] of Object.entries(run.counters)) counters[key] = (counters[key] ?? 0) + value;
  }
  return { total: runs.length, statuses, counters };
}
