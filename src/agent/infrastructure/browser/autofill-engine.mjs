// @ts-check
/**
 * Non-submitting browser form preparation.
 * Only explicit profile facts and the supplied PDF are written. Unknown required
 * fields, legal questions, CAPTCHAs, navigation failures, and read-back failures
 * stop the flow. This module never clicks a submit/apply control.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAggregatorUrl } from '../../../../url-key.mjs';

export const FIELD_CLASSIFICATIONS = Object.freeze({
  PROFILE_FACT: 'PROFILE_FACT',
  CV_FACT: 'CV_FACT',
  SAFE_GENERATIVE: 'SAFE_GENERATIVE',
  UNKNOWN_FACT: 'UNKNOWN_FACT',
  SENSITIVE_OR_LEGAL: 'SENSITIVE_OR_LEGAL',
  OPTIONAL_DEMOGRAPHIC: 'OPTIONAL_DEMOGRAPHIC'
});

export function classifyFormField(labelText) {
  const l = String(labelText || '').toLowerCase();
  if (/\b(first name|given name)\b/i.test(l)) return FIELD_CLASSIFICATIONS.PROFILE_FACT;
  if (/\bcountry of residence\b|\bstate\/province\b/i.test(l)) return FIELD_CLASSIFICATIONS.PROFILE_FACT;
  if (/\b(last name|family name|surname)\b/i.test(l)) return FIELD_CLASSIFICATIONS.PROFILE_FACT;
  if (/\b(email|e-mail)\b/i.test(l)) return FIELD_CLASSIFICATIONS.PROFILE_FACT;
  if (/\b(phone|mobile|cell|telephone)\b/i.test(l)) return FIELD_CLASSIFICATIONS.PROFILE_FACT;
  if (/\b(linkedin|github|website|portfolio)\b/i.test(l)) return FIELD_CLASSIFICATIONS.PROFILE_FACT;
  if (/\b(resume|cv|curriculum vitae)\b/i.test(l)) return FIELD_CLASSIFICATIONS.CV_FACT;
  if (/\b(authorized to work|work authorization|visa sponsorship|sponsorship required|require sponsorship|legally authorized)\b/i.test(l)) return FIELD_CLASSIFICATIONS.SENSITIVE_OR_LEGAL;
  if (/\b(salary|compensation|expected salary|rate)\b/i.test(l)) return FIELD_CLASSIFICATIONS.UNKNOWN_FACT;
  if (/\b(clearance|security clearance|polygraph)\b/i.test(l)) return FIELD_CLASSIFICATIONS.SENSITIVE_OR_LEGAL;
  if (/\b(military service|idf|army)\b/i.test(l)) return FIELD_CLASSIFICATIONS.SENSITIVE_OR_LEGAL;
  if (/\b(gender|race|ethnicity|disability|veteran)\b/i.test(l)) return FIELD_CLASSIFICATIONS.OPTIONAL_DEMOGRAPHIC;
  return FIELD_CLASSIFICATIONS.SAFE_GENERATIVE;
}

export function detectCaptcha(pageHtml) {
  const h = String(pageHtml || '').toLowerCase();
  if (h.includes('hcaptcha') || h.includes('h-captcha')) return { detected: true, type: 'hCaptcha' };
  if (h.includes('recaptcha') || h.includes('g-recaptcha')) return { detected: true, type: 'reCAPTCHA' };
  if (h.includes('turnstile') || h.includes('cf-turnstile') || h.includes('cloudflare turnstile')) return { detected: true, type: 'Cloudflare Turnstile' };
  return { detected: false, type: null };
}

/**
 * Values are taken only from the caller's user-authored profile. Missing facts
 * remain empty; no identity, contact detail, or URL is filled from a default.
 */
export function buildFieldValues(candidateProfile = {}) {
  const candidate = candidateProfile.candidate || {};
  const names = String(candidate.full_name || '').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: names[0] || '',
    last_name: names.slice(1).join(' '),
    email: String(candidate.email || ''),
    phone: String(candidate.phone || ''),
    linkedin: String(candidate.linkedin || ''),
    github: String(candidate.github || ''),
    website: String(candidate.website || candidate.portfolio || ''),
    country: String(candidate.country || ''),
    region: String(candidate.region || candidate.state || candidate.province || '')
  };
}

