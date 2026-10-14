import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withPipelineLock } from '../../../../pipeline-lock.mjs';
import { normalizeUrl } from '../../../../url-key.mjs';
import { JD_TEXT_API_ATS, resolveAtsApi } from '../../../../liveness-api.mjs';

const QUEUE_VERSION = 'careerops.autonomous-pending@1';
export const MAX_AUTONOMOUS_PENDING_JOBS = 500;

function queueSnapshot(filePath) {
  if (!existsSync(filePath)) return { version: QUEUE_VERSION, jobs: [] };
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.jobs)) {
    throw new Error('Autonomous pending queue has an unsupported or corrupt format; refusing to replace it.');
  }
  for (const job of parsed.jobs) {
    if (!job || typeof job.url !== 'string' || !normalizeUrl(job.url) || job.verification_status !== 'active'
      || ![undefined, 'pending', 'blocked'].includes(job.queue_status)) {
      throw new Error('Autonomous pending queue contains an invalid or unverified job; refusing to continue.');
    }
  }
  return parsed;
}

function atomicWriteQueue(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let fd = null;
  let directoryFd = null;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, filePath);
    try {
      directoryFd = openSync(dirname(filePath), 'r');
      fsyncSync(directoryFd);
    } catch (error) {
      const ignorable = ['EINVAL', 'ENOTSUP', 'ENOSYS'].includes(error?.code)
        || (process.platform === 'win32' && ['EACCES', 'EPERM'].includes(error?.code));
      if (!ignorable) throw error;
    } finally {
      if (directoryFd !== null) closeSync(directoryFd);
      directoryFd = null;
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (directoryFd !== null) closeSync(directoryFd);
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function identityScope(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function authoritativeProviderForUrl(url) {
  const ats = resolveAtsApi(url)?.ats;
  return JD_TEXT_API_ATS.has(ats) ? ats : '';
}

function providerScopedIds(job) {
  const pairs = Array.isArray(job.provider_ids)
    ? job.provider_ids.filter((item) => item && typeof item.provider === 'string' && typeof item.id === 'string')
      .map(({ provider, id }) => [identityScope(provider), identityScope(id)])
    : [];
  if (typeof job.provider === 'string' && typeof job.externalId === 'string') {
    pairs.push([identityScope(job.provider), identityScope(job.externalId)]);
  }
  return pairs.filter(([provider, id]) => provider && id);
}

function assertProviderIdsCompatible(existing, incoming) {
  const idsByProvider = new Map();
  for (const [provider, id] of [...providerScopedIds(existing), ...providerScopedIds(incoming)]) {
    const knownId = idsByProvider.get(provider);
    if (knownId && knownId !== id) {
      throw new Error('Autonomous pending queue identity conflict for externalId; preserving existing entry.');
    }
    idsByProvider.set(provider, id);
  }
}

function assertSamePosting(existing, incoming) {
  const resolvedAuthority = authoritativeProviderForUrl(existing.url);
  const sameAuthority = Boolean(resolvedAuthority)
    && resolvedAuthority === authoritativeProviderForUrl(incoming.url)
    && identityScope(existing.authoritative_provider) === identityScope(resolvedAuthority)
    && identityScope(incoming.authoritative_provider) === identityScope(resolvedAuthority);
  assertProviderIdsCompatible(existing, incoming);
  for (const field of ['company', 'provider', 'externalId', 'requisitionId']) {
    const left = identityScope(existing[field]);
    const right = identityScope(incoming[field]);
    if (left && right && left !== right) {
      // Different discovery providers may report provider-scoped IDs for this
      // same exact ATS URL. Conflicting IDs inside one provider namespace remain
      // a hard conflict even when the canonical URL and authority match.
      const differentProviderNamespaces = identityScope(existing.provider)
        && identityScope(incoming.provider)
        && identityScope(existing.provider) !== identityScope(incoming.provider);
      if (sameAuthority && field === 'provider') continue;
      if (sameAuthority && field === 'externalId' && differentProviderNamespaces) continue;
      throw new Error(`Autonomous pending queue identity conflict for ${field}; preserving existing entry.`);
    }
  }
}

export function readAutonomousPendingJobs(filePath) {
  return queueSnapshot(filePath).jobs.filter((job) => (job.queue_status || 'pending') === 'pending');
}

export function getAutonomousPendingQueueStats(filePath) {
  const jobs = queueSnapshot(filePath).jobs;
  return {
    pending: jobs.filter((job) => (job.queue_status || 'pending') === 'pending').length,
    blocked: jobs.filter((job) => job.queue_status === 'blocked').length
  };
}

/** Add scan-confirmed postings before the scanner marks them seen. */
export async function mergeAutonomousPendingJobs(filePath, jobs) {
  return withPipelineLock(filePath, () => {
    const snapshot = queueSnapshot(filePath);
    const byUrl = new Map(snapshot.jobs.map((job) => [normalizeUrl(job.url), job]));
    for (const job of jobs) {
      if (!job || typeof job.url !== 'string' || job.verification_status !== 'active') {
        throw new Error('Only active, URL-addressable postings can enter the autonomous pending queue.');
      }
      const key = normalizeUrl(job.url);
      if (!key) throw new Error('Autonomous pending queue refused an invalid posting URL.');
      const existing = byUrl.get(key);
      if (existing) {
        assertSamePosting(existing, job);
        const merged = { ...existing };
        const asList = (value) => Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
        const union = (a, b, keyOf) => {
          const values = [...asList(a), ...asList(b)];
          const seen = new Set();
          return values.filter((value) => {
            const key = keyOf(value);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 20);
        };
        merged.discovered_via = union(existing.discovered_via, job.discovered_via, (value) => typeof value === 'string' ? value.trim() : '');
        merged.source_urls = union(existing.source_urls, job.source_urls, (value) => {
          if (typeof value !== 'string') return '';
          try {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
          } catch { return ''; }
        });
        merged.provider_ids = union(existing.provider_ids, job.provider_ids, (value) =>
          value && typeof value.provider === 'string' && typeof value.id === 'string'
            ? JSON.stringify([value.provider.slice(0, 100), value.id.slice(0, 200)]) : '');
        const resolvedAuthority = authoritativeProviderForUrl(job.url);
        if (resolvedAuthority) merged.authoritative_provider = resolvedAuthority;
        const incomingVerifiedAt = Date.parse(job.liveness_verified_at || '');
        const existingVerifiedAt = Date.parse(existing.liveness_verified_at || '');
        if (Number.isFinite(incomingVerifiedAt) && (!Number.isFinite(existingVerifiedAt) || incomingVerifiedAt > existingVerifiedAt)) {
          merged.liveness_verified_at = job.liveness_verified_at;
        }
        byUrl.set(key, merged);
        continue;
      }
      byUrl.set(key, {
        ...job,
        authoritative_provider: authoritativeProviderForUrl(job.url),
        queue_key: key, queue_status: 'pending', queued_at: new Date().toISOString()
      });
    }
    if (byUrl.size > MAX_AUTONOMOUS_PENDING_JOBS) {
      throw new Error(`Autonomous pending queue limit exceeded (${MAX_AUTONOMOUS_PENDING_JOBS}); refusing to drop postings.`);
    }
    const queuedAt = new Date().toISOString();
    const next = { version: QUEUE_VERSION, updated_at: queuedAt, jobs: [...byUrl.values()] };
    atomicWriteQueue(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next.jobs;
  });
}

export async function blockAutonomousPendingJob(filePath, url, reason) {
  const key = normalizeUrl(url);
  if (!key) throw new Error('Cannot block an invalid autonomous pending URL.');
  return withPipelineLock(filePath, () => {
    const snapshot = queueSnapshot(filePath);
    let changed = false;
    const jobs = snapshot.jobs.map((job) => {
      if (normalizeUrl(job.url) !== key) return job;
      changed = true;
      return { ...job, queue_status: 'blocked', blocked_reason: String(reason || 'recovery_required').slice(0, 500) };
    });
    if (!changed) return false;
    atomicWriteQueue(filePath, `${JSON.stringify({ ...snapshot, updated_at: new Date().toISOString(), jobs }, null, 2)}\n`);
    return true;
  });
}

export async function acknowledgeAutonomousPendingJob(filePath, url) {
  const key = normalizeUrl(url);
  if (!key) throw new Error('Cannot acknowledge an invalid autonomous pending URL.');
  return withPipelineLock(filePath, () => {
    const snapshot = queueSnapshot(filePath);
    const jobs = snapshot.jobs.filter((job) => normalizeUrl(job.url) !== key);
    if (jobs.length === snapshot.jobs.length) return jobs.length;
    const next = { ...snapshot, updated_at: new Date().toISOString(), jobs };
    atomicWriteQueue(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return jobs.length;
  });
}
