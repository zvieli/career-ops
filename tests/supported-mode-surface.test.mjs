import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.mjs';

const modesRoot = join(ROOT, 'modes');
const structuralDirectories = new Set(['heuristics', 'il', 'interview', 'pdf', 'regional']);

test('English is the only shipped README language', () => {
  assert.ok(existsSync(join(ROOT, 'README.md')));
  const translated = readdirSync(ROOT).filter((name) => /^README\.[^.]+\.md$/.test(name));
  assert.deepEqual(translated, []);
});

test('the shipped mode tree has one English implementation and only the Israeli supplement', () => {
  const unexpected = readdirSync(modesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !structuralDirectories.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(unexpected, [], `unreviewed market mode directories: ${unexpected.join(', ')}`);

  for (const file of ['oferta.md', 'apply.md', 'pipeline.md', '_shared.md']) {
    assert.ok(existsSync(join(modesRoot, file)), `canonical English mode missing: ${file}`);
  }

  const israelFiles = readdirSync(join(modesRoot, 'il')).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(israelFiles, ['_shared.md'], 'modes/il is supplemental context, not a translated mode set');
});
