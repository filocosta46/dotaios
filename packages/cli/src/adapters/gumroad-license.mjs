// Gumroad license verification.
//
// This lives in the CLI adapter layer, not in packages/core: CLAUDE.md hard
// rule 6 keeps core local-first and offline, and network belongs in
// ingest/adapters/plugins. `packages/core/src/licenses.mjs` owns the local
// license store and takes whichever verifier the caller supplies; this module
// is the one that actually reaches a vendor.

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

// Gumroad answers `success: true` for any key it ever issued, including one
// whose money has already gone back. The reversal flags live on the purchase
// object, so this is the only place to catch them before `addLicense` writes a
// local entry — the store is verified once and read offline forever after.
// Subscription lapses are deliberately not handled: the current offer is
// one-time, and Gumroad's one-shot verify cannot express renewal state.
function reversalReason(purchase) {
  if (!purchase || typeof purchase !== "object") return null;
  if (purchase.refunded === true) return "This purchase was refunded.";
  if (purchase.chargebacked === true) return "This purchase was charged back.";
  if (purchase.disputed === true && purchase.dispute_won !== true) {
    return "This purchase has an open dispute.";
  }
  return null;
}

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

  const reversal = reversalReason(payload.purchase);
  if (reversal) {
    return { success: false, message: reversal };
  }

  return {
    success: true,
    uses: payload.uses ?? null,
    purchase: payload.purchase ?? null
  };
}
