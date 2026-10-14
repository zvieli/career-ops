// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeUrl } from '../../../../url-key.mjs';

function normalizePart(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    : '';
}

function stableId(identityKey, basis) {
  const digest = createHash('sha256').update(identityKey, 'utf8').digest('hex').slice(0, 24);
  return {
    application_id: `app-${digest}`,
    identity_key: identityKey,
    identity_basis: basis,
    mergeable: true
  };
}

function aliasesFor(job) {
  const aliases = [];
  const company = normalizePart(job.company);
  const requisitionId = normalizePart(job.requisitionId);
  const provider = normalizePart(job.provider);
  const externalId = normalizePart(job.externalId);
  const url = normalizeUrl(job.url);
  if (company && requisitionId) aliases.push({ kind: 'requisition', company, value: requisitionId });
  if (company && provider && externalId) aliases.push({ kind: 'provider_external_id', company, value: `${provider}|${externalId}` });
  if (url) aliases.push({ kind: 'url', company, value: url });
  return aliases.map((alias) => ({
    ...alias,
    key: createHash('sha256').update(`${alias.kind}|${alias.company}|${alias.value}`, 'utf8').digest('hex')
  }));
}

/**
 * Build a stable application identity only from exact job evidence.
 * Unknown identities deliberately receive independent, non-mergeable IDs.
 * @param {{provider?:string,company?:string,requisitionId?:string,externalId?:string,url?:string}} job
 */
export function createApplicationIdentity(job = {}) {
  const company = normalizePart(job.company);
  const requisitionId = normalizePart(job.requisitionId);
  if (company && requisitionId) {
    return stableId(`requisition|${company}|${requisitionId}`, 'employer_requisition_id');
  }

  const provider = normalizePart(job.provider);
  const externalId = normalizePart(job.externalId);
  if (company && provider && externalId) {
    return stableId(`provider_external_id|${provider}|${company}|${externalId}`, 'provider_external_id');
  }

  const canonicalUrl = normalizeUrl(job.url);
  if (canonicalUrl) return stableId(`url|${canonicalUrl}`, 'canonical_url');

  return {
    application_id: `app-ambig-${randomUUID()}`,
    identity_key: null,
    identity_basis: 'ambiguous',
    mergeable: false
  };
}

function emptyRegistry() {
  return { version: 1, alias_to_application: {}, application_aliases: {} };
}

function loadRegistry(path) {
  if (!existsSync(path)) return emptyRegistry();
  let registry;
  try {
    registry = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Corrupted application identity registry at ${path}; refusing to merge identities.`, { cause: error });
  }
  if (registry?.version !== 1 || !registry.alias_to_application || !registry.application_aliases) {
    throw new Error(`Invalid application identity registry at ${path}; refusing to merge identities.`);
  }
  return registry;
}

function saveRegistry(path, registry) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function conflictsWithKnownAlias(existing, incoming) {
  if (existing.company && incoming.company && existing.company !== incoming.company) return true;
  if (existing.kind !== incoming.kind || existing.company !== incoming.company || existing.value === incoming.value) return false;
  if (existing.kind === 'requisition') return true;
  if (existing.kind === 'provider_external_id') {
    const [existingProvider] = existing.value.split('|');
    const [incomingProvider] = incoming.value.split('|');
    return existingProvider === incomingProvider;
  }
  return false;
}

/**
 * Reconcile only exact aliases observed on the same posting (requisition ID,
 * provider external ID, or normalized URL). No title/company fuzzy matching.
 */
export function resolveApplicationIdentity(job = {}, { dataRoot } = {}) {
  const primary = createApplicationIdentity(job);
  const aliases = aliasesFor(job);
  if (!aliases.length) return { ...primary, identity_aliases: [] };
  if (!dataRoot) throw new Error('dataRoot is required to persist exact application identity aliases');

  const path = join(dataRoot, 'data', 'application-identities.json');
  const registry = loadRegistry(path);
  const matchedIds = [...new Set(aliases.map((alias) => registry.alias_to_application[alias.key]).filter(Boolean))];
  if (matchedIds.length > 1) throw new Error('Application identity conflict: exact aliases point to different existing IDs.');

  let applicationId = matchedIds[0] || primary.application_id;
  if (matchedIds.length === 1) {
    const priorAliases = registry.application_aliases[applicationId] || [];
    if (aliases.some((incoming) => priorAliases.some((existing) => conflictsWithKnownAlias(existing, incoming)))) {
      throw new Error('Application identity conflict: requisition/provider identity disagrees with an exact URL alias.');
    }
  }

  const storedAliases = registry.application_aliases[applicationId] || [];
  for (const alias of aliases) {
    const existingId = registry.alias_to_application[alias.key];
    if (existingId && existingId !== applicationId) throw new Error('Application identity conflict: alias already belongs to another application ID.');
    registry.alias_to_application[alias.key] = applicationId;
    if (!storedAliases.some((item) => item.key === alias.key)) storedAliases.push(alias);
  }
  registry.application_aliases[applicationId] = storedAliases;
  saveRegistry(path, registry);

  return {
    ...primary,
    application_id: applicationId,
    identity_basis: applicationId === primary.application_id ? primary.identity_basis : 'reconciled_alias',
    identity_aliases: aliases.map((alias) => alias.key),
    mergeable: true
  };
}
