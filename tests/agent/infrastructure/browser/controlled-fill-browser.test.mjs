import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createControlledFixtureBrowserSession, isTrustedControlledFillController } from '../../../../src/agent/infrastructure/browser/controlled-fill-browser.mjs';

const APP_ID = 'app-111111111111111111111111';
const url = 'https://boards.greenhouse.io/acme/jobs/1';
const hash = (v) => createHash('sha256').update(v).digest('hex');

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'controlled-fill-browser-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function approvedPdf(root) {
  const appDir = join(root, 'data', 'application-artifacts', APP_ID);
  mkdirSync(appDir, { recursive: true });
  const pdf = Buffer.from('%PDF-1.7\nfixture pdf bytes');
  const pdfRef = `${APP_ID}/cv-validated.pdf`;
  writeFileSync(join(appDir, 'cv-validated.pdf'), pdf);
  const receipt = { application_id: APP_ID, cv_pdf_hash: hash(pdf), cv_pdf_artifact_ref: pdfRef, cv_fingerprint: 'cv-fingerprint', jd_hash: 'jd-hash' };
  const { receipt_hash = '' } = receipt;
  const body = JSON.stringify({ ...receipt, receipt_hash: hash(JSON.stringify(receipt)) });
  writeFileSync(join(appDir, 'application-prepared.json'), body);
  return { pdfRef, pdfHash: hash(pdf), prepRef: `${APP_ID}/application-prepared.json`, prepHash: hash(body), receipt: JSON.parse(body) };
}

async function session(html, dataRoot) {
  return createControlledFixtureBrowserSession({ provider: 'GREENHOUSE', applicationUrl: url, html, dataRoot, applicationId: APP_ID });
}

test('network escape primitives are disabled before untrusted fixture scripts execute', async () => {
  await withRoot(async (root) => {
    const html = '<form><label>Email<input id="email" type="email"></label></form><script>document.querySelector("#email").name="preGuardRTC="+typeof RTCPeerConnection;window.savedRTC=RTCPeerConnection;</script>';
    const controller = await session(html, root);
    try {
      const snapshot = await controller.inspect();
      assert.equal(snapshot.network_capabilities_disabled, true);
      assert.equal(snapshot.schema.fields[0].name, 'preGuardRTC=undefined');
    } finally { await controller.close(); }
  });
});

test('issues opaque trusted controller with no raw page or generic capability', async () => {
  const controller = await session('<form><label>Email<input id="email" type="email"></label></form>');
  try {
    assert.equal(isTrustedControlledFillController(controller), true);
    assert.equal('page' in controller, false);
    assert.deepEqual(Object.keys(controller).sort(), ['assertNoSubmission', 'attachValidatedFile', 'close', 'getMetrics', 'getProgress', 'inspect', 'readField', 'recordProgress', 'setCheckboxState', 'setChoice', 'setTextField'].sort());
    assert.equal('click' in controller || 'navigate' in controller || 'keyboard' in controller || 'evaluate' in controller, false);
    assert.equal(isTrustedControlledFillController({ ...controller }), false);
  } finally { await controller.close(); }
});

test('trusted session blocks hostile form.submit, requestSubmit, POST fetch, popup, and navigation', async () => {
  await withRoot(async (root) => {
    const html = `<form id="f"><input id="email" type="email" oninput="this.form.submit()" onchange="this.form.requestSubmit()"></form><script>window.addEventListener('input',()=>fetch('http://127.0.0.1:9/submit',{method:'POST'}));</script>`;
    const controller = await session(html, root);
    try {
      const schema = await controller.inspect();
      await assert.rejects(controller.setTextField({ fieldId: schema.schema.fields[0].id, value: 'a@example.test' }), /security|submission|network/i);
      const metrics = controller.getMetrics();
      assert.ok(metrics.blocked_submission_attempts >= 1);
      assert.ok(metrics.mutation_network_events >= 1);
      assert.equal(metrics.submission_requests_delivered, 0);
    } finally { await controller.close(); }
  });
});

