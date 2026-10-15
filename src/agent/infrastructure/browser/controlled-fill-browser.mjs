import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { extractApplicationFormSchema, detectAtsProvider, classifyCustomQuestion } from '../../domain/applications/ats-preparation.mjs';
import { extractReadOnlyFormFields } from './ats-form-inspector.mjs';

const TRUSTED_CONTROLLERS = new WeakSet();
const HASH = /^[a-f0-9]{64}$/i;
const APP_ID = /^app-[a-f0-9]{24}$/i;
const RAW_TYPE = Object.freeze({ TEXT: 'text', TEXTAREA: 'textarea', EMAIL: 'email', PHONE: 'tel', URL: 'url', SELECT: 'select', RADIO: 'radio', CHECKBOX: 'checkbox', FILE: 'file' });
const SAFE_TEXT_TYPES = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'URL']);
const BLOCKED_CHECKBOX = /\b(agree|certif(?:y|ication)|attest|authori[sz]e|consent|terms|privacy|background check|truth(?:ful|fulness)|confirm(?:ation)?|work authori[sz]ation|sponsorship|demographic|eeo|gender|race|ethnicity|religion|disability|veteran|citizenship|criminal history)\b/i;
const BLOCKED_FIELD = /\b(legal|attest|certif|clearance|citizenship|nationality|military|gender|race|ethnicity|disability|veteran|religion|religious|sexual orientation|sexuality|criminal history|criminal record|background check|demographic|eeo|equal employment|affirmative action|relocation|relocate|visa|sponsorship|authorized to work|work authorization|eligible to work|salary commitment|notice period|terms and conditions|truthfulness declaration|ssn|social security|tax id|national id|passport|identity document|bank account|medical record|health information)\b/i;
const SENSITIVE_SEMANTICS = new Set(['WORK_AUTHORIZATION', 'VISA_SPONSORSHIP', 'CITIZENSHIP', 'SECURITY_CLEARANCE', 'CRIMINAL_HISTORY', 'DISABILITY', 'VETERAN_STATUS', 'GENDER', 'RACE', 'ETHNICITY', 'RELIGION', 'SEXUAL_ORIENTATION', 'DEMOGRAPHICS', 'SALARY_EXPECTATION', 'NOTICE_PERIOD']);
function assertBrowserFieldSafe(field) {
  const label = `${field.label} ${field.name} ${field.group_label || ''}`;
  if (SENSITIVE_SEMANTICS.has(field.semantic_type) || BLOCKED_FIELD.test(label)
    || ['SENSITIVE', 'LEGAL_ATTESTATION'].includes(classifyCustomQuestion(label))) throw new Error('Browser guard blocked sensitive or legal field.');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function assertFixtureTarget(provider, applicationUrl) {
  const detection = detectAtsProvider(applicationUrl);
  if (detection.provider !== provider || !['GREENHOUSE', 'LEVER'].includes(provider)) throw new Error('Controlled fixture session requires a supported Greenhouse or Lever HTTPS application URL.');
}
function cssEscapeIdentifier(value) {
  return [...String(value)].map((char) => /[a-zA-Z0-9_-]/.test(char) ? char : `\\${char.codePointAt(0).toString(16)} `).join('');
}
function pathWithin(root, path) {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function assertNoSymlink(path, description) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${description} must not be a symlink.`);
  return stat;
}
function resolveArtifact(dataRoot, applicationId, reference) {
  if (!APP_ID.test(applicationId) || typeof reference !== 'string' || reference.includes('\\')
    || reference.startsWith('/') || reference.split('/').length !== 2 || reference.split('/')[0] !== applicationId
    || reference.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Application artifact reference is invalid or foreign.');
  const artifactRoot = resolve(dataRoot, 'data', 'application-artifacts');
  assertNoSymlink(artifactRoot, 'Application artifact store');
  const appDir = join(artifactRoot, applicationId);
  const artifactPath = join(appDir, reference.split('/')[1]);
  const realRoot = realpathSync(artifactRoot);
  assertNoSymlink(appDir, 'Application artifact directory');
  const fileStat = assertNoSymlink(artifactPath, 'Application artifact');
  if (!fileStat.isFile()) throw new Error('Application artifact must be a regular file.');
  const realPath = realpathSync(artifactPath);
  if (!pathWithin(realRoot, realPath)) throw new Error('Application artifact escapes the approved artifact store.');
  return { realPath, fileStat };
}
function readBoundPdf({ dataRoot, applicationId, artifactRef, artifactSha256, cvFingerprint, jdHash, preparationReceiptRef, preparationReceiptSha256 }) {
  if (!HASH.test(artifactSha256 || '') || !HASH.test(preparationReceiptSha256 || '')
    || typeof cvFingerprint !== 'string' || !cvFingerprint || typeof jdHash !== 'string' || !jdHash) throw new Error('Validated CV artifact binding is incomplete.');
  const prep = resolveArtifact(dataRoot, applicationId, preparationReceiptRef);
  const prepBytes = readFileSync(prep.realPath);
  if (sha256(prepBytes) !== preparationReceiptSha256) throw new Error('APPLICATION_PREPARED receipt hash mismatch or stale receipt.');
  let receipt;
  try { receipt = JSON.parse(prepBytes.toString('utf8')); } catch { throw new Error('APPLICATION_PREPARED receipt is malformed.'); }
  const { receipt_hash: receiptHash, ...receiptBody } = receipt;
  if (receiptHash !== sha256(JSON.stringify(receiptBody)) || receipt.application_id !== applicationId
    || receipt.cv_pdf_artifact_ref !== artifactRef || receipt.cv_pdf_hash !== artifactSha256
    || receipt.cv_fingerprint !== cvFingerprint || receipt.jd_hash !== jdHash) {
    throw new Error('CV artifact does not match the same application, preparation receipt, CV fingerprint, and JD.');
  }
  const artifact = resolveArtifact(dataRoot, applicationId, artifactRef);
  const bytes = readFileSync(artifact.realPath);
  if (sha256(bytes) !== artifactSha256) throw new Error('Validated CV artifact SHA-256 mismatch.');
  if (bytes.length < 8 || !/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) throw new Error('Validated CV artifact is not a PDF.');
  return { ...artifact, sha256: artifactSha256, size: bytes.length, filename: artifactRef.split('/')[1] };
}

export function isTrustedControlledFillController(controller) {
  return Boolean(controller && typeof controller === 'object' && TRUSTED_CONTROLLERS.has(controller));
}

/**
 * Creates a fixture-only, project-owned browser controller. It creates and owns
 * the Playwright browser/context/page; callers receive only fixed operations.
 * The supplied HTML is test fixture content, never fetched from a live ATS.
 */
export async function createControlledFixtureBrowserSession({ provider, applicationUrl, html, dataRoot, applicationId } = {}) {
  assertFixtureTarget(provider, applicationUrl);
  if (typeof html !== 'string' || html.length > 2_000_000) throw new Error('Controlled browser session requires bounded local fixture HTML.');
  if (!APP_ID.test(applicationId || '')) throw new Error('Controlled browser session requires a valid application ID.');
  let ephemeralRoot;
  if (dataRoot === undefined) {
    const { mkdtempSync } = await import('node:fs');
    ephemeralRoot = mkdtempSync(join(tmpdir(), 'controlled-fill-fixture-'));
    dataRoot = ephemeralRoot;
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({ serviceWorkers: 'block' });
    const metrics = { unexpected_navigation_events: 0, blocked_submission_attempts: 0, mutation_network_events: 0, submission_requests_delivered: 0, blocked_network_requests: 0, blocked_websocket_connections: 0, popup_events: 0, field_mutation_count: 0 };
    let fixtureFulfilled = false;
    const isFixtureDocument = (value) => {
      try { const url = new URL(value); url.hash = ''; const expected = new URL(applicationUrl); expected.hash = ''; return url.href === expected.href; }
      catch { return false; }
    };
    await context.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = request.url();
      if (requestUrl === 'about:blank' || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) return route.continue();
      if (!fixtureFulfilled && request.isNavigationRequest() && request.method() === 'GET' && isFixtureDocument(requestUrl)) {
        fixtureFulfilled = true;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      }
      metrics.blocked_network_requests++;
      if (!['GET', 'HEAD'].includes(request.method().toUpperCase())) metrics.mutation_network_events++;
      if (request.isNavigationRequest()) metrics.unexpected_navigation_events++;
      await route.abort('blockedbyclient');
    });
    if (typeof context.routeWebSocket !== 'function') throw new Error('This Playwright version cannot enforce the fixture WebSocket interlock.');
    await context.routeWebSocket('**/*', async (webSocketRoute) => {
      metrics.blocked_websocket_connections++;
      metrics.mutation_network_events++;
      await webSocketRoute.close({ code: 1008, reason: 'fixture network disabled' });
    });
    const page = await context.newPage();
    context.on('page', async (newPage) => {
      metrics.popup_events++;
      try { await newPage.close(); } catch {}
    });
    page.on('request', (request) => {
      if (request.method().toUpperCase() === 'POST') metrics.mutation_network_events++;
    });
    let initialFixtureNavigationAllowed = true;
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || frame.url() === 'about:blank') return;
      if (initialFixtureNavigationAllowed && isFixtureDocument(frame.url())) { initialFixtureNavigationAllowed = false; return; }
      metrics.unexpected_navigation_events++;
    });
    const installGuards = () => {
      window.__controlledFillAudit = window.__controlledFillAudit || { blocked: 0 };
      const audit = window.__controlledFillAudit;
      const blocked = (event) => { audit.blocked++; event?.preventDefault?.(); event?.stopImmediatePropagation?.(); };
      window.addEventListener('submit', blocked, true);
      HTMLFormElement.prototype.submit = function () { audit.blocked++; };
      HTMLFormElement.prototype.requestSubmit = function () { audit.blocked++; };
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        try { Object.defineProperty(window, key, { configurable: false, writable: false, value: undefined }); } catch {}
      }
    };
    await page.addInitScript(installGuards);
    await page.goto(applicationUrl, { waitUntil: 'domcontentloaded' });

    let lastSchema;
    let authorizedSchemaHash;
    let progressPath;
    const inspect = async () => {
      const fields = await extractReadOnlyFormFields(page);
      const schema = extractApplicationFormSchema({ provider, sourceUrl: applicationUrl, fields, source: 'controlled_fixture' });
      lastSchema = schema;
      if (!authorizedSchemaHash) authorizedSchemaHash = schema.schema_hash;
      const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 20_000);
      const frameText = (await page.locator('iframe').evaluateAll((frames) => frames.map((frame) => `${frame.getAttribute('src') || ''} ${frame.getAttribute('title') || ''}`).join('\n')).catch(() => '')).slice(0, 5_000);
      const combined = `${body}\n${frameText}`;
      const bypassTransportAvailable = await page.evaluate(() => Boolean(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.WebTransport));
      let status = bypassTransportAvailable ? 'NETWORK_CAPABILITY_UNAVAILABLE' : 'READY';
      if (status === 'READY' && /captcha|hcaptcha|recaptcha|turnstile/i.test(combined)) status = 'CAPTCHA_REQUIRED';
      else if (status === 'READY' && /multi[- ]factor|\bmfa\b|verification code|authenticator code/i.test(combined)) status = 'MFA_REQUIRED';
      else if (status === 'READY' && /verify your email|email verification/i.test(combined)) status = 'MANUAL_STEP_REQUIRED';
      else if (status === 'READY' && /create (an )?account|register account/i.test(combined)) status = 'ACCOUNT_CREATION_REQUIRED';
      else if (status === 'READY' && /sign in|log in|login required|password/i.test(combined)) status = 'AUTH_REQUIRED';
      return Object.freeze({ provider, url: applicationUrl, schema, status, network_capabilities_disabled: !bypassTransportAvailable });
    };
    const progressFileFor = (schema) => {
      const directory = join(resolve(dataRoot), 'data', 'application-artifacts', applicationId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      assertNoSymlink(directory, 'Fill progress application directory');
      const boundSchemaHash = authorizedSchemaHash || schema.schema_hash;
      return join(directory, `fill-progress-${sha256(`${applicationUrl}:${boundSchemaHash}`).slice(0, 32)}.jsonl`);
    };
    const getProgress = async () => {
      const schema = lastSchema || (await inspect()).schema;
      progressPath = progressFileFor(schema);
      if (!existsSync(progressPath)) return [];
      assertNoSymlink(progressPath, 'Fill progress journal');
      const lines = readFileSync(progressPath, 'utf8').split('\n').filter(Boolean);
      return lines.map((line) => {
        const item = JSON.parse(line);
        if (typeof item.field_id !== 'string' || !['MUTATION_STARTED', 'MUTATED_AND_VERIFIED', 'MATCHED_BEFORE_FILL', 'USER_MODIFIED', 'UPLOAD_VERIFIED', 'NEEDS_REVIEW'].includes(item.status)
          || !HASH.test(item.expected_value_hash || '')) throw new Error('Fill progress journal is invalid; manual review required.');
        return Object.freeze(item);
      });
    };
    const recordProgress = async (item) => {
      if (!lastSchema) throw new Error('Cannot persist fill progress before schema inspection.');
      if (typeof item.field_id !== 'string' || !['MUTATION_STARTED', 'MUTATED_AND_VERIFIED', 'MATCHED_BEFORE_FILL', 'USER_MODIFIED', 'UPLOAD_VERIFIED', 'NEEDS_REVIEW'].includes(item.status)
        || !HASH.test(item.expected_value_hash || '')) throw new Error('Invalid fill progress evidence.');
      progressPath ||= progressFileFor(lastSchema);
      const fd = openSync(progressPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW || 0), 0o600);
      try { writeSync(fd, `${JSON.stringify({ ...item, timestamp: new Date().toISOString() })}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
    };
    const ensureMutationSchema = async () => {
      const live = await inspect();
      if (live.status !== 'READY' || live.schema.schema_hash !== authorizedSchemaHash) throw new Error('Live schema changed before field mutation; manual review required.');
    };
    const fieldById = async (fieldId) => {
      const schema = lastSchema || (await inspect()).schema;
      const field = schema.fields.find((item) => item.id === fieldId);
      if (!field) throw new Error('Live field identity is missing; review required.');
      return field;
    };
    const indicesFor = async (field) => page.locator('input, textarea, select').evaluateAll((elements, descriptor) => {
      const raw = (el) => el instanceof HTMLTextAreaElement ? 'TEXTAREA' : el instanceof HTMLSelectElement ? 'SELECT' : ({ text: 'TEXT', email: 'EMAIL', tel: 'PHONE', url: 'URL', radio: 'RADIO', checkbox: 'CHECKBOX', file: 'FILE' }[String(el.type || 'text').toLowerCase()] || 'UNSUPPORTED');
      const group = ['RADIO', 'CHECKBOX'].includes(descriptor.type);
      return elements.map((el, index) => ({ el, index })).filter(({ el }) => raw(el) === descriptor.type && (group
        ? (descriptor.type === 'RADIO' ? el.name === descriptor.name : descriptor.name ? el.name === descriptor.name : el.id === descriptor.id)
        : (el.id === descriptor.id || (!el.id && descriptor.name && el.name === descriptor.name)))).map(({ index }) => index);
    }, field);
    const locatorForField = async (field) => {
      const indices = await indicesFor(field);
      if (indices.length !== 1) throw new Error('Field identity is ambiguous in the live form.');
      return page.locator('input, textarea, select').nth(indices[0]);
    };
    const readField = async ({ fieldId }) => {
      const field = await fieldById(fieldId);
      const indices = await indicesFor(field);
      if (!indices.length) throw new Error('Field identity disappeared from the live form.');
      if (['RADIO', 'CHECKBOX'].includes(field.type)) {
        const values = await page.locator('input, textarea, select').evaluateAll((elements, ids) => ids.map((index) => ({ value: elements[index].value || '', checked: elements[index].checked === true })), indices);
        if (field.type === 'RADIO') return Object.freeze({ value: values.find((item) => item.checked)?.value || '', selected: values.some((item) => item.checked) });
        if (values.length !== 1) throw new Error('Multi-checkbox groups require review and are unsupported.');
        return Object.freeze({ value: values[0].value, checked: values[0].checked });
      }
      if (field.type === 'FILE') {
        const files = await page.locator('input, textarea, select').nth(indices[0]).evaluate(async (el) => Promise.all(Array.from(el.files || []).map(async (file) => {
          if (file.size > 10_000_000) return { name: file.name, size: file.size, oversized: true };
          return { name: file.name, size: file.size, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) };
        })));
        return Object.freeze(files.map((file) => Object.freeze({ name: file.name, size: file.size, sha256: file.bytes ? sha256(Buffer.from(file.bytes)) : null, oversized: file.oversized === true })));
      }
      const locator = page.locator('input, textarea, select').nth(indices[0]);
      if (field.type === 'SELECT') return locator.evaluate((el) => ({ value: el.value, label: el.selectedOptions?.[0]?.label || '' }));
      return locator.inputValue();
    };
    const assertNoSubmission = async () => {
      const blockedByDom = await page.evaluate(() => Number(window.__controlledFillAudit?.blocked || 0));
      metrics.blocked_submission_attempts = blockedByDom;
      if (blockedByDom || metrics.mutation_network_events || metrics.unexpected_navigation_events || metrics.popup_events || metrics.blocked_network_requests || metrics.blocked_websocket_connections) {
        throw Object.assign(new Error('Controlled browser security interlock detected submission, network traffic, navigation, or popup.'), { securityMetrics: Object.freeze({ ...metrics }) });
      }
      return Object.freeze({ ...metrics });
    };
    const controller = Object.freeze({
      async inspect() {
        const snapshot = await inspect();
        try { await assertNoSubmission(); return snapshot; }
        catch (error) { return Object.freeze({ ...snapshot, status: 'SECURITY_FAILURE', securityMetrics: error?.securityMetrics || Object.freeze({ ...metrics }) }); }
      },
      async readField(input) { return readField(input); },
      async setTextField({ fieldId, value }) {
        await ensureMutationSchema();
        const field = await fieldById(fieldId);
        if (!SAFE_TEXT_TYPES.has(field.type) || typeof value !== 'string') throw new Error('Unsupported text field mutation.');
        assertBrowserFieldSafe(field);
        const locator = await locatorForField(field);
        await locator.fill(value);
        metrics.field_mutation_count = (metrics.field_mutation_count || 0) + 1;
        await assertNoSubmission();
      },
      async setChoice({ fieldId, value }) {
        await ensureMutationSchema();
        const field = await fieldById(fieldId);
        assertBrowserFieldSafe(field);
        if (!['SELECT', 'RADIO'].includes(field.type)) throw new Error('Unsupported choice widget; only uniquely mapped SELECT and RADIO controls are supported.');
        const matches = field.options.filter((option) => option.value === value);
        if (matches.length !== 1) throw new Error('Prepared choice does not uniquely match a live option.');
        if (field.type === 'SELECT') await (await locatorForField(field)).selectOption(value);
        else {
          const indices = await indicesFor(field);
          const optionIndices = await page.locator('input, textarea, select').evaluateAll((elements, args) => args.indices.filter((index) => elements[index].value === args.value), { indices, value });
          if (optionIndices.length !== 1) throw new Error('Radio choice does not uniquely match a live control.');
          await page.locator('input, textarea, select').nth(optionIndices[0]).check();
        }
        metrics.field_mutation_count = (metrics.field_mutation_count || 0) + 1;
        await assertNoSubmission();
      },
      async setCheckboxState({ fieldId, checked }) {
        await ensureMutationSchema();
        const field = await fieldById(fieldId);
        assertBrowserFieldSafe(field);
        if (field.type !== 'CHECKBOX' || typeof checked !== 'boolean' || BLOCKED_CHECKBOX.test(`${field.label} ${field.name} ${field.group_label || ''}`)
          || ['SENSITIVE', 'LEGAL_ATTESTATION'].includes(classifyCustomQuestion(`${field.label} ${field.name} ${field.group_label || ''}`))) throw new Error('Checkbox is unsupported, sensitive, or legal; blocked for review.');
        const indices = await indicesFor(field);
        if (indices.length !== 1) throw new Error('Multi-checkbox groups require review and are unsupported.');
        await page.locator('input, textarea, select').nth(indices[0]).setChecked(checked);
        metrics.field_mutation_count = (metrics.field_mutation_count || 0) + 1;
        await assertNoSubmission();
      },
      async attachValidatedFile(binding) {
        await ensureMutationSchema();
        const field = await fieldById(binding.fieldId);
        if (field.type !== 'FILE') throw new Error('CV upload target must be a FILE control.');
        assertBrowserFieldSafe(field);
        if (field.semantic_type !== 'RESUME') throw new Error('CV upload target must be a RESUME control.');
        if (field.visible !== true || field.disabled) throw new Error('CV upload target must be visible and enabled.');
        const pdf = readBoundPdf({ dataRoot, applicationId, ...binding });
        const locator = await locatorForField(field);
        if (!await locator.isVisible() || !await locator.isEnabled()) throw new Error('CV upload target must be currently visible and enabled.');
        await locator.setInputFiles(pdf.realPath);
        metrics.field_mutation_count = (metrics.field_mutation_count || 0) + 1;
        const actual = await readField({ fieldId: field.id });
        if (actual.length !== 1 || actual[0].name !== pdf.filename || actual[0].size !== pdf.size || actual[0].sha256 !== pdf.sha256) throw new Error('Intended validated PDF attachment could not be verified by content hash.');
        await assertNoSubmission();
        return Object.freeze({ artifact_ref: binding.artifactRef, artifact_sha256: pdf.sha256, filename: pdf.filename, size: pdf.size, verified: true });
      },
      async assertNoSubmission() { return assertNoSubmission(); },
      async getProgress() { return getProgress(); },
      async recordProgress(item) { return recordProgress(item); },
      getMetrics() { return Object.freeze({ ...metrics }); },
      async close() {
        await context.close(); await browser.close();
        if (ephemeralRoot) { const { rmSync } = await import('node:fs'); rmSync(ephemeralRoot, { recursive: true, force: true }); }
      }
    });
    TRUSTED_CONTROLLERS.add(controller);
    return controller;
  } catch (error) {
    try { await context?.close(); } catch {}
    try { await browser.close(); } catch {}
    throw error;
  }
}
