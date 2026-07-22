// Foreground-only update check.
//
// DotAIOS is local-first: there is no server, no telemetry, and no background
// update daemon. This runs ONLY when the user explicitly asks for a health
// check (`dotaios doctor`), makes a single plain GET to the npm registry — the
// same host the CLI is already installed from — and sends no user data, no
// body, and no identifiers beyond what any npm download reveals.
//
// It is deliberately fail-open: offline, slow, or malformed responses degrade
// to "skipped" so a health check never breaks on a plane. It never throws.

const REGISTRY_URL = "https://registry.npmjs.org/dotaios/latest";
const DEFAULT_TIMEOUT_MS = 1500;
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

function skip(currentVersion, reason) {
  return { current: currentVersion, latest: null, updateAvailable: false, skipped: reason };
}

// "0", "false" and "" read as "not disabled" — a bare truthiness test would
// turn DOTAIOS_NO_UPDATE_CHECK=0 into the opposite of what the user meant.
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

function isOptedOut(env) {
  const raw = env?.DOTAIOS_NO_UPDATE_CHECK;
  if (raw === undefined || raw === null) return false;
  return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

/**
 * Ask npm whether a newer DotAIOS has been published.
 *
 * Returns { current, latest, updateAvailable, skipped? }. Never throws: any
 * failure (opt-out, no fetch, offline, timeout, bad status, bad payload)
 * comes back as `skipped` with updateAvailable false.
 */
export async function checkForUpdate({
  currentVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  registryUrl = REGISTRY_URL,
  env = process.env
} = {}) {
  if (isOptedOut(env)) return skip(currentVersion, "disabled");
  if (typeof fetchImpl !== "function") return skip(currentVersion, "no-fetch");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;
  try {
    const response = await fetchImpl(registryUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response?.ok) return skip(currentVersion, `status-${response?.status ?? "unknown"}`);
    payload = await response.json();
  } catch {
    // Distinguish "we gave up waiting" from a plain network failure so the
    // caller can say something honest, but never surface the error itself.
    return skip(currentVersion, controller.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }

  const latest = payload?.version;
  const comparison = compareVersions(currentVersion, latest);
  if (comparison === null) return skip(currentVersion, "unparseable");

  return {
    current: currentVersion,
    latest: String(latest),
    // Only a strictly newer published version counts — a local/unreleased build
    // ahead of the registry must never be told to "update".
    updateAvailable: comparison < 0
  };
}
