import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = Object.freeze({
  modesDir: "modes",
  modesDirs: Object.freeze(["modes"]),
  evalModeFile: "modes/oferta.md",
});

/**
 * Resolve supported market context without allowing a supplemental directory
 * to replace the canonical English evaluation implementation.
 *
 * @param {string} root Career-ops code root containing the shipped modes/ tree.
 * @param {unknown} rawModesDir profile.yml language.modes_dir value.
 * @returns {{ modesDir: string, modesDirs: string[], evalModeFile: string }}
 */
export function resolveModeConfig(root, rawModesDir) {
  const candidates = Array.isArray(rawModesDir) ? rawModesDir : [rawModesDir];
  const supplements = [];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const candidate = value.trim().replace(/\/+$/, "");
    // This fork ships one supplemental market context. Other market trees may
    // remain in a user's old checkout but are not supported or selected.
    if (candidate !== "modes/il" || supplements.includes(candidate)) continue;
    try {
      if (fs.existsSync(path.join(root, candidate, "_shared.md"))) supplements.push(candidate);
    } catch {
      // An unreadable/missing supplemental context degrades to English-only.
    }
  }
  return {
    modesDir: DEFAULT_CONFIG.modesDir,
    modesDirs: ["modes", ...supplements],
    evalModeFile: DEFAULT_CONFIG.evalModeFile,
  };
}
