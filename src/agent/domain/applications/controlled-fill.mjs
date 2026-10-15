import { createHash } from 'node:crypto';
import { classifyCustomQuestion } from './ats-preparation.mjs';
import { isTrustedControlledFillController } from '../../infrastructure/browser/controlled-fill-browser.mjs';

const SAFE_TEXT_TYPES = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'URL']);
const BLOCKED_SEMANTICS = new Set([
  'WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'CITIZENSHIP', 'SECURITY_CLEARANCE', 'CRIMINAL_HISTORY',
  'DISABILITY', 'VETERAN_STATUS', 'GENDER', 'RACE', 'ETHNICITY', 'RELIGION', 'SEXUAL_ORIENTATION',
  'DEMOGRAPHICS', 'SALARY_EXPECTATION', 'NOTICE_PERIOD'
]);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const BLOCKED_LANGUAGE = /\b(agree|certif(?:y|ication)|attest|authori[sz]e|consent|terms|privacy|background check|truth(?:ful|fulness)|confirm(?:ation)?|work authori[sz]ation|sponsorship|demographic|eeo|gender|race|ethnicity|religion|religious|sexual orientation|sexuality|criminal history|criminal record|security clearance|citizenship|nationality|veteran|disability|relocat(?:e|ion)|notice period|salary commitment|ssn|social security|tax id|national id|passport|identity document|bank account|medical record|health information)\b/i;

export class ControlledFillReviewError extends Error {
  constructor(message, { status = 'APPLICATION_FILL_NEEDS_REVIEW', partialReceipt = null, securityMetrics = null } = {}) {
    super(message);
    this.name = 'ControlledFillReviewError';
    this.status = status;
    this.partialReceipt = partialReceipt;
    this.securityMetrics = securityMetrics;
  }
}

function assertFieldNotSensitive(field, mapping) {
  const label = `${field.label} ${field.name} ${field.group_label || ''}`;
  if (BLOCKED_SEMANTICS.has(mapping.semantic_type) || BLOCKED_SEMANTICS.has(field.semantic_type)
    || BLOCKED_LANGUAGE.test(label) || ['SENSITIVE', 'LEGAL_ATTESTATION'].includes(classifyCustomQuestion(label))) {
    throw new ControlledFillReviewError(`Browser guard blocked field ${field.id}: sensitive or legal field.`, { status: 'SENSITIVE_FIELD_BLOCKED' });
  }
}
function uniqueOption(field, value) {
  const normalized = String(value).trim().toLocaleLowerCase();
  const matches = field.options.filter((option) => [option.value, option.label].some((candidate) => String(candidate || '').trim().toLocaleLowerCase() === normalized));
  if (matches.length !== 1 || !matches[0].value) throw new ControlledFillReviewError(`Choice field ${field.id} has no unique live option match.`);
  return matches[0];
}
function makePartialReceipt(prepared, schema, filled, skipped, review, metrics, cvArtifact, uploadVerified) {
  const body = {
    application_id: prepared.application_id, provider: prepared.provider, application_url: prepared.application_url,
    fill_status: review.length || skipped.some((item) => ['NEEDS_REVIEW', 'UNSUPPORTED'].includes(item.status)) ? 'NEEDS_REVIEW' : 'FILLED',
    schema_hash_before: prepared.schema_hash, schema_hash_live: schema?.schema_hash || null,
    mapping_hash: hash(JSON.stringify(prepared.mappings.map(({ field_id, status, semantic_type, proposed_value }) => ({ field_id, status, semantic_type, value_hash: proposed_value == null ? null : hash(proposed_value) })))),
    cv_artifact_ref: cvArtifact?.artifactRef || null, cv_artifact_sha256: cvArtifact?.artifactSha256 || null,
    cv_fingerprint: cvArtifact?.cvFingerprint || null, jd_hash: cvArtifact?.jdHash || null,
    preparation_receipt_ref: cvArtifact?.preparationReceiptRef || null, preparation_receipt_sha256: cvArtifact?.preparationReceiptSha256 || null,
    upload_verified: uploadVerified, filled_fields: Object.freeze(filled), skipped_fields: Object.freeze(skipped),
    blocked_fields: Object.freeze(review.filter((item) => ['BLOCKED', 'SENSITIVE_FIELD_BLOCKED', 'LEGAL_ATTESTATION_BLOCKED', 'DO_NOT_ANSWER'].includes(item.status)).map(Object.freeze)),
    review_fields: Object.freeze(review.filter((item) => !['BLOCKED', 'SENSITIVE_FIELD_BLOCKED', 'LEGAL_ATTESTATION_BLOCKED', 'DO_NOT_ANSWER'].includes(item.status)).map(Object.freeze)),
    network_guard_status: metrics ? 'INTERLOCKED' : 'UNAVAILABLE',
    unexpected_navigation_events: metrics?.unexpected_navigation_events ?? null,
    blocked_submission_attempts: metrics?.blocked_submission_attempts ?? null,
    mutation_network_events: metrics?.mutation_network_events ?? null,
    blocked_network_requests: metrics?.blocked_network_requests ?? null,
    blocked_websocket_connections: metrics?.blocked_websocket_connections ?? null,
    popup_events: metrics?.popup_events ?? null,
    submission_performed: false, submit_capability: false
  };
  return Object.freeze({ ...body, receipt_hash: hash(JSON.stringify(body)) });
}

