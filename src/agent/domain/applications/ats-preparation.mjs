import { createHash } from 'node:crypto';

export const ATS_FIELD_TYPES = Object.freeze(['TEXT', 'TEXTAREA', 'SELECT', 'RADIO', 'CHECKBOX', 'FILE', 'EMAIL', 'PHONE', 'URL']);
export const ATS_SEMANTIC_TYPES = Object.freeze([
  'FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'LOCATION', 'LINKEDIN_URL', 'GITHUB_URL',
  'PORTFOLIO_URL', 'RESUME', 'EDUCATION', 'DEGREE', 'GRADUATION_YEAR', 'GPA', 'WORK_AUTHORIZATION',
  'VISA_SPONSORSHIP', 'YEARS_EXPERIENCE', 'SALARY_EXPECTATION', 'NOTICE_PERIOD', 'CUSTOM_QUESTION', 'UNKNOWN'
]);
export const MAPPING_STATUSES = Object.freeze(['READY', 'NEEDS_REVIEW', 'UNSUPPORTED', 'DO_NOT_ANSWER']);

const PROVIDER_HOSTS = Object.freeze({
  GREENHOUSE: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  LEVER: ['jobs.lever.co'],
  ASHBY: ['jobs.ashbyhq.com'],
  WORKABLE: ['apply.workable.com'],
  SMARTRECRUITERS: ['jobs.smartrecruiters.com']
});
const CONTROL_TYPES = Object.freeze({ text: 'TEXT', search: 'TEXT', textarea: 'TEXTAREA', select: 'SELECT', radio: 'RADIO', checkbox: 'CHECKBOX', file: 'FILE', email: 'EMAIL', tel: 'PHONE', url: 'URL' });

export function detectAtsProvider(value, metadataProvider = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return { provider: 'UNSUPPORTED', status: 'ATS_UNSUPPORTED', reason: 'untrusted_application_url' };
    const hostname = url.hostname.toLowerCase();
    for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) {
      if (hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return { provider, status: 'DETECTED', source: 'trusted_url_host' };
    }
    if (metadataProvider && /^[a-z][a-z0-9_-]{1,30}$/i.test(metadataProvider)) {
      return { provider: 'UNSUPPORTED', status: 'ATS_UNSUPPORTED', claimed_provider: metadataProvider.toUpperCase(), reason: 'provider_metadata_is_not_proof_of_supported_form_adapter' };
    }
    return { provider: 'UNSUPPORTED', status: 'ATS_UNSUPPORTED', reason: 'provider_not_recognized' };
  } catch {
    return { provider: 'UNSUPPORTED', status: 'ATS_UNSUPPORTED', reason: 'invalid_application_url' };
  }
}

