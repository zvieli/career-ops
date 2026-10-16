import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { assertPrivateDirectory, assertPrivateRegularFile, filesystemPrivacyCapabilities, readPrivateFile } from './filesystem-privacy.mjs';

const dir = root => join(resolve(root), 'data', 'scheduler');
const leasePath = (root, id) => join(dir(root), `${createHash('sha256').update(id).digest('hex')}.lease.json`);
const lockPath = (root, id) => `${leasePath(root, id)}.lock`;
function withLock(root, id, fn) {
  const directory = dir(root); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const st = lstatSync(directory);
  assertPrivateDirectory(st, 'Scheduler store must be a private real directory.');
  const lock = lockPath(root, id); let fd;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock recovery with a second atomic guard. Without it, two
    // reapers can both validate the old inode and one can unlink a new owner's lock.
    const reapLock = `${lock}.reap`;
    let reapFd;
    try { reapFd = openSync(reapLock, 'wx', 0o600); }
    catch (reapError) { if (reapError.code === 'EEXIST') return fn(true); throw reapError; }
    let reaped = false;
    try {
      let owner;
      try { owner = JSON.parse(readPrivateFile(lock)); } catch { return fn(true); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return fn(true);
      try { process.kill(owner.pid, 0); return fn(true); }
      catch (probeError) { if (probeError.code !== 'ESRCH') return fn(true); }
      try {
        const current = lstatSync(lock);
        if (current.ino !== owner.ino || current.dev !== owner.dev) return fn(true);
        unlinkSync(lock); reaped = true;
      } catch (reapError) { if (reapError.code !== 'ENOENT') return fn(true); }
    } finally { closeSync(reapFd); try { unlinkSync(reapLock); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (reaped) {
      try { fd = openSync(lock, 'wx', 0o600); } catch (retryError) { if (retryError.code === 'EEXIST') return fn(true); throw retryError; }
    } else return fn(true);
  }
  try {
    if (filesystemPrivacyCapabilities().POSIX_MODE_ENFORCEMENT) fchmodSync(fd, 0o600);
    const stat = lstatSync(lock);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ino: stat.ino, dev: stat.dev, token: randomUUID() }));
    return fn(false);
  } finally { closeSync(fd); try { unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function read(path) {
  if (!existsSync(path)) return null;
  let data; try { data = JSON.parse(readPrivateFile(path)); } catch { throw new Error('Run lease is malformed; refusing acquisition.'); }
  if (!data || typeof data.runId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(data.runId)
    || typeof data.schedulerId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(data.schedulerId)
    || typeof data.owner !== 'string' || !data.owner
    || !['ACTIVE', 'COMPLETED', 'FAILED', 'EXPIRED', 'ABANDONED', 'CANCELLED'].includes(data.status)
    || !Number.isFinite(Date.parse(data.expiresAt)) || !Number.isFinite(Date.parse(data.startedAt))
    || !Number.isFinite(Date.parse(data.heartbeatAt)) || Date.parse(data.heartbeatAt) < Date.parse(data.startedAt)) throw new Error('Run lease is corrupt; refusing acquisition.');
  const stat = lstatSync(path);
  assertPrivateRegularFile(stat, 'Run lease file must be a private regular file.');
  return data;
}
function save(path, value) { const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(tmp, path); }
const iso = n => { if (!Number.isFinite(n)) throw new Error('Invalid lease timestamp.'); return new Date(n).toISOString(); };

export function acquireRunLease({ dataRoot, schedulerId, owner, now = new Date(), leaseMs }) {
  if (typeof schedulerId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(schedulerId) || typeof owner !== 'string' || !owner || owner.length > 128 || !Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 30 * 60_000) throw new Error('schedulerId, bounded owner and leaseMs up to 30 minutes are required.');
  const at = new Date(now).getTime();
  if (!Number.isFinite(at)) throw new Error('Invalid lease clock value.');
  const path = leasePath(dataRoot, schedulerId);
  return withLock(dataRoot, schedulerId, locked => {
    if (locked) return { acquired: false, status: 'RUN_SKIPPED_ALREADY_ACTIVE', lease: read(path) };
    let recoveredLease = null;
    const prior = read(path);
    if (prior) {
      const expiration = Date.parse(prior.expiresAt);
      const heartbeatAt = Date.parse(prior.heartbeatAt);
      if (prior.status === 'ACTIVE' && (expiration > at || Date.parse(prior.startedAt) > at || heartbeatAt > at)) return { acquired: false, status: 'RUN_SKIPPED_ALREADY_ACTIVE', lease: prior };
      if (prior.status === 'ACTIVE') {
        const ownerMatch = /^local:(\d+)$/.exec(prior.owner || '');
        if (!ownerMatch) return { acquired: false, status: 'RUN_SKIPPED_ALREADY_ACTIVE', lease: prior };
        try { process.kill(Number(ownerMatch[1]), 0); return { acquired: false, status: 'RUN_SKIPPED_ALREADY_ACTIVE', lease: prior }; }
        catch (probe) { if (probe.code !== 'ESRCH') return { acquired: false, status: 'RUN_SKIPPED_ALREADY_ACTIVE', lease: prior }; }
        recoveredLease = { ...prior, status: 'EXPIRED', expiredAt: iso(at) };
        save(`${path}.expired.${randomUUID()}.json`, recoveredLease);
      }
    }
    const lease = { schedulerId, owner, runId: randomUUID(), status: 'ACTIVE', startedAt: iso(at), heartbeatAt: iso(at), expiresAt: iso(at + leaseMs) };
    save(path, lease); return { acquired: true, lease, recoveredLease };
  });
}
function updateRunLease({ dataRoot, runId, now = new Date(), leaseMs, status }) {
  if (typeof runId !== 'string' || !runId) throw new Error('runId is required.');
  const filename = readdirSync(dir(dataRoot)).find(name => name.endsWith('.lease.json') && read(join(dir(dataRoot), name))?.runId === runId);
  if (!filename) return false;
  const target = join(dir(dataRoot), filename);
  const snapshot = read(target);
  if (!snapshot?.schedulerId) throw new Error('Run lease has no scheduler identity.');
  return withLock(dataRoot, snapshot.schedulerId, contended => {
    if (contended) return false;
    const lease = read(target);
    if (!lease || lease.runId !== runId || lease.status !== 'ACTIVE') return false;
    const at = new Date(now).getTime();
    const heartbeat = Date.parse(lease.heartbeatAt), expires = Date.parse(lease.expiresAt);
    if (!Number.isFinite(at)) return false;
    if (status) {
      if (!['COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED'].includes(status)) throw new Error('Invalid terminal lease status.');
      if (at < heartbeat && status === 'COMPLETED') return false;
      save(target, { ...lease, status, completedAt: iso(Math.max(at, heartbeat)) });
      return true;
    }
    if (at < heartbeat) return false;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('positive leaseMs is required.');
    if (at >= expires) return false;
    save(target, { ...lease, heartbeatAt: iso(at), expiresAt: iso(at + leaseMs) });
    return true;
  });
}
export function heartbeatRunLease(options) { return updateRunLease(options); }
export function completeRunLease({ dataRoot, runId, status, now = new Date() }) { return updateRunLease({ dataRoot, runId, status, now }); }
export function listRunLeases({ dataRoot }) {
  const directory = dir(dataRoot);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.lease.json') || /\.expired\.[A-Za-z0-9-]+\.json$/.test(name))
    .map(name => read(join(directory, name)))
    .filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
