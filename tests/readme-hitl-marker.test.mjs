// The canonical README keeps the human-governed submission guarantee anchored
// inside its table row, where it cannot split the rendered table.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nREADME HITL guarantee marker');

const file = 'README.md';
const content = readFileSync(join(ROOT, file), 'utf8');
const marker = '<!-- hitl: absolute guarantee.';
const count = content.split(marker).length - 1;
if (count !== 1) {
  fail(`${file}: expected exactly one HITL marker, found ${count}`);
} else {
  const line = content.split('\n').find((item) => item.includes(marker)) ?? '';
  if (!line.trimStart().startsWith('|') || (line.match(/\|/g) || []).length < 2) {
    fail(`${file}: HITL marker sits outside a table row`);
  } else {
    pass(`${file}: HITL marker remains inside its guarantee row`);
  }
  const start = line.indexOf(marker);
  const end = line.indexOf('-->', start);
  const prose = end < 0 ? null : line.slice(0, start) + line.slice(end + 3);
  if (prose === null) fail(`${file}: HITL marker comment is not closed`);
  else if (!/never submits an application/i.test(prose)) fail(`${file}: guarantee no longer says applications are never submitted`);
  else if (/\b(usually|generally|normally|typically|by default|unless|without your permission|automatically|by itself)\b/i.test(prose)) {
    fail(`${file}: guarantee is hedged rather than absolute`);
  } else pass(`${file}: submission prohibition remains absolute`);
}

if (content.includes('A-H') || content.includes('A–H')) pass(`${file}: report structure is current`);
else fail(`${file}: report structure is missing A-H`);
