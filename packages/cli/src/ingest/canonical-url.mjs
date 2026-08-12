const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set([
  "ref",
  "ref_src",
  "ref_url",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "yclid",
  "_hsenc",
  "_hsmi",
  "igshid",
  "vero_id",
  "vero_conv"
]);

/**
 * Canonicalize a URL for deduplication.
 * - Lowercases protocol + host.
 * - Removes fragment.
 * - Strips known tracking query parameters.
 * - Removes trailing slash on the path (except root).
 * - Sorts remaining query params for stable comparison.
 *
 * Throws on invalid URLs.
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalizeUrl(input) {
  const url = new URL(input);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  const params = url.searchParams;
  const toDelete = [];
  for (const key of params.keys()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAM_NAMES.has(lower)) {
      toDelete.push(key);
      continue;
    }
    if (TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) params.delete(key);

  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of sorted) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

export const TRACKING_PARAMS = {
  prefixes: [...TRACKING_PARAM_PREFIXES],
  names: [...TRACKING_PARAM_NAMES]
};
