import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const forbidden = [
  /(?:^|\/)child_process(?:\.mjs)?$/i,
  /(?:^|\/)playwright(?:\/|$)/i,
  /(?:^|\/)puppeteer(?:\/|$)/i,
  /\/src\/agent\/graph(?:\/|$)/i,
  /controlled-fill|application-fill|application-submit|human-review-resume-bridge/i,
  /recruiter|calendar-accept|email-sender|outbound-communication/i,
  /notification-outbox\.mjs/i
];
const importPattern = /\bimport\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\bexport\s+(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gs;

function references(source, includeDynamic) {
  const refs = [];
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] || match[2] || match[3];
    const isDynamic = match[0].startsWith('import(');
    if (!includeDynamic && isDynamic) continue;
    refs.push(specifier);
  }
  return refs;
}

test('production scheduler exports no executor or provider fixture injection seam', () => {
  const scheduler = readFileSync(resolve(repo, 'src/agent/runtime/scheduler.mjs'), 'utf8');
  assert.doesNotMatch(scheduler, /runScheduledOnceWithExecutorForTest|createTrustedShadowExecutorForTest|runtime\/testing\//);
  assert.match(scheduler, /createTrustedShadowExecutor/);
  assert.doesNotMatch(scheduler, /dependencies\s*:\s*\{/);
});

test('operator scheduled path has no transitive browser, graph, fill, submission, contact, or calendar imports', () => {
  const pending = [{ path: resolve(repo, 'operator.mjs'), includeDynamic: false }];
  const visited = new Set();
  const imports = [];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    const source = readFileSync(current.path, 'utf8');
    for (const specifier of references(source, current.includeDynamic || current.path !== resolve(repo, 'operator.mjs'))) {
      imports.push(`${current.path}: ${specifier}`);
      assert.equal(forbidden.some(pattern => pattern.test(specifier)), false, `forbidden scheduled import: ${current.path} -> ${specifier}`);
      if (specifier.startsWith('node:') || !specifier.startsWith('.')) continue;
      const target = resolve(dirname(current.path), specifier);
      if (!existsSync(target) || !/\.(?:mjs|js)$/.test(target)) continue;
      pending.push({ path: target, includeDynamic: true });
    }
  }
  assert.ok(imports.some(value => value.includes('scheduler.mjs')));
  assert.ok(imports.some(value => value.includes('trusted-shadow-executor.mjs')));
  assert.equal(imports.some(value => value.includes('scan.mjs')), false);
});
