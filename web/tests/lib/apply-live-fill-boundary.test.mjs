import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fillRoute = readFileSync(join(root, "src/app/api/apply/fill/route.ts"), "utf8");
const driveRoute = readFileSync(join(root, "src/app/api/apply/drive/route.ts"), "utf8");
const view = readFileSync(join(root, "src/components/apply-view.tsx"), "utf8");
const page = readFileSync(join(root, "src/app/apply/page.tsx"), "utf8");
const provider = readFileSync(join(root, "src/components/apply/apply-provider.tsx"), "utf8");
const session = readFileSync(join(root, "src/lib/apply/session.ts"), "utf8");
const sessionRoute = readFileSync(join(root, "src/app/api/apply/session/route.ts"), "utf8");

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

test("session opening never activates an employer Apply control", () => {
  const start = session.indexOf("export async function openSession(");
  const end = session.indexOf("\nexport function getSession(", start);
  assert.ok(start >= 0 && end > start, "openSession implementation is present");
  const openSession = session.slice(start, end);
  assert.doesNotMatch(openSession, /tryApplyTrigger|\.click\s*\(/);
  assert.doesNotMatch(session, /tryApplyTrigger/);
  assert.doesNotMatch(sessionRoute, /_noApplyBtn/);
});

test("the apply UI removes live-fill actions and directs the user to manual entry", () => {
  assert.doesNotMatch(view, /onClick=\{a\.(?:fill|agentFill)\}/);
  assert.match(view, /Review and transfer any answers yourself/);
  assert.doesNotMatch(view, /attached automatically|AI is filling the form|filling the real form behind the scenes/i);
  assert.doesNotMatch(provider, /\b(?:fill|agentFill):\s*\(\)\s*=>/);
  assert.doesNotMatch(provider, /fetch\("\/api\/apply\/(?:fill|drive)"/);
});

test("web apply copy describes a local answer draft, not live form filling", () => {
  assert.match(page, /answer drafts/i);
  assert.match(page, /never enters answers|never fills them/i);
  assert.doesNotMatch(page, /fills the real form behind the scenes|pre-filled from your CV/i);
});
