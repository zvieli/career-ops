import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const route = readFileSync(join(root, "src/app/api/apply/prefill/route.ts"), "utf8");
const planner = readFileSync(join(root, "src/lib/apply/planner.ts"), "utf8");

test("prefill diagnostics do not persist model answers or planner output", () => {
  assert.doesNotMatch(route, /apply-prefill\.log|appendFileSync/);
  assert.doesNotMatch(route, /output head:|output tail:/);
  assert.doesNotMatch(planner, /stderr:\s*\$\{/);
  assert.match(planner, /stderr output received \(\$\{d\.length\} bytes; content omitted\)/);
});
