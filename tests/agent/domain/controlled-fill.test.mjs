import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fillContract from '../../../src/agent/domain/applications/controlled-fill.mjs';
import { createControlledFixtureBrowserSession } from '../../../src/agent/infrastructure/browser/controlled-fill-browser.mjs';
import { extractApplicationFormSchema } from '../../../src/agent/domain/applications/ats-preparation.mjs';

const { executeControlledFill } = fillContract;
const APP_ID = 'app-111111111111111111111111';
const URL = 'https://boards.greenhouse.io/acme/jobs/1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fieldsForEmail = [{ id: 'email', name: 'email', label: 'Email', type: 'email', required: true }];

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'controlled-fill-domain-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function fixture(html, dataRoot) {
  return createControlledFixtureBrowserSession({ provider: 'GREENHOUSE', applicationUrl: URL, html, dataRoot, applicationId: APP_ID });
}
function prepared(schema, mappings = [{ field_id: 'email', status: 'READY', semantic_type: 'EMAIL', proposed_value: 'candidate@example.com' }]) {
  return { application_id: APP_ID, provider: 'GREENHOUSE', application_url: URL, schema_hash: schema.schema_hash, mappings };
}
function htmlWithEmail(value = '') { return `<form><label>Email<input id="email" name="email" type="email" value="${value}"></label></form>`; }

function createPdfArtifacts(root, { appId = APP_ID, refName = 'cv-validated.pdf' } = {}) {
  const appDir = join(root, 'data', 'application-artifacts', appId);
  mkdirSync(appDir, { recursive: true });
  const pdf = Buffer.from('%PDF-1.7\ncontrolled fixture PDF');
  const pdfRef = `${appId}/${refName}`;
  writeFileSync(join(appDir, refName), pdf);
  const preparedBody = { application_id: appId, cv_pdf_artifact_ref: pdfRef, cv_pdf_hash: hash(pdf), cv_fingerprint: 'cv-fingerprint', jd_hash: 'jd-hash' };
  const preparationReceipt = JSON.stringify({ ...preparedBody, receipt_hash: hash(JSON.stringify(preparedBody)) });
  writeFileSync(join(appDir, 'application-prepared.json'), preparationReceipt);
  return { artifactRef: pdfRef, artifactSha256: hash(pdf), cvFingerprint: 'cv-fingerprint', jdHash: 'jd-hash', preparationReceiptRef: `${appId}/application-prepared.json`, preparationReceiptSha256: hash(preparationReceipt), filename: refName, size: pdf.length };
}

test('controlled fill domain exports no submission capability', () => {
  assert.deepEqual(Object.keys(fillContract), ['ControlledFillReviewError', 'executeControlledFill']);
});

test('requires explicit FILL_APPLICATION before any mutation', async () => {
  await withRoot(async (root) => {
    const controller = await fixture(htmlWithEmail(), root);
    try {
      const schema = (await controller.inspect()).schema;
      await assert.rejects(executeControlledFill({ authorization: 'PREPARE_APPLICATION', prepared: prepared(schema), controller }), /explicit FILL_APPLICATION/);
      assert.equal((await controller.readField({ fieldId: 'email' })), '');
    } finally { await controller.close(); }
  });
});

test('revalidates schema and fails closed before mutation', async () => {
  await withRoot(async (root) => {
    const controller = await fixture(htmlWithEmail(), root);
    try {
      const schema = (await controller.inspect()).schema;
      const stale = prepared(schema); stale.schema_hash = '0'.repeat(64);
      await assert.rejects(executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: stale, controller }), /drift/);
      assert.equal(await controller.readField({ fieldId: 'email' }), '');
    } finally { await controller.close(); }
  });
});

