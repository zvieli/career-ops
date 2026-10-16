// The canonical shared rules own the safety contract. The only market
// supplement must stay supplemental and must not invent candidate facts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nmarket-context guardrails');

const requiredGuardrails = [
  ['exclusive candidate sources', /\*\*ONLY\*\* sources for user-facing content/],
  ['authorship boundary', /NEVER claim the user authored a project/],
  ['no-fabrication rule', /Keywords get reformulated, never fabricated/],
  ['source-of-truth contract', /Source-of-Truth Boundary.*full rule/],
  ['manual application boundary', /Submit applications on behalf of the candidate/],
  ['agency confirmation gate', /Agency confirmation must happen before any tracker/],
];
const baseline = readFileSync(join(ROOT, 'modes', '_shared.md'), 'utf8');
const missing = requiredGuardrails.filter(([, pattern]) => !pattern.test(baseline)).map(([name]) => name);
if (missing.length === 0) {
  pass('canonical shared context keeps every required safety guardrail');
} else {
  fail(`canonical shared context is missing safety guardrails: ${missing.join(', ')}`);
}

const israel = readFileSync(join(ROOT, 'modes', 'il', '_shared.md'), 'utf8');
const supplementSafe = [
  /does not replace the baseline evaluation rules/,
  /contains no candidate-specific facts or targeting policy/,
  /Military service.*must never be inferred/s,
  /Citizenship, work authorization, residency, and security clearance are unknown unless supported by the candidate's primary profile or a direct statement in the current conversation/,
  /The candidate must review and submit any application themselves/,
].every((pattern) => pattern.test(israel));
if (supplementSafe) {
  pass('Israeli context remains supplemental and preserves candidate-fact and submission boundaries');
} else {
  fail('Israeli shared context is missing a supplemental, provenance, or human-submission boundary');
}
