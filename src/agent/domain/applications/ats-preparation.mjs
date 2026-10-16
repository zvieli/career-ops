import { createHash } from 'node:crypto';

export const ATS_FIELD_TYPES = Object.freeze(['TEXT', 'TEXTAREA', 'SELECT', 'RADIO', 'CHECKBOX', 'FILE', 'EMAIL', 'PHONE', 'URL']);
export const ATS_SEMANTIC_TYPES = Object.freeze([
  'FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'LOCATION', 'LINKEDIN_URL', 'GITHUB_URL',
  'PORTFOLIO_URL', 'RESUME', 'EDUCATION', 'DEGREE', 'GRADUATION_YEAR', 'GPA', 'WORK_AUTHORIZATION',
  'VISA_SPONSORSHIP', 'YEARS_EXPERIENCE', 'SPECIFIC_EXPERIENCE_YEARS', 'EDUCATIONAL_INSTITUTION', 'FIELD_OF_STUDY', 'SALARY_EXPECTATION', 'NOTICE_PERIOD', 'CUSTOM_QUESTION', 'UNKNOWN'
]);
export const MAPPING_STATUSES = Object.freeze(['READY', 'NEEDS_REVIEW', 'UNSUPPORTED', 'DO_NOT_ANSWER']);

export const ATS_PROVIDER_CAPABILITIES = Object.freeze({
  GREENHOUSE: Object.freeze({ hostRecognized: true, fixtureTested: true, liveExtractionSupported: false }),
  LEVER: Object.freeze({ hostRecognized: true, fixtureTested: true, liveExtractionSupported: false }),
  ASHBY: Object.freeze({ hostRecognized: true, fixtureTested: false, liveExtractionSupported: false }),
  WORKABLE: Object.freeze({ hostRecognized: true, fixtureTested: false, liveExtractionSupported: false }),
  SMARTRECRUITERS: Object.freeze({ hostRecognized: true, fixtureTested: false, liveExtractionSupported: false })
});
const PROVIDER_HOSTS = Object.freeze({
  GREENHOUSE: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  LEVER: ['jobs.lever.co'], ASHBY: ['jobs.ashbyhq.com'], WORKABLE: ['apply.workable.com'],
  SMARTRECRUITERS: ['jobs.smartrecruiters.com']
});
const CONTROL_TYPES = Object.freeze({ text: 'TEXT', search: 'TEXT', textarea: 'TEXTAREA', select: 'SELECT', radio: 'RADIO', checkbox: 'CHECKBOX', file: 'FILE', email: 'EMAIL', tel: 'PHONE', url: 'URL' });

export function getAtsProviderCapability(provider) {
  return ATS_PROVIDER_CAPABILITIES[provider] || Object.freeze({ hostRecognized: false, fixtureTested: false, liveExtractionSupported: false });
}