test('browser guard blocks sensitive, demographic, and legal labels despite READY mapping', async () => {
  for (const label of ['authorized to work', 'visa sponsorship', 'citizenship', 'security clearance', 'criminal history', 'disability status', 'veteran status', 'gender identity', 'race', 'ethnicity', 'religion', 'religious affiliation', 'sexual orientation', 'EEO survey', 'I certify this is true', 'I agree to background check consent', 'willing to relocate', 'expected salary', 'notice period']) {
    await withRoot(async (root) => {
      const controller = await fixture(`<form><label>${label}<input id="email" name="email" type="text"></label></form>`, root);
      try {
        const schema = (await controller.inspect()).schema;
        await assert.rejects(executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema, [{ field_id: 'email', status: 'READY', semantic_type: 'EMAIL', proposed_value: 'Yes' }]), controller }), /blocked|sensitive|legal/i, label);
        assert.equal(await controller.readField({ fieldId: 'email' }), '', label);
      } finally { await controller.close(); }
    });
  }
});

test('browser mutation interlock failures produce an explicit needs-review receipt', async () => {
  await withRoot(async (root) => {
    const html = `<form><label for="email">Email</label><input id="email" type="email"></form><script>document.querySelector('#email').addEventListener('input',()=>document.querySelector('form').requestSubmit())</script>`;
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      let failure;
      try { await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema), controller }); }
      catch (error) { failure = error; }
      assert.ok(failure?.partialReceipt);
      const receipt = failure.partialReceipt;
      assert.equal(receipt.fill_status, 'NEEDS_REVIEW');
      assert.ok(receipt.review_fields.length > 0 || receipt.blocked_fields.length > 0);
      assert.equal(receipt.submission_performed, false);
      assert.equal(receipt.submit_capability, false);
      assert.ok((await controller.getProgress()).some((item) => item.field_id === 'email' && item.status === 'NEEDS_REVIEW'));
    } finally { await controller.close(); }
  });
});

test('combined audit/prototype/submit/POST attack remains fail-closed with no delivered request', async () => {
  await withRoot(async (root) => {
    const html = `<form><label>Email<input id="email" type="email"></label></form><script>
      document.querySelector('#email').addEventListener('input',()=>{
        window.__controlledFillAudit={blocked:0};
        try { window.__controlledFillAudit.blocked=0; Object.defineProperty(window,'__controlledFillAudit',{configurable:true,value:{blocked:0}}); } catch {}
        HTMLFormElement.prototype.submit=function(){};
        try { Object.defineProperty(HTMLFormElement.prototype,'requestSubmit',{configurable:true,writable:true,value:function(){}}); } catch {}
        document.querySelector('form').submit();document.querySelector('form').requestSubmit();fetch('/submit',{method:'POST',body:'fixture'});
      });
    </script>`;
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      let failure;
      try { await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema), controller }); }
      catch (error) { failure = error; }
      assert.equal(failure?.status, 'SECURITY_FAILURE');
      assert.equal(failure?.partialReceipt?.fill_status, 'NEEDS_REVIEW');
      assert.ok(failure.partialReceipt.blocked_submission_attempts >= 1);
      assert.equal(failure.partialReceipt.submission_requests_delivered, 0);
      assert.equal(controller.getMetrics().submission_requests_delivered, 0);
    } finally { await controller.close(); }
  });
});

test('safe text fill is read back, immutable receipt has no value, and submission remains false', async () => {
  await withRoot(async (root) => {
    const controller = await fixture(htmlWithEmail(), root);
    try {
      const schema = (await controller.inspect()).schema;
      const receipt = await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema), controller });
      assert.equal(await controller.readField({ fieldId: 'email' }), 'candidate@example.com');
      assert.equal(receipt.filled_fields[0].verification, 'MATCH');
      assert.equal(receipt.submission_performed, false);
      assert.equal(receipt.submit_capability, false);
      assert.equal(JSON.stringify(receipt).includes('candidate@example.com'), false);
      assert.equal(Object.isFrozen(receipt), true);
    } finally { await controller.close(); }
  });
});

