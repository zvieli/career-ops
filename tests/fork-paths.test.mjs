// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForkPaths, pathCoveredByManifest } from '../lib/fork-paths.mjs';

test('fork path manifest accepts exact paths and directory prefixes', () => {
  const paths = parseForkPaths('# fork-owned files\nsrc/agent/\nREADME.fork.md\n', {
    systemPaths: ['package.json'], userPaths: ['cv.md']
  });
  assert.deepEqual(paths, ['src/agent/', 'README.fork.md']);
  assert.equal(pathCoveredByManifest('src/agent/graph/graph.mjs', paths), true);
  assert.equal(pathCoveredByManifest('README.fork.md', paths), true);
  assert.equal(pathCoveredByManifest('src/agent-sibling/file.mjs', paths), false);
  assert.equal(pathCoveredByManifest('unlisted.mjs', paths), false);
});

test('fork path manifest rejects malformed, duplicate, and updater-overlapping declarations', () => {
  for (const source of ['/absolute/path\n', '../escape\n', 'src//agent/\n', 'src/agent/\nsrc/agent/\n']) {
    assert.throws(() => parseForkPaths(source), /invalid|duplicate/i);
  }
  assert.throws(() => parseForkPaths('package.json\n', { systemPaths: ['package.json'] }), /overlap/i);
  assert.throws(() => parseForkPaths('docs/\n', { systemPaths: ['docs/'] }), /overlap/i);
  assert.throws(() => parseForkPaths('docs/archive/\n', { systemPaths: ['docs/'] }), /overlap/i);
});
