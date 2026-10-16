// Release boundary for the canonical CLI apply mode: answer preparation is
// allowed, live-form mutation and tailored-CV-as-fact-source are not.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\napply mode: manual-entry boundary and candidate-fact provenance');
const applyFiles = ['modes/apply.md'];
const boundary = '**Release safety boundary — manual entry only:**';
const factBoundary = '**Candidate-fact boundary:**';
const ok = (name, condition, why) => (condition ? pass(name) : fail(`${name} — ${why}`));

ok('the canonical apply mode is selected', applyFiles.length === 1,
  `expected the one maintained apply mode, found ${applyFiles.length}`);
for (const file of applyFiles) {
  const text = readFileSync(join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
  ok(`${file} states the release safety boundary`, text.includes(boundary),
    'the apply mode must prohibit agent-side live form mutation and reserve entry/upload/submission for the candidate');
  ok(`${file} preserves primary-source fact grounding`, text.includes(factBoundary),
    'every apply mode must keep generated CVs/reports from becoming independent factual sources');
}

const mode = readFileSync(join(ROOT, 'modes/apply.md'), 'utf8').replace(/\s+/g, ' ');
for (const [name, probe, reason] of [
  ['allows read-only form inspection only', 'read the visible questions without changing the page', 'the assistant may inspect the form only to understand what the candidate asks it to answer'],
  ['forbids field entry, upload, and form navigation actions', 'Never enter or change a value, select an option, upload a file, or click a form control', 'the live application remains under the candidate\'s control'],
  ['uses primary candidate-authored sources', '`cv.md`, `config/profile.yml`, `article-digest.md`, and `modes/_profile.md`', 'primary candidate-authored files must ground factual claims'],
  ['keeps tailored CVs as drafts, not evidence', 'Generated tailored CVs are drafts, not independent factual sources', 'generated output cannot outrank its source'],
  ['leaves missing or conflicting claims blank for confirmation', 'leave the answer blank and set `needs_confirmation:true`', 'unsupported or conflicting facts must not be guessed'],
  ['requires explicit confirmation before recording filled state', 'the candidate explicitly confirms that they personally entered and reviewed the answers', 'the agent cannot claim external form state'],
]) ok(name, mode.includes(probe.replace(/\s+/g, ' ')), reason);

ok('the old tailored-CV precedence is absent', !mode.includes('the tailored CV wins'),
  'a generated document cannot override cv.md');
ok('the mode does not tell the agent to type, fill, click, or upload live fields',
  !/Agent.{0,60}(?:fill|type|upload|click).{0,60}(?:field|form|Submit)/i.test(mode),
  'the live-action instruction remains reachable');

const skill = readFileSync(join(ROOT, '.agents', 'skills', 'career-ops', 'SKILL.md'), 'utf8');
const applyLine = skill.split('\n').find(line => line.includes('/career-ops apply')) ?? '';
const delegated = skill.split('### Modes delegated to subagent')[1] ?? '';
ok('skill router describes apply as manual-entry answer preparation',
  /manual-entry application answer preparation/i.test(applyLine),
  'the user-facing route still advertises a live application assistant');
ok('apply is not delegated to a Playwright-enabled subagent',
  !/^Applies to:.*\bapply\b/m.test(delegated),
  'the router still dispatches apply to a browser-capable worker');
