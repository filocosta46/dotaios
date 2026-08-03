import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_DIR_NAME = ".dotaios";
const FILE_NAME = "licenses.json";

function licenseDir() {
  return process.env.DOTAIOS_LICENSE_DIR
    ? path.resolve(process.env.DOTAIOS_LICENSE_DIR)
    : path.join(os.homedir(), DEFAULT_DIR_NAME);
}

export function licenseFile() {
  return path.join(licenseDir(), FILE_NAME);
}

async function readLicenses() {
  try {
    const content = await fs.readFile(licenseFile(), "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.licenses) ? parsed : { licenses: [] };
  } catch (error) {
    if (error.code === "ENOENT") return { licenses: [] };
    throw error;
  }
}

async function writeLicenses(store) {
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

export async function addLicense({ productId, key, vendor = null, verifier }) {
  if (!productId || typeof productId !== "string") {
    throw new Error("productId is required");
  }
  if (!key || typeof key !== "string") {
    throw new Error("license key is required");
  }
  // Core stays offline (CLAUDE.md hard rule 6). The caller supplies the vendor
  // verifier — see packages/cli/src/adapters/gumroad-license.mjs.
  if (typeof verifier !== "function") {
    throw new Error("a license verifier is required; core does not reach the network");
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
