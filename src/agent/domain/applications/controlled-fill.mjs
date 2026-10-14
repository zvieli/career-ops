import { createHash } from 'node:crypto';
import { classifyCustomQuestion } from './ats-preparation.mjs';

const SAFE_VALUE_TYPES = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'URL']);
const BLOCKED_SEMANTICS = new Set([
  'WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'CITIZENSHIP', 'SECURITY_CLEARANCE', 'CRIMINAL_HISTORY',
  'DISABILITY', 'VETERAN_STATUS', 'GENDER', 'RACE', 'ETHNICITY', 'RELIGION', 'SEXUAL_ORIENTATION',
  'DEMOGRAPHICS', 'SALARY_EXPECTATION', 'NOTICE_PERIOD'
]);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');

/**
 * Execute only an explicitly authorized, fixture-capable field-fill adapter.
 * Adapter contract deliberately exposes inspection, field fill, and read-back;
 * it has no click, keyboard, navigation, upload, or submit operation.
 * This domain function is not a live ATS adapter and does not authorize one.
 */
export async function executeControlledFill({ authorization, prepared, adapter, previousReceipt = null } = {}) {
  if (authorization !== 'FILL_APPLICATION') throw new Error('Controlled fill requires explicit FILL_APPLICATION authorization.');
  if (!prepared || !['GREENHOUSE', 'LEVER'].includes(prepared.provider)
    || typeof prepared.application_id !== 'string' || typeof prepared.application_url !== 'string'
    || typeof prepared.schema_hash !== 'string' || !Array.isArray(prepared.mappings)) {
    throw new Error('Prepared application binding is incomplete or unsupported.');
  }
  if (!adapter || adapter.mode !== 'FIXTURE_TEST' || adapter.provider !== prepared.provider
    || typeof adapter.inspectApplication !== 'function' || typeof adapter.fillField !== 'function'
    || typeof adapter.readField !== 'function'
    || Object.keys(adapter).some((key) => !['mode', 'provider', 'inspectApplication', 'fillField', 'readField'].includes(key))) {
    throw new Error('Controlled fill requires a matching FIXTURE_TEST adapter exposing only inspectApplication, fillField, and readField.');
  }
  const live = await adapter.inspectApplication({ provider: prepared.provider, url: prepared.application_url });
  if (live?.provider !== prepared.provider || live?.url !== prepared.application_url || !live.schema) {
    throw new Error('Live application target changed; schema drift requires review.');
  }
  if (live.schema.schema_hash !== prepared.schema_hash || live.schema.source_url !== prepared.application_url) {
    throw new Error('Application schema drift detected; no fields were mutated.');
  }
  const byId = new Map();
  for (const field of live.schema.fields) {
    if (!field.id || byId.has(field.id)) throw new Error('Ambiguous live field identity requires review.');
    byId.set(field.id, field);
  }
  const previous = new Map((previousReceipt?.filled_fields || []).map((item) => [item.field_id, item]));
  const filled = [];
  const skipped = [];
  for (const mapping of prepared.mappings) {
    if (mapping.status !== 'READY') { skipped.push(Object.freeze({ field_id: mapping.field_id, status: mapping.status || 'NEEDS_REVIEW' })); continue; }
    const field = byId.get(mapping.field_id);
    if (!field || field.visible === false || field.disabled) throw new Error('Prepared field identity no longer matches a visible enabled live field.');
    const sensitive = BLOCKED_SEMANTICS.has(mapping.semantic_type) || BLOCKED_SEMANTICS.has(field.semantic_type)
      || ['SENSITIVE', 'LEGAL_ATTESTATION'].includes(classifyCustomQuestion(`${field.label} ${field.name} ${field.group_label || ''}`));
    if (sensitive) throw new Error(`Browser guard blocked field ${field.id}: sensitive or legal field.`);
    if (!SAFE_VALUE_TYPES.has(field.type) || ['SELECT', 'RADIO', 'CHECKBOX', 'FILE'].includes(field.type)) {
      throw new Error(`Unsupported field type for controlled fill: ${field.type}.`);
    }
    if (typeof mapping.proposed_value !== 'string' || !mapping.proposed_value) throw new Error('READY mapping has no prepared value.');
    const current = await adapter.readField({ fieldId: field.id });
    const expectedHash = hash(mapping.proposed_value);
    const prior = previous.get(field.id);
    if (current !== '' && current !== null && current !== undefined && current !== mapping.proposed_value) {
      throw new Error(`Field ${field.id} contains a user-modified value; refusing to overwrite user input.`);
    }
    if (prior && prior.expected_value_hash !== expectedHash) {
      throw new Error(`Prepared value for field ${field.id} changed since the prior fill; review is required.`);
    }
    if (prior && current !== mapping.proposed_value && hash(current) !== prior.expected_value_hash) {
      throw new Error(`Field ${field.id} appears user-modified; refusing to overwrite silently.`);
    }
    if (current !== mapping.proposed_value) {
      await adapter.fillField({ fieldId: field.id, value: mapping.proposed_value });
    }
    const actual = await adapter.readField({ fieldId: field.id });
    if (actual !== mapping.proposed_value) throw new Error(`DOM read-back verification failed for field ${field.id}.`);
    filled.push(Object.freeze({ field_id: field.id, semantic_type: mapping.semantic_type, expected_value_hash: expectedHash, actual_status: 'FILLED', verification: 'MATCH' }));
  }
  const body = {
    application_id: prepared.application_id, provider: prepared.provider, application_url: prepared.application_url,
    schema_hash_before: prepared.schema_hash, schema_hash_live: live.schema.schema_hash,
    mapping_hash: hash(JSON.stringify(prepared.mappings.map(({ field_id, status, semantic_type, proposed_value }) => ({ field_id, status, semantic_type, proposed_value_hash: proposed_value == null ? null : hash(proposed_value) })))),
    filled_fields: Object.freeze(filled), skipped_fields: Object.freeze(skipped), timestamp: new Date().toISOString(),
    submission_performed: false, submit_capability: false
  };
  return Object.freeze({ ...body, receipt_hash: hash(JSON.stringify(body)) });
}
