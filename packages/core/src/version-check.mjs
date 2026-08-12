// Pure semver comparison. The update check that actually talks to the npm
// registry lives in packages/cli/src/adapters/npm-registry.mjs — CLAUDE.md hard
// rule 6 keeps packages/core offline.

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

function parseVersion(value) {
  const match = SEMVER_RE.exec(String(value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Numeric semver compare: -1 if a < b, 1 if a > b, 0 if equal. null if unparseable. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}