function profileKeyFor(label) {
  if (/\b(first name|given name)\b/i.test(label)) return 'first_name';
  if (/\b(last name|family name|surname)\b/i.test(label)) return 'last_name';
  if (/\b(email|e-mail)\b/i.test(label)) return 'email';
  if (/\b(phone|mobile|cell|telephone)\b/i.test(label)) return 'phone';
  if (/\blinkedin\b/i.test(label)) return 'linkedin';
  if (/\bgithub\b/i.test(label)) return 'github';
  if (/\b(website|portfolio)\b/i.test(label)) return 'website';
  if (/\bcountry of residence\b/i.test(label)) return 'country';
  if (/\bstate\/province\b/i.test(label)) return 'region';
  return null;
}

/**
 * Pure preflight: plan only supported, explicitly sourced fields and collect all
 * required unknowns before any browser interaction changes the form.
 */
const SUPPORTED_ATS_HOSTS = Object.freeze([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.ashbyhq.com',
  'jobs.lever.co',
  'apply.workable.com',
  'jobs.smartrecruiters.com'
]);

export function isSupportedAtsApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && SUPPORTED_ATS_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export async function installWebSocketDenyPolicy(context, onBlocked = () => {}) {
  if (typeof context?.routeWebSocket !== 'function') return false;
  await context.routeWebSocket(() => true, (websocket) => {
    onBlocked();
    websocket.close({ code: 1008, reason: 'Blocked by pre-submit network policy' });
  });
  return true;
}

export function createPreSubmitNetworkPolicy(initialUrl, { verifiedReadOnlyUrls = [] } = {}) {
  const canonicalInitialUrl = new URL(initialUrl).href;
  const verifiedReadOnly = new Set(verifiedReadOnlyUrls.map((url) => new URL(url).href));
  let initialDocumentAllowed = false;
  return (request) => {
    const method = String(request.method()).toUpperCase();
    const url = new URL(request.url());
    const resourceType = request.resourceType();
    const navigation = request.isNavigationRequest();
    if (!['GET', 'HEAD'].includes(method)) return { allow: false, severity: 'unsafe', reason: 'non_read_method_blocked' };
    if (navigation) {
      if (!initialDocumentAllowed && method === 'GET' && url.href === canonicalInitialUrl && verifiedReadOnly.has(url.href)) {
        initialDocumentAllowed = true;
        return { allow: true, severity: 'read_only', reason: 'initial_form_view' };
      }
      return { allow: false, severity: 'unverified', reason: 'navigation_not_proven_read_only' };
    }
    const dynamic = ['xhr', 'fetch', 'websocket', 'eventsource'].includes(resourceType);
    return {
      allow: false,
      severity: dynamic ? 'unverified' : 'blocked_optional',
      reason: dynamic ? 'dynamic_endpoint_not_proven_read_only' : 'resource_not_allowlisted'
    };
  };
}

export function planFormFields(fields, candidateProfile = {}) {
  const values = buildFieldValues(candidateProfile);
  const actions = [];
  const blockers = [];
  for (const field of fields) {
    if (field.disabled || field.visible === false || ['hidden', 'submit', 'button', 'reset'].includes(String(field.type || '').toLowerCase())) continue;
    const label = [field.label, field.ariaLabel, field.placeholder, field.name].filter(Boolean).join(' ').trim();
    if (!label) {
      if (field.required) blockers.push('Required form field has no readable label.');
      continue;
    }
    const classification = classifyFormField(label);
    const profileKey = profileKeyFor(label);
    if (classification === FIELD_CLASSIFICATIONS.CV_FACT) {
      if (String(field.type).toLowerCase() === 'file') actions.push({ type: 'upload', index: field.index, field: label });
      else if (field.required) blockers.push(`${label}: resume field is not a file input.`);
      continue;
    }
    if (classification === FIELD_CLASSIFICATIONS.PROFILE_FACT && profileKey) {
      const value = values[profileKey];
      if (value) {
        if (['text', 'email', 'tel', 'url', 'textarea', ''].includes(String(field.type || '').toLowerCase())) {
          actions.push({ type: 'fill', index: field.index, field: label, value });
        } else if (['select', 'select-one'].includes(String(field.type || '').toLowerCase())) {
          const exactOption = (field.options || []).find((option) => option.value === value || option.label === value);
          if (exactOption) actions.push({ type: 'select', index: field.index, field: label, value: exactOption.value, expectedLabel: exactOption.label });
          else if (field.required) blockers.push(`${label}: no exact option matches the verified profile fact.`);
        } else if (field.required) {
          blockers.push(`${label}: unsupported control type.`);
        }
      } else if (field.required) {
        blockers.push(`${label}: required profile fact is missing.`);
      }
      continue;
    }
    if (field.required) blockers.push(`${label}: required fact is not available from an approved source.`);
  }
  return { actions, blockers };
}