/** Fixture-only controlled fill. The accepted controller must be minted by the trusted browser module. */
export async function executeControlledFill({ authorization, prepared, controller, previousReceipt = null, cvArtifact = null } = {}) {
  if (authorization !== 'FILL_APPLICATION') throw new Error('Controlled fill requires explicit FILL_APPLICATION authorization.');
  if (!isTrustedControlledFillController(controller)) throw new Error('A trusted project-owned controlled browser controller is required.');
  if (!prepared || !['GREENHOUSE', 'LEVER'].includes(prepared.provider)
    || typeof prepared.application_id !== 'string' || typeof prepared.application_url !== 'string'
    || typeof prepared.schema_hash !== 'string' || !Array.isArray(prepared.mappings)) {
    throw new Error('Prepared application binding is incomplete or unsupported.');
  }
  const initial = await controller.inspect();
  if (initial.status !== 'READY') {
    const partialReceipt = makePartialReceipt(prepared, initial.schema, [], [], [{ field_id: null, status: initial.status, reason: 'Manual step required before mutation.' }], controller.getMetrics(), cvArtifact, false);
    throw new ControlledFillReviewError(`Manual step required: ${initial.status}.`, { status: initial.status, partialReceipt });
  }
  if (initial.provider !== prepared.provider || initial.url !== prepared.application_url
    || initial.schema.schema_hash !== prepared.schema_hash || initial.schema.source_url !== prepared.application_url) {
    const partialReceipt = makePartialReceipt(prepared, initial.schema, [], [], [{ field_id: null, status: 'SCHEMA_DRIFT', reason: 'Target or schema differs from preparation.' }], controller.getMetrics(), cvArtifact, false);
    throw new ControlledFillReviewError('Application target or schema drift detected; no field mutation is allowed.', { status: 'SCHEMA_DRIFT', partialReceipt });
  }
  const fields = new Map(initial.schema.fields.map((field) => [field.id, field]));
  const durableProgress = await controller.getProgress();
  const previous = new Map((previousReceipt?.filled_fields || []).map((entry) => [entry.field_id, entry]));
  for (const item of durableProgress) previous.set(item.field_id, item);
  const filled = [];
  const skipped = [];
  const review = [];
  let uploadVerified = false;
  let inFlightMutation = null;
  try {
    for (const mapping of prepared.mappings) {
      if (mapping.status !== 'READY') {
        const status = mapping.status || 'NEEDS_REVIEW';
        if (status === 'DO_NOT_ANSWER') review.push({ field_id: mapping.field_id, status: 'BLOCKED', reason: 'Field policy forbids automated response.' });
        else if (status === 'NEEDS_REVIEW' || status === 'UNSUPPORTED') review.push({ field_id: mapping.field_id, status, reason: 'Field requires manual review.' });
        else skipped.push(Object.freeze({ field_id: mapping.field_id, status }));
        continue;
      }
      const field = fields.get(mapping.field_id);
      if (!field || field.visible === false || field.disabled) throw new ControlledFillReviewError('Prepared field identity no longer matches a visible enabled live field.', { status: 'SCHEMA_DRIFT' });
      assertFieldNotSensitive(field, mapping);
      const prior = previous.get(field.id);
      if (field.type === 'FILE' && field.semantic_type === 'RESUME') {
        if (mapping.proposed_value !== 'CV_VALIDATED_ARTIFACT' || !cvArtifact) throw new ControlledFillReviewError('Exact CV_VALIDATED artifact binding is required for resume upload.', { status: 'CV_ARTIFACT_REQUIRED' });
        const current = await controller.readField({ fieldId: field.id });
        if (prior?.status === 'NEEDS_REVIEW') throw new ControlledFillReviewError('Prior upload progress is uncertain; manual review required.');
        if (prior?.status === 'MUTATION_STARTED' && !current.length) throw new ControlledFillReviewError('Upload may have been interrupted; refusing an uncertain replay.', { status: 'PARTIAL_MUTATION_UNCERTAIN' });
        if (prior?.status === 'UPLOAD_VERIFIED') {
          if (prior.expected_value_hash !== cvArtifact.artifactSha256 || current.length !== 1 || current[0].name !== cvArtifact.filename || current[0].size !== cvArtifact.size || current[0].sha256 !== cvArtifact.artifactSha256) throw new ControlledFillReviewError('Previously verified resume attachment changed; manual review required.');
          uploadVerified = true;
        } else if (current.length) {
          if (current.length !== 1 || current[0].name !== cvArtifact.filename || current[0].size !== cvArtifact.size || current[0].sha256 !== cvArtifact.artifactSha256) throw new ControlledFillReviewError('A different resume is already attached; refusing to replace it.');
          uploadVerified = true;
          await controller.recordProgress({ field_id: field.id, status: 'UPLOAD_VERIFIED', expected_value_hash: cvArtifact.artifactSha256 });
        } else {
          inFlightMutation = { field_id: field.id, expected_value_hash: cvArtifact.artifactSha256 };
          await controller.recordProgress({ field_id: field.id, status: 'MUTATION_STARTED', expected_value_hash: cvArtifact.artifactSha256 });
          const attached = await controller.attachValidatedFile({ fieldId: field.id, ...cvArtifact });
          if (!attached.verified || attached.artifact_sha256 !== cvArtifact.artifactSha256) throw new ControlledFillReviewError('Resume attachment verification failed.');
          uploadVerified = true;
          await controller.recordProgress({ field_id: field.id, status: 'UPLOAD_VERIFIED', expected_value_hash: cvArtifact.artifactSha256 });
        }
        filled.push(Object.freeze({ field_id: field.id, semantic_type: field.semantic_type, expected_value_hash: cvArtifact.artifactSha256, actual_status: 'UPLOAD_VERIFIED', verification: 'MATCH', artifact_ref: cvArtifact.artifactRef }));
      } else {
        const actual = await controller.readField({ fieldId: field.id });
        let expected;
        let type;
        if (SAFE_TEXT_TYPES.has(field.type)) {
          if (typeof mapping.proposed_value !== 'string') throw new ControlledFillReviewError(`Text field ${field.id} lacks a prepared string value.`);
          expected = mapping.proposed_value;
          type = 'text';
        } else if (['SELECT', 'RADIO'].includes(field.type)) {
          expected = uniqueOption(field, mapping.proposed_value).value;
          type = 'choice';
        } else if (field.type === 'CHECKBOX') {
          if (typeof mapping.proposed_value !== 'boolean') throw new ControlledFillReviewError(`Checkbox ${field.id} requires a prepared boolean state.`);
          expected = mapping.proposed_value;
          type = 'checkbox';
        } else {
          throw new ControlledFillReviewError(`Unsupported widget type ${field.type}; manual review required.`);
        }
        const expectedHash = hash(expected);
        let actualStatus = 'FILLED';
        if (prior?.status === 'NEEDS_REVIEW') throw new ControlledFillReviewError(`Field ${field.id} has prior uncertain mutation evidence; manual review required.`);
        if (prior?.status === 'MUTATED_AND_VERIFIED' || prior?.status === 'MATCHED_BEFORE_FILL' || prior?.status === 'USER_MODIFIED' || prior?.status === 'MUTATION_STARTED') {
          if (prior.expected_value_hash !== expectedHash) throw new ControlledFillReviewError(`Prepared value for ${field.id} changed after durable fill progress.`);
          const actualMatches = type === 'text' ? actual === expected : type === 'choice' ? actual.value === expected : actual.checked === expected;
          if (!actualMatches) throw new ControlledFillReviewError(`Field ${field.id} changed after mutation progress; review required.`, { status: prior.status === 'MUTATION_STARTED' ? 'PARTIAL_MUTATION_UNCERTAIN' : 'USER_MODIFIED' });
          if (prior.status === 'MUTATION_STARTED') await controller.recordProgress({ field_id: field.id, status: 'MUTATED_AND_VERIFIED', expected_value_hash: expectedHash });
          if (prior.status === 'MATCHED_BEFORE_FILL') actualStatus = 'PREEXISTING_MATCH';
        } else {
          const actualMatches = type === 'text' ? actual === expected : type === 'choice' ? actual.value === expected : actual.checked === expected;
          if (!actualMatches) {
            const hasValue = type === 'text' ? Boolean(actual) : type === 'choice' ? Boolean(actual.value) : actual.checked === true;
            if (hasValue) throw new ControlledFillReviewError(`Field ${field.id} contains user-entered data; refusing to overwrite.` , { status: 'USER_MODIFIED' });
            inFlightMutation = { field_id: field.id, expected_value_hash: expectedHash };
            await controller.recordProgress({ field_id: field.id, status: 'MUTATION_STARTED', expected_value_hash: expectedHash });
            if (type === 'text') await controller.setTextField({ fieldId: field.id, value: expected });
            else if (type === 'choice') await controller.setChoice({ fieldId: field.id, value: expected });
            else await controller.setCheckboxState({ fieldId: field.id, checked: expected });
          } else {
            actualStatus = 'PREEXISTING_MATCH';
            await controller.recordProgress({ field_id: field.id, status: 'MATCHED_BEFORE_FILL', expected_value_hash: expectedHash });
          }
          const verified = await controller.readField({ fieldId: field.id });
          const verifiedMatches = type === 'text' ? verified === expected : type === 'choice' ? verified.value === expected : verified.checked === expected;
          if (!verifiedMatches) throw new ControlledFillReviewError(`DOM read-back verification failed for ${field.id}.`);
          if (actualStatus !== 'PREEXISTING_MATCH') await controller.recordProgress({ field_id: field.id, status: 'MUTATED_AND_VERIFIED', expected_value_hash: expectedHash });
        }
        filled.push(Object.freeze({ field_id: field.id, semantic_type: field.semantic_type, expected_value_hash: expectedHash, actual_status: actualStatus, verification: 'MATCH' }));
      }
      const fresh = await controller.inspect();
      if (fresh.status !== 'READY' || fresh.schema.schema_hash !== prepared.schema_hash) throw new ControlledFillReviewError('Conditional form/schema change detected after a mutation; new fields were not filled.', { status: 'CONDITIONAL_FORM_CHANGE' });
      const guard = await controller.assertNoSubmission();
      if (guard.unexpected_navigation_events || guard.blocked_submission_attempts || guard.mutation_network_events || guard.blocked_websocket_connections) throw new ControlledFillReviewError('Security interlock detected forbidden browser behavior.', { status: 'SECURITY_FAILURE', securityMetrics: guard });
      inFlightMutation = null;
    }
  } catch (error) {
    const metrics = controller.getMetrics();
    if (inFlightMutation) {
      try { await controller.recordProgress({ ...inFlightMutation, status: 'NEEDS_REVIEW' }); } catch {}
    }
    const status = error?.status || (error?.securityMetrics ? 'SECURITY_FAILURE' : 'FILL_OPERATION_FAILED');
    const reason = error instanceof Error ? error.message.slice(0, 500) : 'Unknown controlled-fill failure.';
    review.push({ field_id: null, status, reason });
    const partialReceipt = makePartialReceipt(prepared, initial.schema, filled, skipped, review, metrics, cvArtifact, uploadVerified);
    if (error instanceof ControlledFillReviewError) { error.partialReceipt = partialReceipt; throw error; }
    throw new ControlledFillReviewError(reason, { status, partialReceipt, securityMetrics: metrics });
  }
  let metrics;
  try { metrics = await controller.assertNoSubmission(); }
  catch (error) {
    metrics = error?.securityMetrics || controller.getMetrics();
    review.push({ field_id: null, status: error?.status || 'SECURITY_FAILURE', reason: error instanceof Error ? error.message.slice(0, 500) : 'Security interlock failed.' });
    throw new ControlledFillReviewError('Security interlock detected forbidden browser behavior.', { status: 'SECURITY_FAILURE', partialReceipt: makePartialReceipt(prepared, initial.schema, filled, skipped, review, metrics, cvArtifact, uploadVerified), securityMetrics: metrics });
  }
  if (metrics.unexpected_navigation_events || metrics.blocked_submission_attempts || metrics.mutation_network_events || metrics.blocked_websocket_connections) {
    review.push({ field_id: null, status: 'SECURITY_FAILURE', reason: 'A forbidden browser behavior was detected.' });
    throw new ControlledFillReviewError('Security interlock detected forbidden browser behavior.', { status: 'SECURITY_FAILURE', partialReceipt: makePartialReceipt(prepared, initial.schema, filled, skipped, review, metrics, cvArtifact, uploadVerified), securityMetrics: metrics });
  }
  return makePartialReceipt(prepared, initial.schema, filled, skipped, review, metrics, cvArtifact, uploadVerified);
}
