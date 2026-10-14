// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import {
  classifyFormField,
  detectCaptcha,
  createPreSubmitNetworkPolicy,
  buildFieldValues,
  planFormFields,
  runAutofillSimulation,
  installWebSocketDenyPolicy,
  isSupportedAtsApplicationUrl,
  FIELD_CLASSIFICATIONS
} from '../lib/autofill-engine.mjs';

test('classifyFormField correctly categorizes profile facts vs legal questions', () => {
  assert.equal(classifyFormField('First Name'), FIELD_CLASSIFICATIONS.PROFILE_FACT);
  assert.equal(classifyFormField('Email Address'), FIELD_CLASSIFICATIONS.PROFILE_FACT);
  assert.equal(classifyFormField('Resume / CV'), FIELD_CLASSIFICATIONS.CV_FACT);
  assert.equal(classifyFormField('Are you legally authorized to work in Israel?'), FIELD_CLASSIFICATIONS.SENSITIVE_OR_LEGAL);
  assert.equal(classifyFormField('Expected Salary (NIS / Month)'), FIELD_CLASSIFICATIONS.UNKNOWN_FACT);
  assert.equal(classifyFormField('Military Service / Unit'), FIELD_CLASSIFICATIONS.SENSITIVE_OR_LEGAL);
});

test('detectCaptcha identifies hCaptcha, reCAPTCHA, and Turnstile', () => {
  assert.equal(detectCaptcha('<div class="h-captcha" data-sitekey="xyz"></div>').detected, true);
  assert.equal(detectCaptcha('<script src="https://www.google.com/recaptcha/api.js"></script>').detected, true);
  assert.equal(detectCaptcha('<div class="cf-turnstile"></div>').detected, true);
  assert.equal(detectCaptcha('<form><input type="text" name="first_name"></form>').detected, false);
});

test('profile mapping never supplies fallback candidate facts', () => {
  assert.deepEqual(buildFieldValues({}), {
    first_name: '', last_name: '', email: '', phone: '', linkedin: '', github: '', website: '', country: '', region: ''
  });
  const mapped = buildFieldValues({ candidate: { full_name: 'Example Person', email: 'person@example.test', website: 'https://example.test' } });
  assert.equal(mapped.first_name, 'Example');
  assert.equal(mapped.last_name, 'Person');
  assert.equal(mapped.email, 'person@example.test');
  assert.equal(mapped.website, 'https://example.test');
});

test('form planner fills only explicit profile/CV fields and blocks required unknown facts', () => {
  const candidate = { candidate: { full_name: 'Example Person', email: 'person@example.test' } };
  const result = planFormFields([
    { index: 0, label: 'First Name', type: 'text', required: true },
    { index: 1, label: 'Email', type: 'email', required: true },
    { index: 2, label: 'Salary expectation', type: 'text', required: true },
    { index: 3, label: 'Gender', type: 'text', required: false }
  ], candidate);
  assert.deepEqual(result.actions.map((action) => action.value), ['Example', 'person@example.test']);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0], /Salary expectation/);
});

test('select fields use only an exact value or label match from explicit profile facts', () => {
  const result = planFormFields([
    { index: 0, label: 'Country of residence', type: 'select', required: true, options: [
      { value: '', label: 'Choose a country' }, { value: 'IL', label: 'Israel' }
    ] }
  ], { candidate: { country: 'Israel' } });
  assert.deepEqual(result.actions, [{ type: 'select', index: 0, field: 'Country of residence', value: 'IL', expectedLabel: 'Israel' }]);
  assert.deepEqual(planFormFields([
    { index: 0, label: 'Country of residence', type: 'select', required: true, options: [{ value: 'IL', label: 'Israel' }] }
  ], { candidate: { country: 'Canada' } }).blockers, ['Country of residence: no exact option matches the verified profile fact.']);
});

test('form planner identifies a required resume upload and blocks missing profile facts', () => {
  const result = planFormFields([
    { index: 0, label: 'Resume / CV', type: 'file', required: true },
    { index: 1, label: 'Phone number', type: 'tel', required: true }
  ], { candidate: {} });
  assert.deepEqual(result.actions, [{ type: 'upload', index: 0, field: 'Resume / CV' }]);
  assert.equal(result.blockers.length, 1);
});