async function launchChromium() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('input, textarea, select'));
    const fields = controls.map((element, index) => {
      const el = /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} */ (element);
      const labels = Array.from(el.labels || []).map((label) => label.innerText || label.textContent || '').join(' ');
      const labelledBy = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ') || '';
      return {
        index,
        label: [labels, el.closest('label')?.innerText || '', labelledBy].filter(Boolean).join(' ').trim(),
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        type: (el.getAttribute('type') || el.tagName).toLowerCase(),
        options: el instanceof HTMLSelectElement ? Array.from(el.options).filter((option) => !option.disabled).map((option) => ({ value: option.value, label: (option.label || option.textContent || '').trim() })) : [],
        required: el.required || el.getAttribute('aria-required') === 'true',
        disabled: el.disabled,
        visible: el.getClientRects().length > 0
      };
    });
    return {
      html: document.documentElement?.outerHTML || '',
      frames: Array.from(document.querySelectorAll('iframe')).map((frame) => `${frame.getAttribute('src') || ''} ${frame.getAttribute('title') || ''}`),
      fields
    };
  });
}

function result(status, blockedReason, extra = {}) {
  return { status, filledFields: [], blockedReason, submitClicked: false, ...extra };
}

/**
 * Open and prepare a form without submitting it.
 * `options.browserFactory` is a test seam; production always uses Playwright Chromium.
 */
