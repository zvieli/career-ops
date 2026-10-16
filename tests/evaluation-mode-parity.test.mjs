import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ROOT, rmSync } from './helpers.mjs';
import { KNOWN_EVALUATION_MODES, discoverEvaluationModes, readModeText, structuralGaps } from './evaluation-mode-parity-helpers.mjs';

const REPORT = `# Evaluation: {Company} — {Role}

**Date:** {date}
**URL:** {url}
**Archetype:** {archetype}
**Score:** {score}
**Legitimacy:** {tier}
**PDF:** {pdf}

## Machine Summary
{machine fields}
## A) Role Summary
{role}
## B) Match
{match}
## C) Level
{level}
## D) Compensation
{compensation}
## E) Customization
{customization}
## F) Interview
{interview}
## G) Legitimacy
{legitimacy}
## Risk Summary
{risks}
## H) Answers
{answers}
`;
const mode = (body = REPORT, fence = '```') => `# Mode instructions\n\n${fence}markdown\n${body}${fence}\n`;

function sandbox(t) {
  const parent = mkdtempSync(join(tmpdir(), 'career-ops-parity-'));
  const root = join(parent, 'repo');
  mkdirSync(join(root, 'modes'), { recursive: true });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

test('the canonical English evaluation mode is the only discovered template', () => {
  assert.deepEqual(KNOWN_EVALUATION_MODES, ['oferta.md']);
  assert.deepEqual(discoverEvaluationModes(ROOT), ['oferta.md']);
  assert.deepEqual(structuralGaps(readModeText(ROOT, 'modes/oferta.md')), []);
});

test('stale localized files cannot enter the supported evaluation inventory', (t) => {
  const { root } = sandbox(t);
  mkdirSync(join(root, 'modes', 'de'), { recursive: true });
  writeFileSync(join(root, 'modes', 'de', 'angebot.md'), mode());
  assert.deepEqual(discoverEvaluationModes(root), []);
  writeFileSync(join(root, 'modes', 'oferta.md'), mode());
  assert.deepEqual(discoverEvaluationModes(root), ['oferta.md']);
});

test('a missing H answers section is reported', () => {
  assert.ok(structuralGaps(mode(REPORT.replace('## H) Answers\n{answers}\n', ''))).includes('## H)'));
});

test('a localized H1, CRLF and either Markdown fence spelling remain valid', () => {
  assert.deepEqual(structuralGaps(mode()), []);
  assert.deepEqual(structuralGaps(mode(REPORT, '~~~~').replace(/\n/g, '\r\n')), []);
  assert.deepEqual(structuralGaps(mode(REPORT.replace('## B) Match', '##\tB)\tMatch'))), []);
});

test('an H3 cannot stand in for a required report H2', () => {
  assert.ok(structuralGaps(mode(REPORT.replace('## B) Match', '### B) Match'))).includes('## B)'));
});

test('HTML comments cannot supply a heading or an entire report template', () => {
  assert.ok(structuralGaps(mode(REPORT.replace('## B) Match', '<!-- ## B) Match -->'))).includes('## B)'));
  assert.deepEqual(structuralGaps(`<!--\n${mode()}\n-->`), ['expected one fenced report template, found 0']);
});

test('missing header labels cannot be rescued by prose or the report body', () => {
  const missing = REPORT.replace('**PDF:** {pdf}\n', '');
  assert.ok(structuralGaps(`${mode(missing)}\nDocumentation mentions **PDF:**\n`).includes('**PDF:** in report header'));
  assert.ok(structuralGaps(mode(missing + '\n**PDF:** body note\n')).includes('**PDF:** in report header'));
  const afterMachineSummary = missing.replace('## Machine Summary\n', '## Machine Summary\n**PDF:** too late\n');
  assert.ok(structuralGaps(mode(afterMachineSummary)).includes('**PDF:** in report header'));
});

test('commented and inline-code labels do not count as header fields', () => {
  for (const replacement of ['<!-- **PDF:** {pdf} -->', '`**PDF:** {pdf}`']) {
    assert.ok(structuralGaps(mode(REPORT.replace('**PDF:** {pdf}', replacement))).includes('**PDF:** in report header'));
  }
});

test('later corrected literals cannot hide duplicated or misordered sections', () => {
  const misordered = REPORT.replace('## G) Legitimacy\n{legitimacy}\n## Risk Summary\n{risks}',
    '## Risk Summary\n{risks}\n## G) Legitimacy\n{legitimacy}');
  assert.ok(structuralGaps(mode(misordered)).some(gap => gap.startsWith('report section order')));
  const appended = misordered + '\n## G) Legitimacy\n## Risk Summary\n## H) Answers\n';
  assert.ok(structuralGaps(mode(appended)).includes('duplicate ## G)'));
});

test('a legal in-root one-line pointer reads the canonical template', (t) => {
  const { root } = sandbox(t);
  writeFileSync(join(root, 'template.md'), mode());
  writeFileSync(join(root, 'modes', 'oferta.md'), '../template.md\r\n');
  assert.equal(readModeText(root, 'modes/oferta.md'), mode());
  assert.deepEqual(structuralGaps(readModeText(root, 'modes/oferta.md')), []);
});

test('an outside-root pointer is rejected before it can supply a report', (t) => {
  const { parent, root } = sandbox(t);
  const outside = join(parent, 'outside.md');
  writeFileSync(outside, mode());
  writeFileSync(join(root, 'modes', 'oferta.md'), '../../outside.md\n');
  assert.throws(() => readModeText(root, 'modes/oferta.md'), /leaves the repository root/);
  assert.throws(() => readModeText(root, '../outside.md'), /leaves the repository root/);
  rmSync(outside);
  assert.throws(() => readModeText(root, 'modes/oferta.md'), /leaves the repository root/);
});

test('directory targets and missing in-root pointers fail loudly', (t) => {
  const { root } = sandbox(t);
  writeFileSync(join(root, 'modes', 'oferta.md'), '..\n');
  assert.throws(() => readModeText(root, 'modes/oferta.md'), /not a regular file/);
  writeFileSync(join(root, 'modes', 'oferta.md'), '../missing.md\n');
  assert.throws(() => readModeText(root, 'modes/oferta.md'), { code: 'ENOENT' });
});

test('real symlinks preserve legal in-root aliases and reject root escape', (t) => {
  const { parent, root } = sandbox(t);
  writeFileSync(join(root, 'template.md'), mode());
  writeFileSync(join(parent, 'outside.md'), mode());
  try {
    symlinkSync('../template.md', join(root, 'modes', 'oferta.md'), 'file');
    assert.equal(readModeText(root, 'modes/oferta.md'), mode());
    rmSync(join(root, 'modes', 'oferta.md'));
    symlinkSync('../../outside.md', join(root, 'modes', 'oferta.md'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows file symlink creation requires developer mode or administrator rights');
      return;
    }
    throw error;
  }
  assert.throws(() => readModeText(root, 'modes/oferta.md'), /leaves the repository root/);
});
