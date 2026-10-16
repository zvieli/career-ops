// The legacy browser-driving route is disabled for the human-governed release.
// Keep this guard so a later change cannot accidentally restore the live stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const route = join(dirname(fileURLToPath(import.meta.url)), "../../src/app/api/apply/drive/route.ts");
const src = readFileSync(route, "utf8");

test("the production browser-drive endpoint is disabled before any session or stream access", () => {
  assert.doesNotMatch(src, /new ReadableStream/);
  assert.doesNotMatch(src, /from [\"']@\/lib\/apply\/(?:session|drive)[\"']/);
  assert.match(src, /Live application form filling is disabled/);
  assert.match(src, /status:\s*410/);
});