function mockBrowser(snapshot) {
  const values = new Map();
  const safety = { aborted: 0, continued: 0, initScript: null, handler: null, websocketMatcher: null, websocketHandler: null, uploads: 0, currentUrl: '' };
  const page = {
    url: () => safety.currentUrl,
    goto: async (url) => {
      safety.currentUrl = url;
      let aborted = false;
      const route = { abort: async () => { safety.aborted++; aborted = true; }, continue: async () => { safety.continued++; } };
      await safety.handler(route, request({ url, resourceType: 'document', navigation: true }));
      if (aborted) throw new Error('navigation blocked by default-deny policy');
    },
    evaluate: async () => snapshot,
    frames: () => [{ url: () => 'about:blank' }],
    locator: () => ({ nth: (index) => ({
      fill: async (value) => values.set(index, value),
      inputValue: async () => values.get(index) || '',
      selectOption: async (value) => values.set(index, value),
      setInputFiles: async (path) => {
        safety.uploads++;
        values.set(index, path.split('/').pop());
        const route = { abort: async () => { safety.aborted++; }, continue: async () => { safety.continued++; } };
        await safety.handler(route, request({ url: 'https://boards.greenhouse.io/acme/jobs/123/applications', method: 'POST', resourceType: 'fetch' }));
      },
      evaluate: async () => snapshot.fields[index]?.type === 'file'
        ? [values.get(index)]
        : { value: values.get(index), label: snapshot.fields[index]?.options?.find((option) => option.value === values.get(index))?.label || '' }
    }) }),
    screenshot: async ({ path }) => writeFileSync(path, 'mock screenshot'),
    waitForTimeout: async () => {}
  };
  const context = {
    addInitScript: async (script) => { safety.initScript = script.toString(); },
    route: async (_pattern, handler) => { safety.handler = handler; },
    routeWebSocket: async (matcher, handler) => { safety.websocketMatcher = matcher; safety.websocketHandler = handler; },
    newPage: async () => page,
    close: async () => {}
  };
  const browser = { newContext: async (options) => { safety.serviceWorkers = options.serviceWorkers; return context; }, close: async () => {} };
  const factory = async () => browser;
  factory.safety = safety;
  return factory;
}

function request({ url, method = 'GET', resourceType = 'xhr', navigation = false }) {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
    isNavigationRequest: () => navigation
  };
}

test('exact read-only form GET is allowed only after explicit proof', () => {
  const url = 'https://ats.example/apply/123';
  assert.equal(createPreSubmitNetworkPolicy(url)(request({ url, resourceType: 'document', navigation: true })).allow, false);
  const provenReadOnlyPolicy = createPreSubmitNetworkPolicy(url, { verifiedReadOnlyUrls: [url] });
  assert.equal(provenReadOnlyPolicy(request({ url, resourceType: 'document', navigation: true })).allow, true);
});

test('supported ATS allowlisting is host-bounded and rejects unrelated origins', () => {
  assert.equal(isSupportedAtsApplicationUrl('https://boards.greenhouse.io/acme/jobs/123'), true);
  assert.equal(isSupportedAtsApplicationUrl('https://job-boards.greenhouse.io/acme/jobs/123'), true);
  assert.equal(isSupportedAtsApplicationUrl('https://jobs.lever.co/acme/123'), true);
  assert.equal(isSupportedAtsApplicationUrl('https://example.com/apply/123'), false);
  assert.equal(isSupportedAtsApplicationUrl('https://www.linkedin.com/jobs/view/123'), false);
  assert.equal(isSupportedAtsApplicationUrl('https://alice:secret@boards.greenhouse.io/acme/jobs/123'), false);
  assert.equal(isSupportedAtsApplicationUrl('https://boards.greenhouse.io:8443/acme/jobs/123'), false);
});

test('LEVEL_A_policy_allows_only_the_exact_proven_navigation_and_blocks_every_other_request', () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  const policy = createPreSubmitNetworkPolicy(url, { verifiedReadOnlyUrls: [url] });
  assert.equal(policy(request({ url, resourceType: 'document', navigation: true })).allow, true);
  assert.equal(policy(request({ url: 'https://boards.greenhouse.io/assets/app.js', resourceType: 'script' })).allow, false);
  assert.equal(policy(request({ url: 'https://boards.greenhouse.io/assets/logo.svg', resourceType: 'image' })).allow, false);
  assert.equal(policy(request({ url: 'https://boards.greenhouse.io/telemetry.png?email=person%40example.test&cv=data', resourceType: 'image' })).allow, false);
  assert.equal(policy(request({ url: 'https://cdn.example/app.js', resourceType: 'script' })).allow, false);
  assert.equal(policy(request({ url: 'https://boards.greenhouse.io/api/form', resourceType: 'fetch' })).allow, false);
  assert.equal(policy(request({ url: 'https://boards.greenhouse.io/acme/jobs/123/submit', resourceType: 'document', navigation: true })).allow, false);
});

