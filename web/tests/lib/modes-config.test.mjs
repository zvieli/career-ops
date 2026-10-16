import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveModeConfig } from "../../src/lib/modes-config.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "career-ops-modes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shared = (dir, text = "market context") => {
    const full = path.join(root, dir);
    mkdirSync(full, { recursive: true });
    writeFileSync(path.join(full, "_shared.md"), text);
  };
  return { root, shared };
}

test("mode resolution always uses the canonical English evaluation file by default", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(resolveModeConfig(root), {
    modesDir: "modes",
    modesDirs: ["modes"],
    evalModeFile: "modes/oferta.md",
  });
});

test("modes/il contributes shared context but never replaces English evaluation", (t) => {
  const { root, shared } = fixture(t);
  shared("modes/il");
  assert.deepEqual(resolveModeConfig(root, "modes/il"), {
    modesDir: "modes",
    modesDirs: ["modes", "modes/il"],
    evalModeFile: "modes/oferta.md",
  });
});

test("the canonical directory may be listed with the Israeli supplement without duplication", (t) => {
  const { root, shared } = fixture(t);
  shared("modes/il");
  assert.deepEqual(resolveModeConfig(root, ["modes", "modes/il", "modes/il"]), {
    modesDir: "modes",
    modesDirs: ["modes", "modes/il"],
    evalModeFile: "modes/oferta.md",
  });
});

test("removed locale directories are ignored even if a stale local copy remains", (t) => {
  const { root, shared } = fixture(t);
  shared("modes/de");
  writeFileSync(path.join(root, "modes/de/angebot.md"), "legacy translated evaluation");
  assert.deepEqual(resolveModeConfig(root, ["modes/de", "modes/il"]), {
    modesDir: "modes",
    modesDirs: ["modes"],
    evalModeFile: "modes/oferta.md",
  });
});

test("missing supplemental context and unsafe paths fail closed to the English mode", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(resolveModeConfig(root, ["modes/il", "modes/../../outside"]), {
    modesDir: "modes",
    modesDirs: ["modes"],
    evalModeFile: "modes/oferta.md",
  });
});
