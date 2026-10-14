// @ts-check

/** @typedef {string} RepoPathManifestEntry Exact path or slash-terminated directory prefix. */

/**
 * Parses the fork-owned file manifest. These paths belong to this product fork,
 * not the upstream update-system's SYSTEM_PATHS or the candidate USER_PATHS.
 *
 * @param {string} source
 * @param {{ systemPaths?: string[], userPaths?: string[], localPaths?: string[] }} [options]
 * @returns {RepoPathManifestEntry[]}
 */
export function parseForkPaths(source, { systemPaths = [], userPaths = [], localPaths = [] } = {}) {
  if (typeof source !== 'string') throw new TypeError('Fork path manifest must be text.');
  const paths = [];
  const seen = new Set();
  const updaterPaths = [...systemPaths, ...userPaths, ...localPaths];
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const entry = raw.trim();
    if (!entry || entry.startsWith('#')) continue;
    const body = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const segments = body.split('/');
    if (entry.startsWith('/') || entry.includes('\\') || /^[A-Za-z]:/.test(entry)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Invalid fork path at line ${index + 1}: paths must be relative and contain no empty, dot, or parent segments.`);
    }
    if (seen.has(entry)) throw new Error(`Duplicate fork path at line ${index + 1}: ${entry}`);
    const overlap = updaterPaths.find((path) => manifestsOverlap(entry, path));
    if (overlap) throw new Error(`Fork path overlaps updater-owned path "${overlap}": ${entry}`);
    seen.add(entry);
    paths.push(entry);
  }
  return paths;
}

/** @param {string} file @param {string[]} manifest */
export function pathCoveredByManifest(file, manifest) {
  return manifest.some((entry) => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
}

/** @param {string} left @param {string} right */
function manifestsOverlap(left, right) {
  const leftDir = left.endsWith('/');
  const rightDir = right.endsWith('/');
  if (!leftDir && !rightDir) return left === right;
  if (leftDir && rightDir) return left.startsWith(right) || right.startsWith(left);
  if (leftDir) return right.startsWith(left);
  return left.startsWith(right);
}
