// tests/verdict-lead-block.test.mjs: the `## Verdict (lead)` block is part of the
// report contract, in every evaluation mode and in the batch worker prompt.
//
// Moved out of test-all.mjs: new tests belong in their own auto-discovered
// file, not as a section of the harness (CONTRIBUTING.md, tests/README.md).
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, warn, ROOT } from './helpers.mjs';

console.log('\nVerdict (lead) block across evaluation modes');

function readFile(path) {
  const fullPath = join(ROOT, path);
  let content = readFileSync(fullPath, 'utf-8');
  if (content.trim().startsWith('..') && content.trim().split('\n').length === 1) {
    const target = join(dirname(fullPath), content.trim());
    if (existsSync(target)) {
      content = readFileSync(target, 'utf-8');
    }
  }
  return content;
}

// The heading shape the report parser recognizes. web/src/lib/report-sections.mjs
// (imported by web/src/components/report-view.tsx) splits a body on /^##\s+(.*)$/
// and promotes a heading ending in `(lead)` or `(verdict)`. The mode contract
// requires the language-invariant `(lead)` marker (modes/oferta.md), so this
// guard matches `(lead)` only. `##` must be followed by whitespace, any kind
// but a newline, as `\s` reads it there. `##Verdict (lead)` and
// `### Verdict (lead)` are not sections at all, and a guard that accepted them
// would pass on a heading the web view never promotes.
const LEAD_HEADING = /^##[^\S\n]+[^\n]*\(lead\)[^\S\n]*$/gmi;
const leadHeadings = (text) => {
  LEAD_HEADING.lastIndex = 0;
  return [...text.matchAll(LEAD_HEADING)];
};

// The guard itself: it must accept every `(lead)` heading the parser promotes
// and reject what the parser does not read as a heading. A bare `## Verdict`
// and a `(verdict)` heading are promoted by the parser and rejected here on
// purpose, because the `(lead)` marker is the contract.
//
// web/ is not in update-system.mjs's SYSTEM_PATHS but tests/ is, so this file
// reaches checkouts with no web/ at all, where a static import would fail the
// whole file (#1675 / #1677). Only this check needs the parser, so only this
// check is skipped; a parser missing under a present web/ is a move and fails.
const WEB_REPORT_SECTIONS = join(ROOT, 'web', 'src', 'lib', 'report-sections.mjs');
if (!existsSync(join(ROOT, 'web', 'src'))) {
  warn('web/ not present in this checkout, skipping the lead-heading parser check');
} else if (!existsSync(WEB_REPORT_SECTIONS)) {
  fail('web/ exists but web/src/lib/report-sections.mjs is missing, so the lead-heading parser check cannot run (moved?)');
} else {
  const { splitSections, isVerdictHeading } = await import(pathToFileURL(WEB_REPORT_SECTIONS).href);
  const accepted = ['## Verdict (lead)', '## Veredicto (lead)', '## 结论 (lead)', '##\tVeredicto (lead)', '##\u00a0Verdict (lead)'];
  const rejected = ['##Verdict (lead)', '### Verdict (lead)', '#Verdict (lead)', 'Verdict (lead)'];
  const contractRejected = ['## Veredicto (verdict)', '## Verdict'];
  const parserPromotes = (line) =>
    splitSections(`${line}\nbody`).sections.some((sec) => isVerdictHeading(sec.heading));
  const wrong = [
    ...accepted.filter((l) => leadHeadings(l).length !== 1 || !parserPromotes(l)),
    ...rejected.filter((l) => leadHeadings(l).length !== 0 || parserPromotes(l)),
    ...contractRejected.filter((l) => leadHeadings(l).length !== 0 || !parserPromotes(l)),
  ];
  if (wrong.length > 0) {
    fail(`lead-heading guard misjudges, against the report parser or the (lead) contract: ${wrong.map((l) => JSON.stringify(l)).join(', ')}`);
  } else {
    pass(`lead-heading guard matches the report parser on ${accepted.length} accepted and ${rejected.length} rejected headings, and rejects ${contractRejected.length} the parser promotes without the (lead) marker`);
  }
}

// The fork ships one evaluation template, so assert its report block and the
// batch prompt directly instead of walking translated copies.
{
  const source = readFile('modes/oferta.md');
  const g = source.indexOf('## G)');
  const lead = source.indexOf('## Verdict (lead)', g);
  const risk = source.indexOf('## Risk Summary', g);
  if (g >= 0 && lead > g && risk > lead && leadHeadings(source).some(({ index }) => g < index && index < risk)) {
    pass('canonical English evaluation mode emits Verdict (lead) between Block G and Risk Summary');
  } else {
    fail('canonical evaluation mode is missing the Verdict (lead) block between Block G and Risk Summary');
  }

  const emitted = readFile('batch/batch-prompt.md');
  const batchG = emitted.indexOf('- `## G) Posting Legitimacy`');
  const batchLead = batchG < 0 ? -1 : emitted.indexOf('- `## Verdict (lead)`', batchG);
  const batchRisk = batchLead < 0 ? -1 : emitted.indexOf('- `## Risk Summary`', batchLead);
  if (batchG >= 0 && batchLead > batchG && batchRisk > batchLead) {
    pass('batch workers emit `## Verdict (lead)` between Block G and Risk Summary');
  } else {
    fail('batch prompt is missing Verdict (lead) between Block G and Risk Summary');
  }
}