export function semanticTypeFor(label = '', name = '') {
  const text = `${label} ${name}`.toLowerCase().replace(/[\s_-]+/g, ' ');
  // Specific sensitive concepts precede broad identity/profile concepts.
  if (/\b(authorized to work|work authorization|legally eligible|visa|sponsorship|sponsor(ed|ship)?)\b/.test(text)) return 'WORK_AUTHORIZATION';
  if (/\b(salary|compensation|pay expectation|desired pay)\b/.test(text)) return 'SALARY_EXPECTATION';
  if (/\b(notice period|availability date|start date)\b/.test(text)) return 'NOTICE_PERIOD';
  if (/\b(years? of (professional )?experience|professional yoe)\b/.test(text)) return 'YEARS_EXPERIENCE';
  if (/\b(gpa|grade point average)\b/.test(text)) return 'GPA';
  if (/\b(graduation year|year of graduation)\b/.test(text)) return 'GRADUATION_YEAR';
  if (/\b(resume|cv|curriculum vitae)\b/.test(text)) return 'RESUME';
  if (/\b(linkedin)\b/.test(text)) return 'LINKEDIN_URL';
  if (/\b(github)\b/.test(text)) return 'GITHUB_URL';
  if (/\b(portfolio|personal website|website|url)\b/.test(text)) return 'PORTFOLIO_URL';
  if (/\b(email|e mail)\b/.test(text)) return 'EMAIL';
  if (/\b(phone|mobile|telephone)\b/.test(text)) return 'PHONE';
  if (/\b(first name|given name)\b/.test(text)) return 'FIRST_NAME';
  if (/\b(last name|family name|surname)\b/.test(text)) return 'LAST_NAME';
  if (/\b(full name|your name)\b/.test(text)) return 'FULL_NAME';
  if (/\b(location|city|country|state|province)\b/.test(text)) return 'LOCATION';
  if (/\b(degree|education|university|school)\b/.test(text)) return 'EDUCATION';
  return label || name ? 'CUSTOM_QUESTION' : 'UNKNOWN';
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Normalize a trusted read-only DOM snapshot. Page strings are data and never instructions. */
export function extractApplicationFormSchema({ provider, sourceUrl, fields, source = 'read_only_dom' } = {}) {
  if (!Object.hasOwn(PROVIDER_HOSTS, provider)) throw new Error('Form schema extraction requires a deterministically detected ATS provider.');
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:' || !Array.isArray(fields)) throw new Error('Read-only form snapshot is invalid.');
  const normalized = fields.map((field, index) => {
    const rawType = String(field.type || '').toLowerCase();
    const type = CONTROL_TYPES[rawType];
    const label = String(field.label || '').trim().slice(0, 500);
    const name = String(field.name || '').trim().slice(0, 200);
    const options = Array.isArray(field.options) ? field.options.map((option) => ({
      label: String(option.label || '').trim().slice(0, 300), value: String(option.value || '').slice(0, 300)
    })) : [];
    return {
      id: String(field.id || name || `field-${index}`).slice(0, 200), name,
      type: type || 'UNSUPPORTED', label, required: field.required === true,
      semantic_type: semanticTypeFor(label, name), source, confidence: type ? 1 : 0,
      options: type === 'SELECT' || type === 'RADIO' || type === 'CHECKBOX' ? options : [],
      visible: field.visible !== false, disabled: field.disabled === true
    };
  });
  const schemaCore = { provider, source_url: parsed.href, fields: normalized };
  const schemaHash = hash(JSON.stringify(schemaCore));
  return Object.freeze({ ...schemaCore, schema_hash: schemaHash, field_count: normalized.length, extraction_status: 'EXTRACTED' });
}

function provenance(source, evidence, confidence = 1) {
  return { source, evidence: String(evidence || '').slice(0, 160), confidence };
}

export function mapApplicationFields(schema, candidateFacts = {}) {
  return schema.fields.map((field) => {
    const base = { field_id: field.id, semantic_type: field.semantic_type, proposed_value: null, provenance: provenance('not_proposed', 'No candidate value is proposed'), confidence: 0, status: 'NEEDS_REVIEW' };
    if (field.type === 'UNSUPPORTED' || field.semantic_type === 'UNKNOWN') return { ...base, status: 'UNSUPPORTED' };
    if (field.visible === false || field.disabled === true) return { ...base, status: 'DO_NOT_ANSWER', provenance: provenance('form_control_state', 'Hidden or disabled controls are never populated') };
    const questionClass = classifyCustomQuestion(`${field.label} ${field.name}`);
    if (questionClass === 'SENSITIVE' || questionClass === 'LEGAL_ATTESTATION') {
      return { ...base, status: 'DO_NOT_ANSWER', provenance: provenance('human_confirmation_required', questionClass) };
    }
    if (field.semantic_type === 'RESUME') return { ...base, status: 'NEEDS_REVIEW', provenance: provenance('validated_application_artifact_required', 'CV_VALIDATED PDF binding required') };
    if (['WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'SALARY_EXPECTATION', 'NOTICE_PERIOD'].includes(field.semantic_type)) {
      return { ...base, status: 'DO_NOT_ANSWER', provenance: provenance('human_confirmation_required', 'Sensitive/legal or unverified personal fact') };
    }
    const facts = candidateFacts.facts || candidateFacts;
    const get = (...keys) => keys.map((key) => facts[key]).find((item) => item !== undefined && item !== null && item !== '');
    let value; let source;
    switch (field.semantic_type) {
      case 'EMAIL': value = get('email'); source = 'config/profile.yml:candidate.email'; break;
      case 'PHONE': value = get('phone'); source = 'config/profile.yml:candidate.phone'; break;
      case 'LINKEDIN_URL': value = get('linkedin_url', 'linkedin'); source = 'config/profile.yml:candidate.linkedin'; break;
      case 'GITHUB_URL': value = get('github_url', 'github'); source = 'config/profile.yml:candidate.github'; break;
      case 'PORTFOLIO_URL': value = get('portfolio_url', 'website', 'portfolio'); source = 'config/profile.yml:candidate.website'; break;
      case 'FULL_NAME': value = get('full_name', 'name'); source = facts.full_name_source || 'config/profile.yml:candidate.full_name'; break;
      case 'FIRST_NAME': value = get('first_name'); source = facts.first_name_source || 'config/profile.yml:candidate.first_name'; break;
      case 'LAST_NAME': value = get('last_name'); source = facts.last_name_source || 'config/profile.yml:candidate.last_name'; break;
      case 'YEARS_EXPERIENCE':
        value = facts.professional_yoe_verified === true && Number.isFinite(facts.professional_yoe_years) ? facts.professional_yoe_years : undefined;
        source = 'config/profile.yml:candidate.professional_yoe_years (verified professional employment only)'; break;
      case 'GPA': {
        value = get('gpa_value', 'gpa'); source = facts.gpa_source || 'canonical candidate education evidence';
        const requestedScale = /\b4(?:\.0)?\b/.test(field.label) ? '4.0' : /\b5(?:\.0)?\b/.test(field.label) ? '5.0' : /\b100(?:[- ]point)?\b|percentage/i.test(field.label) ? '100-point' : null;
        const sourceScale = String(facts.gpa_scale || '').toLowerCase();
        const knownSourceScale = sourceScale.includes('4.0') ? '4.0' : sourceScale.includes('5.0') ? '5.0'
          : /100|percentage|percent/.test(sourceScale) ? '100-point' : null;
        const requestsScale = requestedScale !== null || /scale|denominator|out of|on a/i.test(field.label);
        if (value !== undefined && (requestsScale && (!requestedScale || !knownSourceScale || requestedScale !== knownSourceScale))) value = undefined;
        break;
      }
      case 'EDUCATION': case 'DEGREE': value = get('degrees', 'education'); source = facts.degrees_source || 'canonical candidate education evidence'; break;
      case 'LOCATION': value = get('location'); source = 'config/profile.yml:candidate.location'; break;
      default: return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance('not_inferred', 'Custom question requires human review') };
    }
    if (value === undefined) return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance('canonical_fact_absent_or_insufficient', 'No supported candidate fact; no inference made') };
    if (Array.isArray(value)) value = value.join(', ');
    if (['SELECT', 'RADIO', 'CHECKBOX'].includes(field.type)) {
      const matches = field.options.filter((option) => option.value.toLowerCase() === String(value).toLowerCase()
        || option.label.toLowerCase() === String(value).toLowerCase());
      if (matches.length !== 1 || !matches[0].value) return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance('form_options_do_not_match_fact', 'No unique exact ATS option for canonical fact') };
      value = matches[0].value;
    }
    return { ...base, proposed_value: String(value), provenance: provenance(source, 'Explicit canonical candidate evidence'), confidence: 1, status: 'READY' };
  });
}