test('select, radio, and non-attestation checkbox use deterministic set-state operations', async () => {
  await withRoot(async (root) => {
    const html = '<form><label for="country">Country</label><select id="country"><option value="">Choose</option><option value="ca">Canada</option></select><fieldset><legend>Work mode</legend><label><input type="radio" name="work_mode" value="remote">Remote</label><label><input type="radio" name="work_mode" value="office">Office</label></fieldset><label><input type="checkbox" id="updates">Send product updates</label></form>';
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      const fields = schema.fields;
      const mappings = [
        { field_id: fields.find((field) => field.type === 'SELECT').id, status: 'READY', semantic_type: 'LOCATION', proposed_value: 'ca' },
        { field_id: fields.find((field) => field.type === 'RADIO').id, status: 'READY', semantic_type: 'CUSTOM_QUESTION', proposed_value: 'remote' },
        { field_id: fields.find((field) => field.type === 'CHECKBOX').id, status: 'READY', semantic_type: 'CUSTOM_QUESTION', proposed_value: true }
      ];
      await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema, mappings), controller });
      assert.equal((await controller.readField({ fieldId: mappings[0].field_id })).value, 'ca');
      assert.equal((await controller.readField({ fieldId: mappings[1].field_id })).value, 'remote');
      assert.equal((await controller.readField({ fieldId: mappings[2].field_id })).checked, true);
    } finally { await controller.close(); }
  });
});

test('ambiguous options and legal checkbox fail closed', async () => {
  await withRoot(async (root) => {
    const html = '<form><label for="country">Country</label><select id="country"><option value="a">Canada</option><option value="b">Canada</option></select><label><input type="checkbox" id="agree">I agree to the terms</label></form>';
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      const select = schema.fields.find((field) => field.id === 'country');
      assert.ok(!select || select.type === 'UNSUPPORTED', 'duplicate option labels make the schema unsupported');
      const checkbox = schema.fields.find((field) => field.type === 'CHECKBOX');
      await assert.rejects(controller.setCheckboxState({ fieldId: checkbox.id, checked: true }), /legal|blocked|attestation/i);
    } finally { await controller.close(); }
  });
});

test('exact validated PDF binding uploads once and verifies field, filename, and size', async () => {
  await withRoot(async (root) => {
    const binding = createPdfArtifacts(root);
    const html = '<form><label for="resume">Resume</label><input id="resume" type="file"></form>';
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      const resume = schema.fields[0];
      const receipt = await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema, [{ field_id: resume.id, status: 'READY', semantic_type: 'RESUME', proposed_value: 'CV_VALIDATED_ARTIFACT' }]), controller, cvArtifact: binding });
      assert.equal(receipt.upload_verified, true);
      assert.equal(receipt.cv_artifact_ref, binding.artifactRef);
      assert.equal(receipt.cv_artifact_sha256, binding.artifactSha256);
      assert.equal(receipt.filled_fields[0].actual_status, 'UPLOAD_VERIFIED');
    } finally { await controller.close(); }
  });
});

test('foreign artifact and symlink/path traversal are refused', async () => {
  await withRoot(async (root) => {
    const binding = createPdfArtifacts(root);
    const controller = await fixture('<form><label for="resume">Resume</label><input id="resume" type="file"></form>', root);
    try {
      const field = (await controller.inspect()).schema.fields[0];
      await assert.rejects(controller.attachValidatedFile({ fieldId: field.id, ...binding, artifactRef: '../latest.pdf' }), /artifact|path|reference/i);
      await assert.rejects(controller.attachValidatedFile({ fieldId: field.id, ...binding, artifactRef: 'app-222222222222222222222222/cv.pdf' }), /foreign|application/i);
    } finally { await controller.close(); }
  });
});

test('same-name same-size existing PDF is rejected unless its content hash matches the bound artifact', async () => {
  await withRoot(async (root) => {
    const binding = createPdfArtifacts(root);
    const html = `<form><label for="resume">Resume</label><input id="resume" type="file"></form><script>const transfer=new DataTransfer();transfer.items.add(new File(['%PDF-1.7\\nbadcontent fixture PDF'],'cv-validated.pdf',{type:'application/pdf'}));document.querySelector('#resume').files=transfer.files;</script>`;
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      await assert.rejects(executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema, [{ field_id: schema.fields[0].id, status: 'READY', semantic_type: 'RESUME', proposed_value: 'CV_VALIDATED_ARTIFACT' }]), controller, cvArtifact: binding }), /different resume|hash|content/i);
    } finally { await controller.close(); }
  });
});