test('hostile replacement of the public audit global cannot reset submit attempts', async () => {
  await withRoot(async (root) => {
    const html = `<form><label>Email<input id="email" type="email"></label></form><script>window.__controlledFillAudit={blocked:0};document.querySelector('#email').addEventListener('input',()=>document.querySelector('form').requestSubmit())</script>`;
    const controller = await session(html, root);
    try {
      const schema = await controller.inspect();
      await assert.rejects(controller.setTextField({ fieldId: schema.schema.fields[0].id, value: 'candidate@example.test' }), /security|submission|network/i);
      assert.ok(controller.getMetrics().blocked_submission_attempts >= 2, 'the audit-global overwrite and requestSubmit attempt both remain observable');
      assert.equal(controller.getMetrics().submission_requests_delivered, 0);
    } finally { await controller.close(); }
  });
});

test('hostile page Number replacement cannot suppress the private audit counter', async () => {
  await withRoot(async (root) => {
    const html = `<form><label>Email<input id="email" type="email"></label></form><script>
      window.Number=new Proxy(window.Number,{apply:()=>0});
      document.querySelector('#email').addEventListener('input',()=>document.querySelector('form').requestSubmit());
    </script>`;
    const controller = await session(html, root);
    try {
      const schema = await controller.inspect();
      await assert.rejects(controller.setTextField({ fieldId: schema.schema.fields[0].id, value: 'candidate@example.test' }), /security|submission|network/i);
      assert.ok(controller.getMetrics().blocked_submission_attempts >= 1);
      assert.equal(controller.getMetrics().submission_requests_delivered, 0);
    } finally { await controller.close(); }
  });
});

test('hostile submit prototype replacement is ineffective or fails closed', async () => {
  await withRoot(async (root) => {
    const html = `<form><label>Email<input id="email" type="email"></label></form><script>
      HTMLFormElement.prototype.submit=function(){document.body.dataset.bypassed='yes'};
      try { Object.defineProperty(HTMLFormElement.prototype,'requestSubmit',{configurable:true,writable:true,value:function(){document.body.dataset.bypassed='yes'}}); } catch {}
      document.querySelector('#email').addEventListener('input',()=>{document.querySelector('form').submit();document.querySelector('form').requestSubmit()});
    </script>`;
    const controller = await session(html, root);
    try {
      const schema = await controller.inspect();
      await assert.rejects(controller.setTextField({ fieldId: schema.schema.fields[0].id, value: 'candidate@example.test' }), /security|submission|network/i);
      assert.ok(controller.getMetrics().blocked_submission_attempts >= 1);
      assert.equal(controller.getMetrics().submission_requests_delivered, 0);
    } finally { await controller.close(); }
  });
});

test('select, radio, and checkbox set desired states deterministically', async () => {
  const controller = await session('<form><label for="country">Country</label><select id="country"><option value="">Choose</option><option value="ca">Canada</option></select><fieldset><legend>Work mode</legend><label><input type="radio" name="work_mode" value="remote">Remote</label><label><input type="radio" name="work_mode" value="office">Office</label></fieldset><label><input type="checkbox" id="updates">Send product updates</label></form>');
  try {
    const schema = await controller.inspect();
    const select = schema.schema.fields.find((field) => field.type === 'SELECT');
    const radio = schema.schema.fields.find((field) => field.type === 'RADIO');
    const checkbox = schema.schema.fields.find((field) => field.type === 'CHECKBOX');
    await controller.setChoice({ fieldId: select.id, value: 'ca' });
    await controller.setChoice({ fieldId: radio.id, value: 'remote' });
    await controller.setCheckboxState({ fieldId: checkbox.id, checked: true });
    assert.equal((await controller.readField({ fieldId: select.id })).value, 'ca');
    assert.equal((await controller.readField({ fieldId: radio.id })).value, 'remote');
    assert.equal((await controller.readField({ fieldId: checkbox.id })).checked, true);
  } finally { await controller.close(); }
});

test('untrusted option ambiguity and legal checkbox block before mutation', async () => {
  const controller = await session('<form><label for="country">Country</label><select id="country"><option value="a">Canada</option><option value="b">Canada</option></select><label><input type="checkbox" id="agree">I agree to the terms</label></form>');
  try {
    const schema = await controller.inspect();
    const select = schema.schema.fields.find((field) => field.id === 'country');
    const checkbox = schema.schema.fields.find((field) => field.type === 'CHECKBOX');
    await assert.rejects(controller.setChoice({ fieldId: select.id, value: 'a' }), /unsupported|ambiguous|unique/i);
    await assert.rejects(controller.setCheckboxState({ fieldId: checkbox.id, checked: true }), /legal|blocked|attestation/i);
  } finally { await controller.close(); }
});

