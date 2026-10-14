import test from 'node:test';
import assert from 'node:assert/strict';
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

test('blocks legal and sensitive fields even when mapping says READY', async () => {
  const state = setup({ fields: [{ id: 'auth', name: 'authorized_to_work', label: 'Are you authorized to work?', type: 'text', required: true }], values: { auth: 'Yes' } });
  state.prepared.mappings[0].semantic_type = 'WORK_AUTHORIZATION';
  state.prepared.schema_hash = (await state.adapter.inspectApplication({})).schema.schema_hash;
  await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' }), /blocked field/);
  assert.equal(state.writes(), 0);
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

test('does not overwrite a field changed by the user on replay', async () => {
  const state = setup();
  const schema = (await state.adapter.inspectApplication({})).schema;
  state.prepared.schema_hash = schema.schema_hash;
  const priorReceipt = await executeControlledFill({ ...state, authorization: 'FILL_APPLICATION' });
  state.adapter.readField = async () => 'user-edited@example.net';
  await assert.rejects(executeControlledFill({ ...state, authorization: 'FILL_APPLICATION', previousReceipt: priorReceipt }), /user-modified/);
  assert.equal(state.writes(), 1);
});
