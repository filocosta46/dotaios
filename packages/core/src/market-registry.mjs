const ENTRY_STATUSES = new Set(["available", "draft", "planned", "retired"]);
const ENTRY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateMarketRegistry(payload, { source = "registry" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Registry at ${source} must be an object.`);
  }
  const rawEntries = Array.isArray(payload.entries) ? payload.entries : payload.skills;
  if (!Array.isArray(rawEntries)) {
    throw new Error(`Registry at ${source} is missing an "entries" array.`);
  }

  const seen = new Set();
  const entries = rawEntries.map((raw, index) => validateEntry(raw, { index, source }));
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`Registry at ${source} contains duplicate id "${entry.id}".`);
    }
    seen.add(entry.id);
  }
  return { ...payload, entries };
}

function validateEntry(raw, { index, source }) {
  const label = `Registry entry ${index + 1} at ${source}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object.`);
  }

  const id = readString(raw.id);
  if (!id || !ENTRY_ID_RE.test(id)) throw new Error(`${label} has an invalid id.`);
  const name = readString(raw.name);
  if (!name) throw new Error(`${label} is missing name.`);

  const status = readString(raw.status) || "available";
  if (!ENTRY_STATUSES.has(status)) {
    throw new Error(`${label} has invalid status "${status}".`);
  }

  const entry = { ...raw, id, name, status };
  if (status === "draft" || status === "planned") {
    if (raw.checkout_url || raw.gumroad_url) {
      throw new Error(`${label} is ${status} and must not expose a checkout URL.`);
    }
    return entry;
  }
  if (status === "retired") return entry;

  const sourceUrl = readString(raw.git_url) || readString(raw.install_url);
  if (!sourceUrl) {
    throw new Error(`${label} is available but has no git_url or install_url.`);
  }
  if (raw.paid === true) {
    if (!readString(raw.product_id)) throw new Error(`${label} is paid but has no product_id.`);
    if (!readString(raw.checkout_url)) throw new Error(`${label} is paid but has no checkout_url.`);
  }
  return entry;
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
