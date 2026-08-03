// Gumroad license verification.
//
// This lives in the CLI adapter layer, not in packages/core: CLAUDE.md hard
// rule 6 keeps core local-first and offline, and network belongs in
// ingest/adapters/plugins. `packages/core/src/licenses.mjs` owns the local
// license store and takes whichever verifier the caller supplies; this module
// is the one that actually reaches a vendor.

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

export async function verifyGumroadLicense({ productId, key, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime; upgrade to Node 20+");
  }

  const body = new URLSearchParams({
    product_id: productId,
    license_key: key,
    increment_uses_count: "false"
  });

  let response;
  try {
    response = await fetchImpl(GUMROAD_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
  } catch (error) {
    return { success: false, message: `Could not reach Gumroad: ${error.message}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { success: false, message: `Gumroad returned non-JSON response (status ${response.status})` };
  }

  if (!response.ok || payload.success !== true) {
    return {
      success: false,
      message: payload.message || `Gumroad rejected the license (status ${response.status})`
    };
  }

  return {
    success: true,
    uses: payload.uses ?? null,
    purchase: payload.purchase ?? null
  };
}
