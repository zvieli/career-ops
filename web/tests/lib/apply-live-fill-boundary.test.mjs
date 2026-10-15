import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fillRoute = readFileSync(join(root, "src/app/api/apply/fill/route.ts"), "utf8");
const driveRoute = readFileSync(join(root, "src/app/api/apply/drive/route.ts"), "utf8");
const view = readFileSync(join(root, "src/components/apply-view.tsx"), "utf8");

test("live deterministic apply fill route fails closed without a session or browser capability", () => {
  assert.doesNotMatch(fillRoute, /from [\"']@\/lib\/apply\/session[\"']/);
  assert.doesNotMatch(fillRoute, /\bfillSession\s*\(/);
  assert.match(fillRoute, /Live application form filling is disabled/);
  assert.match(fillRoute, /status:\s*410/);
});

test("agentic browser drive route cannot mutate a live application form", () => {
  assert.doesNotMatch(driveRoute, /from [\"']@\/lib\/apply\/(?:session|drive)[\"']/);
  assert.doesNotMatch(driveRoute, /\bdriveSession\s*\(/);
  assert.match(driveRoute, /Live application form filling is disabled/);
  assert.match(driveRoute, /status:\s*410/);
});

test("the apply UI removes live-fill actions and directs the user to manual entry", () => {
  assert.doesNotMatch(view, /onClick=\{a\.(?:fill|agentFill)\}/);
  assert.match(view, /enter them yourself on the employer&apos;s site/);
});