export function classifyCustomQuestion(label = '') {
  const semantic = semanticTypeFor(label);
  if (['WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'SALARY_EXPECTATION', 'NOTICE_PERIOD'].includes(semantic)
    || /\b(legal|attest|certify|clearance|citizenship|military|gender|race|ethnicity|disability|veteran)\b/i.test(label)) return 'SENSITIVE';
  if (/\b(i agree|i certify|i attest|consent|authorize|terms and conditions)\b/i.test(label)) return 'LEGAL_ATTESTATION';
  if (semantic !== 'CUSTOM_QUESTION' && semantic !== 'UNKNOWN') return 'DETERMINISTIC_FACT';
  return 'UNKNOWN';
}

export function assertApplicationScopedArtifact(reference, applicationId) {
  if (typeof reference !== 'string' || reference.startsWith('/') || reference.includes('\\') || reference.split('/').length !== 2
    || reference.split('/')[0] !== applicationId || reference.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Artifact reference must remain within the selected application artifact store.');
  }
  return reference;
}

export function createPreparationReceipt({ applicationId, provider, schema, mappings, pdfSha256, jdHash, cvFingerprint, schemaArtifactRef, schemaArtifactSha256, schemaChanged = false }) {
  const summarize = (status) => mappings.filter((item) => item.status === status).map((item) => item.field_id);
  const body = {
    application_id: applicationId, ats_provider: provider, form_schema_hash: schema.schema_hash,
    form_schema_artifact_ref: schemaArtifactRef, form_schema_artifact_sha256: schemaArtifactSha256,
    extraction_status: schema.extraction_status, schema_changed_since_extraction: schemaChanged,
    preparation_blockers: [
      ...(schema.extraction_status === 'EXTRACTED' ? [] : [schema.extraction_status === 'ATS_UNSUPPORTED' ? 'ATS provider is unsupported; no form interaction was attempted.' : 'No approved live read-only adapter is available; fixture adapters are test-only.']),
      ...(schemaChanged ? ['Form schema changed; fields were remapped deterministically and require human review.'] : [])
    ],
    mapping_hash: hash(JSON.stringify(mappings)), cv_pdf_hash: pdfSha256, jd_hash: jdHash,
    cv_fingerprint: cvFingerprint, ready_fields: summarize('READY'), review_fields: summarize('NEEDS_REVIEW'),
    unsupported_fields: summarize('UNSUPPORTED'), do_not_answer_fields: summarize('DO_NOT_ANSWER'),
    submission_performed: false, submit_capability: false
  };
  return Object.freeze({ ...body, receipt_hash: hash(JSON.stringify(body)) });
}