export async function runAutofillSimulation({ formUrl, pdfPath, candidateProfile, options = { dryRun: true } }) {
  if (!existsSync(pdfPath)) throw new Error(`autofill-engine: PDF file not found at ${pdfPath}`);
  if (isAggregatorUrl(formUrl)) return result('NEEDS_REVIEW', 'Aggregator forms are not eligible for automated preparation.');
  if (options.dryRun !== false) return result('NOT_PERFORMED', 'Dry-run mode does not interact with the form.');
  if (!options.evidenceDir) return result('FORM_NOT_VERIFIED', 'Screenshot evidence directory is not configured.');

  let browser;
  let context;
  let page;
  const networkBlocks = [];
  const capture = async (extra = {}) => {
    if (!page) return {};
    mkdirSync(options.evidenceDir, { recursive: true });
    const screenshotPath = join(options.evidenceDir, `form-verification-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return existsSync(screenshotPath) ? { screenshotPath, ...extra } : extra;
  };
  try {
    const browserFactory = options.browserFactory || launchChromium;
    browser = await browserFactory();
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const blockSubmit = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
      window.addEventListener('submit', blockSubmit, true);
      HTMLFormElement.prototype.submit = function () {};
      HTMLFormElement.prototype.requestSubmit = function () {};
    });
    const verifiedReadOnlyUrls = isSupportedAtsApplicationUrl(formUrl) ? [new URL(formUrl).href] : [];
    const requestPolicy = createPreSubmitNetworkPolicy(formUrl, { verifiedReadOnlyUrls });
    if (!await installWebSocketDenyPolicy(context, () => networkBlocks.push({
      severity: 'unverified', reason: 'websocket_blocked', method: 'WEBSOCKET', resourceType: 'websocket'
    }))) {
      return result('FORM_NOT_VERIFIED', 'Browser cannot enforce the WebSocket deny policy.', {
        remoteWritesAllowed: false, networkWritePolicy: 'strict-read-only-default-deny'
      });
    }
    await context.route('**/*', async (route, request) => {
      const decision = requestPolicy(request);
      if (decision.allow) {
        await route.continue();
      } else {
        networkBlocks.push({ severity: decision.severity, reason: decision.reason, method: request.method(), resourceType: request.resourceType() });
        await route.abort('blockedbyclient');
      }
    });
    page = await context.newPage();
    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (new URL(page.url()).href !== new URL(formUrl).href) {
      return result('FORM_NOT_VERIFIED', 'The live form redirected from the verified URL.', { networkWritePolicy: 'strict-read-only-default-deny' });
    }
    const snapshot = await inspectPage(page);
    const frameUrls = page.frames().map((frame) => frame.url());
    const captcha = detectCaptcha(`${snapshot.html}\n${snapshot.frames.join('\n')}\n${frameUrls.join('\n')}`);
    if (captcha.detected) return result('BLOCKED_CAPTCHA', `Detected ${captcha.type}`, {
      remoteWritesAllowed: false, networkWritePolicy: 'strict-read-only-default-deny', ...await capture()
    });
    if (networkBlocks.some((block) => block.severity === 'unsafe' || block.severity === 'unverified')) {
      return result('FORM_NOT_VERIFIED', 'Page behavior attempted an unverified network request; all such requests were blocked.', {
        remoteWritesAllowed: false, remoteWritesBlocked: networkBlocks.filter((block) => block.severity === 'unsafe').length,
        networkWritePolicy: 'strict-read-only-default-deny', blockedNetworkRequests: networkBlocks.length,
        ...await capture()
      });
    }

    const plan = planFormFields(snapshot.fields, candidateProfile);
    if (plan.blockers.length) return result('NEEDS_USER_FACT', plan.blockers.join(' '), {
      remoteWritesAllowed: false, networkWritePolicy: 'strict-read-only-default-deny', ...await capture()
    });
    if (!plan.actions.length) return result('FORM_NOT_VERIFIED', 'No supported profile or resume fields were found.', {
      remoteWritesAllowed: false, networkWritePolicy: 'strict-read-only-default-deny', ...await capture()
    });

    const filledFields = [];
    for (const action of plan.actions.filter((item) => item.type === 'fill' || item.type === 'select')) {
      const locator = page.locator('input, textarea, select').nth(action.index);
      if (action.type === 'select') {
        await locator.selectOption(action.value);
        const selected = await locator.evaluate((element) => ({ value: element.value, label: element.selectedOptions?.[0]?.label || '' }));
        if (selected.value !== action.value || selected.label !== action.expectedLabel) {
          return result('FORM_NOT_VERIFIED', `DOM read-back failed for ${action.field}.`, { filledFields, networkWritePolicy: 'strict-read-only-default-deny' });
        }
      } else {
        await locator.fill(action.value);
        if (await locator.inputValue() !== action.value) {
          return result('FORM_NOT_VERIFIED', `DOM read-back failed for ${action.field}.`, { filledFields, networkWritePolicy: 'strict-read-only-default-deny' });
        }
      }
      filledFields.push(action.field);
      if (networkBlocks.some((block) => block.severity === 'unsafe' || block.severity === 'unverified')) {
        return result('FORM_NOT_VERIFIED', 'A field event attempted an unverified network request; the request was blocked.', {
          filledFields, domVerified: true, resumeUploaded: false, resumeSelected: false,
          networkWritePolicy: 'strict-read-only-default-deny', blockedNetworkRequests: networkBlocks.length,
          ...await capture()
        });
      }
    }

    const resumeAction = plan.actions.find((action) => action.type === 'upload');
    let resumeSelected = false;
    let resumeUploadStatus = 'NO_RESUME_FIELD';
    if (resumeAction) {
      resumeUploadStatus = 'RESUME_UPLOAD_UNVERIFIED';
      const locator = page.locator('input, textarea, select').nth(resumeAction.index);
      await locator.setInputFiles(pdfPath);
      const selectedFiles = await locator.evaluate((element) => Array.from(element.files || []).map((file) => file.name));
      resumeSelected = selectedFiles.includes(basename(pdfPath));
      if (!resumeSelected) {
        return result('FORM_NOT_VERIFIED', 'The local resume file selection could not be read back.', {
          filledFields, domVerified: filledFields.length > 0, resumeUploaded: false, resumeSelected: false,
          resumeUploadStatus, remoteWritesAllowed: false, remoteWritesBlocked: networkBlocks.filter((block) => block.severity === 'unsafe').length,
          networkWritePolicy: 'strict-read-only-default-deny', blockedNetworkRequests: networkBlocks.length,
          ...await capture()
        });
      }
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(750);
    }
    const evidence = await capture({
      filledFields,
      domVerified: filledFields.length > 0,
      resumeUploaded: false,
      resumeSelected,
      resumeUploadStatus,
      remoteWritesAllowed: false,
      remoteWritesBlocked: networkBlocks.filter((block) => block.severity === 'unsafe').length,
      networkWritePolicy: 'strict-read-only-default-deny',
      blockedNetworkRequests: networkBlocks.length
    });
    return result('FORM_PREFILLED_RESUME_PENDING', resumeAction
      ? 'Verified text fields were prefilled locally; resume upload remains unverified and no submit control was used.'
      : 'Verified text fields were prefilled locally; resume upload is not configured and no submit control was used.', evidence);
  } catch (error) {
    const initialViewBlocked = networkBlocks.some((block) => block.reason === 'navigation_not_proven_read_only');
    const blockedReason = initialViewBlocked
      ? 'Initial form-page GET blocked: this exact URL has no verified read-only semantics; no candidate data or upload was sent.'
      : `Browser interaction could not be verified: ${error instanceof Error ? error.message : String(error)}`;
    return result(browser ? 'FORM_NOT_VERIFIED' : 'NOT_PERFORMED', blockedReason, {
      networkWritePolicy: 'strict-read-only-default-deny', blockedNetworkRequests: networkBlocks.length
    });
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}
