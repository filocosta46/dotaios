export const ADAPTER_LEVELS = {
  FULL_AUTO: "full-auto",
  BACKFILL_ONLY: "backfill-only",
  MANUAL_ASSIST: "manual-assist",
  UNSUPPORTED: "unsupported",
};

const LEVEL_LABELS = {
  "full-auto": "auto-save",
  "backfill-only": "import only",
  "manual-assist": "paste/import only",
  "unsupported": "not available on this machine",
};

const registry = new Map();

export function registerAdapter(adapter) {
  if (!adapter.name || !adapter.level) {
    throw new Error("Adapter must declare name and level");
  }
  registry.set(adapter.name, adapter);
}

export function getAdapter(name) {
  return registry.get(name) || null;
}

export function listAdapters() {
  return [...registry.values()];
}

export function getLevelLabel(level) {
  return LEVEL_LABELS[level] || level;
}

export function isImportCapable(level) {
  return level === ADAPTER_LEVELS.FULL_AUTO || level === ADAPTER_LEVELS.BACKFILL_ONLY;
}