test('conditional field reveal stops after first mutation and journals verified progress', async () => {
  await withRoot(async (root) => {
    const html = `<form><label for="country">Country</label><select id="country"><option value="">Choose</option><option value="ca">Canada</option></select></form><script>document.querySelector('#country').addEventListener('change',function(){document.querySelector('form').insertAdjacentHTML('beforeend',"<label for='new-q'>New required question</label><input id='new-q' required>")})</script>`;
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      const field = schema.fields[0];
      await assert.rejects(executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema, [{ field_id: field.id, status: 'READY', semantic_type: 'LOCATION', proposed_value: 'ca' }]), controller }), /conditional|schema|security/i);
      const progress = await controller.getProgress();
      assert.ok(progress.some((item) => item.field_id === field.id && item.status === 'MUTATED_AND_VERIFIED'));
      assert.equal((await controller.inspect()).schema.fields.some((item) => item.id === 'new-q'), true);
    } finally { await controller.close(); }
  });
});

test('mutation intent with no verified value fails closed instead of replaying uncertain input', async () => {
  await withRoot(async (root) => {
    const controller = await fixture(htmlWithEmail(), root);
    try {
      const schema = (await controller.inspect()).schema;
      await controller.recordProgress({ field_id: 'email', status: 'MUTATION_STARTED', expected_value_hash: hash('candidate@example.com') });
      await assert.rejects(executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema), controller }), /mutation began|mutation progress|uncertain/i);
      assert.equal((await controller.readField({ fieldId: 'email' })), '');
      assert.equal(controller.getMetrics().field_mutation_count, 0);
    } finally { await controller.close(); }
  });
});

test('auth and CAPTCHA blockers stop before mutation', async () => {
  for (const [html, expected] of [['<main>Please sign in to continue</main>', 'AUTH_REQUIRED'], ['<main>Complete the CAPTCHA</main><div class="g-recaptcha"></div>', 'CAPTCHA_REQUIRED']]) {
    const controller = await fixture(html);
    try { assert.equal((await controller.inspect()).status, expected); }
    finally { await controller.close(); }
  }
});

test('hostile submit handlers are blocked and never reach any application endpoint', async () => {
  await withRoot(async (root) => {
    const html = '<form id="f"><label>Email<input id="email" type="email" oninput="this.form.submit()"></label><script>document.querySelector("#email").addEventListener("input",()=>fetch("https://boards.greenhouse.io/submit",{method:"POST"}));</script></form>';
    const controller = await fixture(html, root);
    try {
      const schema = (await controller.inspect()).schema;
      await assert.rejects(executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema), controller }), /security|interlock|submission|network/i);
      const metrics = controller.getMetrics();
      assert.ok(metrics.blocked_submission_attempts >= 1);
      assert.ok(metrics.mutation_network_events >= 1);
      assert.equal(metrics.submission_requests_delivered, 0);
    } finally { await controller.close(); }
  });
});

test('durable progress makes crash replay idempotent and refuses later user edits', async () => {
  await withRoot(async (root) => {
    const first = await fixture(htmlWithEmail(), root);
    let schema;
    let firstReceipt;
    try {
      schema = (await first.inspect()).schema;
      firstReceipt = await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(schema), controller: first });
    } finally { await first.close(); }
    const replay = await fixture(htmlWithEmail('candidate@example.com'), root);
    try {
      const live = (await replay.inspect()).schema;
      assert.equal(live.schema_hash, schema.schema_hash);
      const replayReceipt = await executeControlledFill({ authorization: 'FILL_APPLICATION', prepared: prepared(live), controller: replay });
      assert.equal(replayReceipt.receipt_hash, firstReceipt.receipt_hash, 'recovery must produce a deterministic receipt');
      assert.deepEqual((await replay.getProgress()).filter((item) => item.status === 'MUTATED_AND_VERIFIED').length, 1);
    } finally { await replay.close(); }
  });
});