export function detectAtsProvider(value, metadataProvider = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return { provider: 'UNSUPPORTED', status: 'ATS_UNSUPPORTED', reason: 'untrusted_application_url' };
    const hostname = url.hostname.toLowerCase();
    for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) {
      if (hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
        return { provider, status: 'HOST_RECOGNIZED', source: 'trusted_url_host', capability: getAtsProviderCapability(provider) };
      }
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
  const sponsorship = /\b(visa|sponsorship|sponsor(?:ed|ship)?)\b/.test(text);
  const workAuthorization = /\b(authorized to work|work authorization|legally eligible|eligible to work)\b/.test(text);
  // A compound prompt is not silently assigned one of its two distinct legal meanings.
  if (sponsorship && workAuthorization) return 'CUSTOM_QUESTION';
  if (sponsorship) return 'VISA_SPONSORSHIP';
  if (workAuthorization) return 'WORK_AUTHORIZATION';
  if (/\b(salary|compensation|pay expectation|desired pay)\b/.test(text)) return 'SALARY_EXPECTATION';
  if (/\b(notice period|availability date|start date)\b/.test(text)) return 'NOTICE_PERIOD';
  const generalYearsPrompt = /\byears? of (?:professional )?experience\b/.test(text) || /\bprofessional yoe\b/.test(text);
  if (generalYearsPrompt && /\bexperience (?:with|in|using|as|at|for)\b/.test(text)) return 'SPECIFIC_EXPERIENCE_YEARS';
  if (generalYearsPrompt && /\bexperience\s*\(\s*[^)]+\)/.test(text)) return 'SPECIFIC_EXPERIENCE_YEARS';
  if (/\byears? of (?!professional\b)[a-z0-9+.#-]+ experience\b/.test(text)) return 'SPECIFIC_EXPERIENCE_YEARS';
  if (generalYearsPrompt) return 'YEARS_EXPERIENCE';
  if (/\b(gpa|grade point average)\b/.test(text)) return 'GPA';
  if (/\b(graduation year|year of graduation|year graduated)\b/.test(text)) return 'GRADUATION_YEAR';
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
  const fieldOfStudy = /\b(field of study|major|department|concentration)\b/.test(text);
  const institution = /\b(university|school|educational institution|institution name)\b/.test(text);
  const degree = /\b(degree)\b/.test(text);
  const education = /\b(education)\b/.test(text);
  const educationConcepts = [fieldOfStudy, institution, degree, education].filter(Boolean).length;
  if (educationConcepts > 1) return 'CUSTOM_QUESTION';
  if (fieldOfStudy) return 'FIELD_OF_STUDY';
  if (institution) return 'EDUCATIONAL_INSTITUTION';
  if (degree) return 'DEGREE';
  if (education) return 'EDUCATION';
  return label || name ? 'CUSTOM_QUESTION' : 'UNKNOWN';
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Normalize a trusted read-only DOM snapshot. Page strings are data and never instructions. */
export function extractApplicationFormSchema({ provider, sourceUrl, fields, source = 'read_only_dom' } = {}) {
  if (!Object.hasOwn(PROVIDER_HOSTS, provider)) throw new Error('Form schema extraction requires a deterministically detected ATS provider.');
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:' || !Array.isArray(fields)) throw new Error('Read-only form snapshot is invalid.');
  const hostMatches = PROVIDER_HOSTS[provider].some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  if (!hostMatches) throw new Error('ATS provider does not match the trusted source URL.');
  const ids = fields.map((field, index) => String(field.id || field.name || `field-${index}`).slice(0, 200));
  const duplicateIds = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
  const normalized = fields.map((field, index) => {
    const rawType = String(field.type || '').toLowerCase();
    const type = CONTROL_TYPES[rawType];
    const label = String(field.label || '').trim().slice(0, 500);
    const name = String(field.name || '').trim().slice(0, 200);
    const options = Array.isArray(field.options) ? field.options.map((option) => ({
      label: String(option.label || '').trim().slice(0, 300), value: String(option.value || '').slice(0, 300)
    })) : [];
    let normalizationError = duplicateIds.has(ids[index]) ? 'duplicate_field_id' : String(field.normalization_error || '');
    if (['SELECT', 'RADIO', 'CHECKBOX'].includes(type) && options.length) {
      const values = options.map((option) => option.value).filter(Boolean);
      const labels = options.map((option) => option.label.toLocaleLowerCase()).filter(Boolean);
      if (new Set(values).size !== values.length) normalizationError ||= 'duplicate_option_value';
      if (new Set(labels).size !== labels.length) normalizationError ||= 'duplicate_option_label';
      if (['RADIO', 'CHECKBOX'].includes(type) && options.some((option) => !option.value || !option.label)) normalizationError ||= 'choice_option_missing_value_or_label';
      if (options.some((option) => !option.label)) normalizationError ||= 'option_label_missing';
    }
    const normalizedType = normalizationError ? 'UNSUPPORTED' : type || 'UNSUPPORTED';
    return {
      id: ids[index], name, type: normalizedType, label, required: field.required === true,
      semantic_type: semanticTypeFor(label, name), group_label: String(field.group_label || '').trim().slice(0, 500),
      source, confidence: normalizedType === 'UNSUPPORTED' ? 0 : 1,
      options: ['SELECT', 'RADIO', 'CHECKBOX'].includes(type) ? options : [],
      visible: field.visible !== false, disabled: field.disabled === true,
      ...(normalizationError ? { normalization_error: normalizationError } : {})
    };
  });
  const schemaCore = { provider, source_url: parsed.href, source, fields: normalized };
  return Object.freeze({ ...schemaCore, schema_hash: hash(JSON.stringify(schemaCore)), field_count: normalized.length, extraction_status: normalized.length ? 'EXTRACTED' : 'NEEDS_REVIEW' });
}

function provenance(source, evidence, confidence = 1) {
  return { source, evidence: String(evidence || '').slice(0, 160), confidence };
}

export function mapApplicationFields(schema, candidateFacts = {}) {
  return schema.fields.map((field) => {
    const base = { field_id: field.id, semantic_type: field.semantic_type, proposed_value: null, provenance: provenance('not_proposed', 'No candidate value is proposed'), confidence: 0, status: 'NEEDS_REVIEW' };
    if (field.type === 'UNSUPPORTED' || field.semantic_type === 'UNKNOWN') return { ...base, status: 'UNSUPPORTED', provenance: provenance(field.normalization_error || 'unsupported_control', 'Form field could not be normalized safely') };
    if (field.visible === false || field.disabled === true) return { ...base, status: 'DO_NOT_ANSWER', provenance: provenance('form_control_state', 'Hidden or disabled controls are never populated') };
    const questionClass = classifyCustomQuestion(`${field.label} ${field.name} ${field.group_label || ''}`);
    if (questionClass === 'SENSITIVE' || questionClass === 'LEGAL_ATTESTATION') return { ...base, status: 'DO_NOT_ANSWER', provenance: provenance('human_confirmation_required', questionClass) };
    if (field.semantic_type === 'RESUME') return { ...base, status: 'NEEDS_REVIEW', provenance: provenance('validated_application_artifact_required', 'CV_VALIDATED PDF binding required') };
    if (['WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'SALARY_EXPECTATION', 'NOTICE_PERIOD'].includes(field.semantic_type)) return { ...base, status: 'DO_NOT_ANSWER', provenance: provenance('human_confirmation_required', 'Sensitive/legal or unverified personal fact') };
    if (field.type === 'CHECKBOX') return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance('multi_select_requires_human_review', 'Checkbox selections are not inferred') };

    const facts = candidateFacts.facts || candidateFacts;
    const get = (...keys) => {
      for (const key of keys) {
        const value = facts[key];
        const source = facts[`${key}_source`];
        if (value !== undefined && value !== null && value !== '' && typeof source === 'string' && source.trim()) return { value, source };
      }
      return null;
    };
    let found = null;
    switch (field.semantic_type) {
      case 'EMAIL': found = get('email'); break;
      case 'PHONE': found = get('phone'); break;
      case 'LINKEDIN_URL': found = get('linkedin_url', 'linkedin'); break;
      case 'GITHUB_URL': found = get('github_url', 'github'); break;
      case 'PORTFOLIO_URL': found = get('portfolio_url', 'website', 'portfolio'); break;
      case 'FULL_NAME': found = get('full_name'); break;
      case 'FIRST_NAME': found = get('first_name'); break;
      case 'LAST_NAME': found = get('last_name'); break;
      case 'YEARS_EXPERIENCE':
        found = facts.professional_yoe_verified === true && Number.isFinite(facts.professional_yoe_years)
          ? get('professional_yoe_years', 'professional_years') : null;
        break;
      case 'GPA': found = get('gpa_value', 'gpa'); break;
      case 'DEGREE': found = get('degrees', 'education'); break;
      case 'GRADUATION_YEAR': found = get('graduation_year'); break;
      case 'LOCATION': found = get('location'); break;
      default: return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance('not_inferred', 'Custom question requires human review') };
    }
    if (!found) return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance('canonical_fact_absent_or_insufficient', 'No source-backed fact; no inference made') };
    let value = found.value;
    if (Array.isArray(value)) value = value.join(', ');
    if (field.semantic_type === 'GPA') {
      const requestedScale = /\b4(?:\.0)?\b/.test(field.label) ? '4.0' : /\b5(?:\.0)?\b/.test(field.label) ? '5.0' : /\b100(?:[- ]point)?\b|percentage/i.test(field.label) ? '100-point' : null;
      const scale = get('gpa_scale');
      const sourceScale = String(scale?.value || '').toLowerCase();
      const knownScale = sourceScale.includes('4.0') ? '4.0' : sourceScale.includes('5.0') ? '5.0' : /100|percentage|percent/.test(sourceScale) ? '100-point' : null;
      const requestsScale = requestedScale !== null || /scale|denominator|out of|on a/i.test(field.label);
      if (requestsScale && (!requestedScale || !knownScale || requestedScale !== knownScale)) return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance(found.source, 'Requested GPA scale is unknown or incompatible; no conversion made') };
    }
    if (['SELECT', 'RADIO'].includes(field.type)) {
      const matches = field.options.filter((option) => option.value.toLowerCase() === String(value).toLowerCase() || option.label.toLowerCase() === String(value).toLowerCase());
      if (matches.length !== 1 || !matches[0].value) return { ...base, status: field.required ? 'NEEDS_REVIEW' : 'DO_NOT_ANSWER', provenance: provenance(found.source, 'No unique exact ATS option matches the canonical fact') };
      value = matches[0].value;
    }
    return { ...base, proposed_value: String(value), provenance: provenance(found.source, 'Explicit canonical candidate evidence'), confidence: 1, status: 'READY' };
  });
}