test('direct upload primitive rejects sensitive, unrelated, hidden, and disabled file controls', async () => {
  await withRoot(async (root) => {
    approvedPdf(root);
    const binding = { artifactRef: `${APP_ID}/cv-validated.pdf`, artifactSha256: hash(Buffer.from('%PDF-1.7\nfixture pdf bytes')), cvFingerprint: 'cv-fingerprint', jdHash: 'jd-hash', preparationReceiptRef: `${APP_ID}/application-prepared.json`, preparationReceiptSha256: hash(readFileSync(join(root, 'data', 'application-artifacts', APP_ID, 'application-prepared.json'))), filename: 'cv-validated.pdf', size: Buffer.byteLength('%PDF-1.7\nfixture pdf bytes') };
    for (const [html, pattern] of [
      ['<form><label for="ssn">SSN verification document</label><input id="ssn" type="file"></form>', /sensitive/i],
      ['<form><label for="attachment">Other document</label><input id="attachment" type="file"></form>', /resume/i],
      ['<form><label for="resume">Resume</label><input id="resume" type="file" hidden></form>', /visible|hidden/i],
      ['<form><label for="resume">Resume</label><input id="resume" type="file" disabled></form>', /enabled|disabled/i]
    ]) {
      const controller = await session(html, root);
      try {
        const schema = await controller.inspect();
        await assert.rejects(controller.attachValidatedFile({ fieldId: schema.schema.fields[0].id, ...binding }), pattern);
        assert.equal((await controller.readField({ fieldId: schema.schema.fields[0].id })).length, 0);
      } finally { await controller.close(); }
    }
  });
});

test('validated PDF upload resolves only app-scoped artifact refs and verifies exact attached file', async () => {
  await withRoot(async (root) => {
    const binding = approvedPdf(root);
    const controller = await session('<form><label for="resume">Resume</label><input id="resume" type="file"></form>', root);
    try {
      const schema = await controller.inspect();
      const fileField = schema.schema.fields[0];
      const receipt = await controller.attachValidatedFile({ fieldId: fileField.id, artifactRef: binding.pdfRef, artifactSha256: binding.pdfHash, cvFingerprint: 'cv-fingerprint', jdHash: 'jd-hash', preparationReceiptRef: binding.prepRef, preparationReceiptSha256: binding.prepHash });
      assert.equal(receipt.verified, true);
      assert.equal(receipt.artifact_ref, binding.pdfRef);
      assert.equal(receipt.artifact_sha256, binding.pdfHash);
      await assert.rejects(controller.attachValidatedFile({ fieldId: fileField.id, artifactRef: '../latest.pdf', artifactSha256: binding.pdfHash, cvFingerprint: 'cv-fingerprint', jdHash: 'jd-hash', preparationReceiptRef: binding.prepRef, preparationReceiptSha256: binding.prepHash }), /artifact|path|reference/i);
    } finally { await controller.close(); }
  });
});

test('fixture WebSocket attempts are intercepted before any local server connection', async () => {
  let upgrades = 0;
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (_request, socket) => { upgrades++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const html = `<script>const socket=new WebSocket('ws://127.0.0.1:${address.port}/exfil');socket.onopen=()=>socket.send('fixture-secret')</script><form><label>Email<input id="email" type="email"></label></form>`;
  try {
    await withRoot(async (root) => {
      const controller = await session(html, root);
      try {
        const snapshot = await controller.inspect();
        assert.equal(snapshot.status, 'SECURITY_FAILURE');
        assert.equal(snapshot.network_capabilities_disabled, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(upgrades, 0, 'the WebSocket must never reach the local endpoint');
        assert.ok(controller.getMetrics().blocked_websocket_connections >= 1);
        await assert.rejects(controller.assertNoSubmission(), /interlock/i);
      } finally { await controller.close(); }
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('auth and CAPTCHA blockers are detected before any mutation', async () => {
  for (const [html, expected] of [
    ['<main>Please sign in to continue</main>', 'AUTH_REQUIRED'],
    ['<main>Complete the CAPTCHA</main><div class="g-recaptcha"></div>', 'CAPTCHA_REQUIRED']
  ]) {
    const controller = await session(html);
    try { assert.equal((await controller.inspect()).status, expected); }
    finally { await controller.close(); }
  }
});
