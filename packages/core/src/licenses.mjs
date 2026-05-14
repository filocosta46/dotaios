import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_DIR_NAME = ".dotaios";
const FILE_NAME = "licenses.json";
const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

export function licenseDir() {
  return process.env.DOTAIOS_LICENSE_DIR
    ? path.resolve(process.env.DOTAIOS_LICENSE_DIR)
    : path.join(os.homedir(), DEFAULT_DIR_NAME);
}

export function licenseFile() {
  return path.join(licenseDir(), FILE_NAME);
}

export async function readLicenses() {
  try {
    const content = await fs.readFile(licenseFile(), "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.licenses) ? parsed : { licenses: [] };
  } catch (error) {
    if (error.code === "ENOENT") return { licenses: [] };
    throw error;
  }
}

export async function writeLicenses(store) {
  const dir = licenseDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = licenseFile();
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export async function hasLicense(productId) {
  const store = await readLicenses();
  return store.licenses.some((entry) => entry.product_id === productId);
}

export async function findLicense(productId) {
  const store = await readLicenses();
  return store.licenses.find((entry) => entry.product_id === productId) || null;
}

export async function listLicenses() {
  const store = await readLicenses();
  return store.licenses;
}

export async function removeLicense(productId) {
  const store = await readLicenses();
  const next = store.licenses.filter((entry) => entry.product_id !== productId);
  if (next.length === store.licenses.length) return false;
  await writeLicenses({ licenses: next });
  return true;
}

export async function addLicense({ productId, key, vendor = null, verifier = verifyGumroadLicense }) {
  if (!productId || typeof productId !== "string") {
    throw new Error("productId is required");
  }
  if (!key || typeof key !== "string") {
    throw new Error("license key is required");
  }

  const verification = await verifier({ productId, key });
  if (!verification.success) {
    throw new Error(verification.message || "license verification failed");
  }

  const store = await readLicenses();
  const existing = store.licenses.find((entry) => entry.product_id === productId);
  const entry = {
    product_id: productId,
    vendor: vendor || existing?.vendor || null,
    key,
    verified_at: new Date().toISOString(),
    uses: verification.uses ?? null
  };

  const next = existing
    ? store.licenses.map((item) => (item.product_id === productId ? entry : item))
    : [...store.licenses, entry];

  await writeLicenses({ licenses: next });
  return entry;
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

  return {
    success: true,
    uses: payload.uses ?? null,
    purchase: payload.purchase ?? null
  };
}