test('REDIRECT_OUTSIDE_ATS_BOUNDARY_BLOCKED', () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/123';
  const policy = createPreSubmitNetworkPolicy(url, { verifiedReadOnlyUrls: [url] });
  assert.equal(policy(request({ url, resourceType: 'document', navigation: true })).allow, true);
  const redirect = policy(request({ url: 'https://evil.example/apply', resourceType: 'document', navigation: true }));
  assert.equal(redirect.allow, false);
  assert.equal(redirect.reason, 'navigation_not_proven_read_only');
});

test('FINAL_SUBMIT_POST_BLOCKED', () => {
  const url = 'https://ats.example/apply/123';
  const policy = createPreSubmitNetworkPolicy(url, { verifiedReadOnlyUrls: [url] });
  assert.equal(policy(request({ url, resourceType: 'document', navigation: true })).allow, true);
  const submit = policy(request({ url: 'https://ats.example/apply/submit', method: 'POST', resourceType: 'document', navigation: true }));
  assert.equal(submit.allow, false);
});

test('UNKNOWN_POST_BLOCKED', () => {
  const url = 'https://ats.example/apply/123';
  const policy = createPreSubmitNetworkPolicy(url, { verifiedReadOnlyUrls: [url] });
  policy(request({ url, resourceType: 'document', navigation: true }));
  assert.equal(policy(request({ url: 'https://ats.example/api/application', method: 'POST' })).allow, false);
});

test('KNOWN_SAFE_UPLOAD_ALLOWED only when endpoint semantics are proven (none are configured)', () => {
  const url = 'https://ats.example/apply/123';
  const policy = createPreSubmitNetworkPolicy(url, { verifiedReadOnlyUrls: [url] });
  policy(request({ url, resourceType: 'document', navigation: true }));
  assert.equal(policy(request({ url: 'https://storage.example/upload', method: 'PUT', resourceType: 'fetch' })).allow, false);
});

test('NO_FINAL_APPLICATION_CREATED by the default-deny network policy', () => {
  const policy = createPreSubmitNetworkPolicy('https://ats.example/apply/123');
  let applicationRecords = 0;
  const initial = request({ url: 'https://ats.example/apply/123', resourceType: 'document', navigation: true });
  if (policy(initial).allow && initial.url().endsWith('/submit')) applicationRecords++;
  const finalPost = request({ url: 'https://ats.example/apply/submit', method: 'POST', resourceType: 'document', navigation: true });
  if (policy(finalPost).allow) applicationRecords++;
  assert.equal(applicationRecords, 0);
});

test('WebSocket deny policy intercepts every URL and closes without connecting upstream', async () => {
  let predicate;
  let handler;
  let closed = false;
  const context = { routeWebSocket: async (matcher, routeHandler) => { predicate = matcher; handler = routeHandler; } };
  assert.equal(await installWebSocketDenyPolicy(context), true);
  assert.equal(predicate(new URL('wss://boards.greenhouse.io/socket?email=person%40example.test')), true);
  await handler({ close: async (options) => { closed = true; assert.equal(options.code, 1008); } });
  assert.equal(closed, true);
  assert.equal(await installWebSocketDenyPolicy({}), false);
});

