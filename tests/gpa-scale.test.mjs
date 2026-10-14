import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExplicitGpaScale } from '../lib/gpa-scale.mjs';

test('explicit slash and out-of scales are read without inferring scale-less values', () => {
  assert.equal(extractExplicitGpaScale('Minimum GPA: 85/100', 85), '100-point');
  assert.equal(extractExplicitGpaScale('Minimum GPA 3.5 out of 4.0', 3.5), '4.0-point');
  assert.equal(extractExplicitGpaScale('Minimum GPA of 85', 85), null);
  assert.equal(extractExplicitGpaScale('Minimum GPA 85/100', 3.5), null);
});
