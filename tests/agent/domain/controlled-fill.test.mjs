import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import * as fillContract from '../../../src/agent/domain/applications/controlled-fill.mjs';
const { executeControlledFill } = fillContract;
import { extractApplicationFormSchema } from '../../../src/agent/domain/applications/ats-preparation.mjs';

test('fill runtime exports no submission-capable function', () => {
  assert.deepEqual(Object.keys(fillContract), ['executeControlledFill']);
});

function setup({ fields = [{ id: 'email', name: 'email', label: 'Email', type: 'email', required: true }], values = { email: 'candidate@example.com' } } = {}) {
  const live = new Map(fields.map((field) => [field.id, '']));
  let writes = 0;
  const adapter = {
    mode: 'FIXTURE_TEST', provider: 'GREENHOUSE',
    inspectApplication: async () => ({ provider: 'GREENHOUSE', url: 'https://boards.greenhouse.io/acme/jobs/1', schema: extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields }) }),
    fillField: async ({ fieldId, value }) => { writes++; live.set(fieldId, value); },
    readField: async ({ fieldId }) => live.get(fieldId)
  };
  const prepared = {
    application_id: 'app-example', provider: 'GREENHOUSE', application_url: 'https://boards.greenhouse.io/acme/jobs/1',
    schema_hash: 'prepared-schema', mappings: fields.map((field) => ({ field_id: field.id, status: 'READY', semantic_type: 'EMAIL', proposed_value: values[field.id] }))
  };
  return { adapter, prepared, writes: () => writes };
}

test('requires explicit FILL_APPLICATION before any mutation', async () => {
  const state = setup();
  await assert.rejects(executeControlledFill({ ...state, authorization: 'PREPARE_APPLICATION' }), /explicit FILL_APPLICATION/);
  assert.equal(state.writes(), 0);
});

test('revalidates schema and fails closed on drift before mutation', async () => {
  const state = setup();
  state.prepared.schema_hash = 'wrong-hash';
  await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' }), /schema drift/);
  assert.equal(state.writes(), 0);
});

test('browser guard blocks sensitive, demographic, and legal labels despite a READY email mapping', async () => {
  const blockedLabels = [
    'Are you authorized to work?', 'Visa sponsorship required?', 'Citizenship', 'Security clearance',
    'Criminal history', 'Disability status', 'Veteran status', 'Gender identity', 'Race', 'Ethnicity',
    'Religion', 'Religious affiliation', 'Sexual orientation', 'EEO demographic survey',
    'I certify that the information is true', 'I agree to background check consent',
    'Are you willing to relocate?', 'Expected salary', 'Notice period'
  ];
  for (const label of blockedLabels) {
    const state = setup({ fields: [{ id: 'email', name: 'email', label, type: 'text', required: true }], values: { email: 'Yes' } });
    state.prepared.schema_hash = (await state.adapter.inspectApplication({})).schema.schema_hash;
    await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' }), /blocked field/, label);
    assert.equal(state.writes(), 0, label);
  }
});

test('fills exact stable field identity and verifies DOM read-back; receipt is immutable and non-submitting', async () => {
  const state = setup();
  const schema = (await state.adapter.inspectApplication({})).schema;
  state.prepared.schema_hash = schema.schema_hash;
  const receipt = await executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' });
  assert.equal(state.writes(), 1);
  assert.equal(receipt.filled_fields[0].field_id, 'email');
  assert.equal(receipt.submission_performed, false);
  assert.equal(receipt.submit_capability, false);
  assert.equal(Object.isFrozen(receipt), true);
});

test('rejects an adapter exposing submission-capable methods', async () => {
  const state = setup();
  state.adapter.submit = async () => {};
  state.prepared.schema_hash = (await state.adapter.inspectApplication({})).schema.schema_hash;
  await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' }), /exposing only/);
  assert.equal(state.writes(), 0);
});

test('rejects prototype-inherited submit capability', async () => {
  const state = setup();
  Object.setPrototypeOf(state.adapter, { submit: async () => {} });
  state.prepared.schema_hash = (await state.adapter.inspectApplication({})).schema.schema_hash;
  await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' }), /exposing only/);
  assert.equal(state.writes(), 0);
});

test('controlled local browser fixture verifies a fill and observes zero application POSTs', async () => {
  let applicationPosts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') applicationPosts++;
    response.writeHead(204).end();
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const endpoint = `http://127.0.0.1:${server.address().port}/submit`;
    await page.setContent(`<form action="${endpoint}" method="post"><label>Email <input id="email" type="email"></label><button type="submit">Apply now</button></form>`);
    page.on('request', (request) => { if (request.method() === 'POST') applicationPosts++; });
    const schema = extractApplicationFormSchema({ provider: 'GREENHOUSE', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', fields: [{ id: 'email', name: 'email', label: 'Email', type: 'email' }] });
    const adapter = {
      mode: 'FIXTURE_TEST', provider: 'GREENHOUSE',
      inspectApplication: async () => ({ provider: 'GREENHOUSE', url: 'https://boards.greenhouse.io/acme/jobs/1', schema }),
      fillField: async ({ fieldId, value }) => page.locator(`#${fieldId}`).fill(value),
      readField: async ({ fieldId }) => page.locator(`#${fieldId}`).inputValue()
    };
    const receipt = await executeControlledFill({ authorization: 'FILL_APPLICATION', adapter, prepared: {
      application_id: 'app-fixture', provider: 'GREENHOUSE', application_url: 'https://boards.greenhouse.io/acme/jobs/1', schema_hash: schema.schema_hash,
      mappings: [{ field_id: 'email', status: 'READY', semantic_type: 'EMAIL', proposed_value: 'candidate@example.com' }]
    } });
    assert.equal(await page.locator('#email').inputValue(), 'candidate@example.com');
    assert.equal(receipt.submission_performed, false);
    assert.equal(applicationPosts, 0);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('does not overwrite a field changed by the user on replay', async () => {
  const state = setup();
  const schema = (await state.adapter.inspectApplication({})).schema;
  state.prepared.schema_hash = schema.schema_hash;
  const priorReceipt = await executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' });
  state.adapter.readField = async () => 'user-edited@example.net';
  await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION', previousReceipt: priorReceipt }), /user-modified/);
  assert.equal(state.writes(), 1);
});