test('REAL_CHROMIUM_WEBSOCKET_BLOCKED_BEFORE_SERVER_HANDSHAKE', async (t) => {
  let upgrades = 0;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>local test</title>');
  });
  server.on('upgrade', (_request, socket) => { upgrades++; socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    t.skip(`Chromium unavailable: ${error.message}`);
    return;
  }
  try {
    const context = await browser.newContext();
    let blocked = 0;
    assert.equal(await installWebSocketDenyPolicy(context, () => blocked++), true);
    const page = await context.newPage();
    const address = server.address();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const outcome = await page.evaluate(() => new Promise((resolve) => {
      const socket = new WebSocket(`ws://${location.host}/socket`);
      socket.addEventListener('open', () => socket.send('synthetic-candidate-payload'));
      socket.addEventListener('error', () => resolve('error'));
      socket.addEventListener('close', () => resolve('closed'));
      setTimeout(() => resolve('timeout'), 2000);
    }));
    assert.notEqual(outcome, 'timeout');
    assert.equal(blocked, 1);
    assert.equal(upgrades, 0);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('LEVEL_A_readonly_GET_and_local_DOM_prefill_keep_all_writes_blocked', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-autofill-test-'));
  try {
    const pdfPath = join(tempDir, 'cv.pdf');
    writeFileSync(pdfPath, 'fake pdf content');
    const snapshot = { html: '<form></form>', frames: [], fields: [
      { index: 0, label: 'First Name', type: 'text', required: true, visible: true },
      { index: 1, label: 'Email', type: 'email', required: true, visible: true },
      { index: 2, label: 'Country of residence', type: 'select', required: true, visible: true, options: [{ value: 'IL', label: 'Israel' }] },
      { index: 3, label: 'Resume / CV', type: 'file', required: true, visible: true }
    ] };
    const browserFactory = mockBrowser(snapshot);
    const res = await runAutofillSimulation({
      formUrl: 'https://boards.greenhouse.io/acme/jobs/123', pdfPath,
      candidateProfile: { candidate: { full_name: 'Example Person', email: 'person@example.test', country: 'Israel' } },
      options: { dryRun: false, browserFactory, evidenceDir: tempDir }
    });
    assert.equal(res.status, 'FORM_PREFILLED_RESUME_PENDING');
    assert.equal(res.domVerified, true);
    assert.equal(res.resumeUploaded, false);
    assert.equal(res.resumeSelected, true);
    assert.equal(res.resumeUploadStatus, 'RESUME_UPLOAD_UNVERIFIED');
    assert.equal(res.submitClicked, false);
    assert.deepEqual(res.filledFields, ['First Name', 'Email', 'Country of residence']);
    assert.equal(res.networkWritePolicy, 'strict-read-only-default-deny');
    assert.equal(res.remoteWritesAllowed, false);
    assert.equal(res.remoteWritesBlocked, 1);
    assert.match(res.blockedReason, /resume upload remains unverified/i);
    assert.match(browserFactory.safety.initScript, /preventDefault/);
    assert.match(browserFactory.safety.initScript, /requestSubmit/);
    assert.equal(browserFactory.safety.serviceWorkers, 'block');
    assert.equal(typeof browserFactory.safety.websocketMatcher, 'function');
    assert.equal(typeof browserFactory.safety.websocketHandler, 'function');
    const routed = { abort: async () => { browserFactory.safety.aborted++; }, continue: async () => { browserFactory.safety.continued++; } };
    await browserFactory.safety.handler(routed, request({ url: 'https://boards.greenhouse.io/acme/jobs/123/submit', method: 'POST', resourceType: 'document', navigation: true }));
    assert.equal(browserFactory.safety.aborted, 2);
    assert.equal(browserFactory.safety.continued, 1);
    assert.equal(browserFactory.safety.uploads, 1);
    assert.ok(res.screenshotPath);
    assert.ok(browserFactory.safety.aborted >= 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CAPTCHA stops preparation after the verified read-only page is viewed', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-autofill-test-'));
  try {
    const pdfPath = join(tempDir, 'cv.pdf');
    writeFileSync(pdfPath, 'fake pdf content');
    const snapshot = { html: '<div class="g-recaptcha"></div>', frames: [], fields: [{ index: 0, label: 'First Name', type: 'text', required: true, visible: true }] };
    const res = await runAutofillSimulation({ formUrl: 'https://boards.greenhouse.io/acme/jobs/123', pdfPath, candidateProfile: { candidate: { full_name: 'Example Person' } }, options: { dryRun: false, browserFactory: mockBrowser(snapshot), evidenceDir: tempDir } });
    assert.equal(res.status, 'BLOCKED_CAPTCHA');
    assert.equal(res.submitClicked, false);
    assert.deepEqual(res.filledFields, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unknown required facts stop preparation before any field is changed', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-autofill-test-'));
  try {
    const pdfPath = join(tempDir, 'cv.pdf');
    writeFileSync(pdfPath, 'fake pdf content');
    const snapshot = { html: '<form></form>', frames: [], fields: [
      { index: 0, label: 'First Name', type: 'text', required: true, visible: true },
      { index: 1, label: 'Expected Salary', type: 'text', required: true, visible: true }
    ] };
    const res = await runAutofillSimulation({ formUrl: 'https://boards.greenhouse.io/acme/jobs/123', pdfPath, candidateProfile: { candidate: { full_name: 'Example Person' } }, options: { dryRun: false, browserFactory: mockBrowser(snapshot), evidenceDir: tempDir } });
    assert.equal(res.status, 'NEEDS_USER_FACT');
    assert.equal(res.submitClicked, false);
    assert.deepEqual(res.filledFields, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runAutofillSimulation does not claim real fields were filled without browser integration', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'career-ops-autofill-test-'));
  try {
    const dummyPdf = join(tempDir, 'cv.pdf');
    writeFileSync(dummyPdf, 'fake pdf content');

    const profile = {
      candidate: {
        full_name: 'Lior Zvieli',
        email: 'liorzvieli@gmail.com',
        phone: '+972 52-227-6810'
      }
    };

    const res = await runAutofillSimulation({
      formUrl: 'https://example.com/apply',
      pdfPath: dummyPdf,
      candidateProfile: profile,
      options: { dryRun: true }
    });

    assert.equal(res.status, 'NOT_PERFORMED');
    assert.deepEqual(res.filledFields, []);
    assert.equal(res.submitClicked, false);
    assert.match(res.blockedReason, /Dry-run/);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