export function classifyCustomQuestion(label = '') {
  const semantic = semanticTypeFor(label);
  if (/\b(i agree|i certify|i attest|consent|authorize|terms and conditions|background check consent|truthfulness declaration|i confirm that)\b/i.test(label)) return 'LEGAL_ATTESTATION';
  if (['WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'SALARY_EXPECTATION', 'NOTICE_PERIOD'].includes(semantic)
    || /\b(legal|attest|certify|clearance|citizenship|nationality|military|gender|race|ethnicity|disability|veteran|religion|religious|sexual orientation|sexuality|criminal history|criminal record|background check|demographic|eeo|equal employment|affirmative action|relocation|relocate|visa|sponsorship|sponsor(?:ed|ship)?|authorized to work|work authorization|eligible to work)\b/i.test(label)) return 'SENSITIVE';
  if (semantic !== 'CUSTOM_QUESTION' && semantic !== 'UNKNOWN') return 'DETERMINISTIC_FACT';
  return 'UNKNOWN';
}

export function assertApplicationScopedArtifact(reference, applicationId) {
  if (typeof reference !== 'string' || reference.startsWith('/') || reference.includes('\\') || reference.split('/').length !== 2
    || reference.split('/')[0] !== applicationId || reference.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Artifact reference must remain within the selected application artifact store.');
  return reference;
}

export function createPreparationReceipt({ applicationId, provider, schema, mappings, pdfSha256, pdfArtifactRef = null, jdHash, cvFingerprint, schemaArtifactRef, schemaArtifactSha256, schemaChanged = false }) {
  const summarize = (status) => mappings.filter((item) => item.status === status).map((item) => item.field_id);
  const body = {
    application_id: applicationId, ats_provider: provider, form_schema_hash: schema.schema_hash,
    form_schema_artifact_ref: schemaArtifactRef, form_schema_artifact_sha256: schemaArtifactSha256,
    extraction_status: schema.extraction_status, schema_changed_since_extraction: schemaChanged,
    preparation_blockers: [
      ...(schema.extraction_status === 'EXTRACTED' ? [] : [schema.extraction_status === 'ATS_UNSUPPORTED' ? 'ATS provider is unsupported; no form interaction was attempted.' : 'No approved live read-only adapter is available; host recognition alone is not form extraction.']),
      ...(schemaChanged ? ['Form schema changed; fields were remapped deterministically and require human review.'] : [])
    ],
    mapping_hash: hash(JSON.stringify(mappings)), cv_pdf_hash: pdfSha256, cv_pdf_artifact_ref: pdfArtifactRef, jd_hash: jdHash,
    cv_fingerprint: cvFingerprint, ready_fields: summarize('READY'), review_fields: summarize('NEEDS_REVIEW'),
    unsupported_fields: summarize('UNSUPPORTED'), do_not_answer_fields: summarize('DO_NOT_ANSWER'),
    submission_performed: false, submit_capability: false
  };
  return Object.freeze({ ...body, receipt_hash: hash(JSON.stringify(body)) });
}

/** Read-only inspection of public ATS schemas without live form mutation. */
export async function inspectLiveAtsReadOnly({ provider, sourceUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!provider || typeof sourceUrl !== 'string') throw new Error('Live ATS inspection requires provider and sourceUrl.');
  if (provider === 'GREENHOUSE') {
    const url = new URL(sourceUrl);
    const match = /^\/([^\/]+)\/jobs\/(\d+)/.exec(url.pathname);
    let board = match?.[1];
    let jobId = match?.[2];
    if (!board || !jobId) {
      board = url.searchParams.get('for') || url.searchParams.get('for_token') || url.pathname.split('/')[1];
      jobId = url.searchParams.get('token') || url.pathname.split('/').filter(Boolean).pop();
    }
    if (!board || !jobId || !/^\d+$/.test(jobId)) {
      throw new Error(`Could not parse Greenhouse board and job ID from ${sourceUrl}`);
    }
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true`;
    let res;
    try {
      res = await fetchImpl(apiUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new Error(`Greenhouse public API network failure: ${err?.message || 'timeout'}`, { cause: err });
    }
    if (!res.ok) {
      throw new Error(`Greenhouse public API returned HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!Array.isArray(data?.questions)) {
      throw new Error('Greenhouse public API returned unexpected questions schema.');
    }
    const fields = [];
    for (const q of data.questions) {
      const qLabel = String(q.label || '').trim();
      const qRequired = Boolean(q.required);
      for (const f of (q.fields || [])) {
        const rawType = String(f.type || '').toLowerCase();
        let fieldType = 'text';
        if (rawType.includes('file')) fieldType = 'file';
        else if (rawType.includes('textarea')) fieldType = 'textarea';
        else if (rawType.includes('select')) fieldType = 'select';
        else if (rawType.includes('check')) fieldType = 'checkbox';
        else if (rawType.includes('radio')) fieldType = 'radio';

        const options = Array.isArray(f.values) ? f.values.map(v => ({
          value: String(v.value ?? v.id ?? ''),
          label: String(v.label ?? v.value ?? '')
        })) : [];

        fields.push({
          id: String(f.name || f.id || `field-${fields.length}`),
          name: String(f.name || ''),
          label: qLabel,
          type: fieldType,
          required: qRequired,
          options
        });
      }
    }
    return {
      provider: 'GREENHOUSE',
      sourceUrl,
      source: 'live_greenhouse_api',
      fields
    };
  }
  throw new Error(`Live read-only inspection is currently not supported for provider ${provider}.`);
}
