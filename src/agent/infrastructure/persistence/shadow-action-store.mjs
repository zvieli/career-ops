import { constants, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { assertApplicationId } from './application-ledger.mjs';

const ACTIONS = new Set(['FILL_APPLICATION', 'CONTINUE_MANUALLY', 'PREPARE_APPLICATION', 'SUBMIT_APPLICATION', 'SEND_RECRUITER', 'ACCEPT_CALENDAR_INVITE', 'CONFIRM_MANUAL_SUBMISSION', 'SUPPLY_FACT', 'EDIT_REQUIRED', 'REFILL_REQUIRED']);
const pathFor = root => join(root, 'data', 'runs', 'shadow-actions.jsonl');

function privatePath(path, { missing = true } = {}) {
  const directory = dirname(path); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) throw new Error('Shadow action directory must be private and not a symlink.');
  try {
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0) throw new Error('Shadow action ledger must be a private regular file.');
  } catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
}
function read(path) {
  privatePath(path);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (text && !text.endsWith('\n')) throw new Error('Shadow action ledger has an incomplete trailing record.');
  return text.split('\n').filter(Boolean).map((line, index) => {
    if (Buffer.byteLength(line) > 8_192) throw new Error(`Shadow action receipt ${index + 1} exceeds size limit.`);
    let row; try { row = JSON.parse(line); } catch { throw new Error(`Shadow action ledger is malformed at line ${index + 1}.`); }
    validate(row); return row;
  });
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.receipt_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.receipt_id)
    || typeof input.run_id !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(input.run_id)) throw new Error('Invalid shadow action receipt identity.');
  assertApplicationId(input.application_id);
  if (!ACTIONS.has(input.action) || input.reason !== 'BLOCKED_BY_SHADOW_MODE' || input.blocked_by_shadow_mode !== true
    || typeof input.created_at !== 'string' || !Number.isFinite(Date.parse(input.created_at))) throw new Error('Invalid shadow action receipt.');
  return input;
}

export function listShadowActionReceipts({ dataRoot }) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new TypeError('dataRoot is required.');
  const path = pathFor(dataRoot);
  return existsSync(path) ? read(path) : [];
}

export async function recordShadowActionReceipt({ dataRoot, run_id, application_id, action, reason = 'BLOCKED_BY_SHADOW_MODE', created_at = new Date().toISOString() } = {}, { signal, guard } = {}) {
  if (typeof dataRoot !== 'string' || !dataRoot) throw new TypeError('dataRoot is required.');
  if (guard !== undefined && typeof guard !== 'function') throw new TypeError('Shadow action guard must be a function.');
  assertApplicationId(application_id);
  if (typeof run_id !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(run_id) || !ACTIONS.has(action) || reason !== 'BLOCKED_BY_SHADOW_MODE' || !Number.isFinite(Date.parse(created_at))) throw new Error('Invalid blocked shadow action or receipt input.');
  const path = pathFor(dataRoot);
  privatePath(path);
  const receipt_id = createHash('sha256').update(`${run_id}\0${application_id}\0${action}`).digest('hex');
  return withPipelineLock(path, () => {
    if (signal?.aborted) throw signal.reason || Object.assign(new Error('Shadow action receipt cancelled.'), { code: 'SHADOW_CANCELLED' });
    guard?.();
    const rows = read(path);
    const prior = rows.find(row => row.receipt_id === receipt_id);
    if (prior) return prior;
    const receipt = validate({ receipt_id, run_id, application_id, action, reason, blocked_by_shadow_mode: true, created_at });
    if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Safe no-follow shadow action writes are unavailable.');
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Shadow action ledger descriptor is not a regular file.');
      fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd);
    } finally { closeSync(fd); }
    return receipt;
  });
}
