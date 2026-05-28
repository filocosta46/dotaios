export const ADAPTER_LEVELS = {
  FULL_AUTO: "full-auto",
  BACKFILL_ONLY: "backfill-only",
  MANUAL_ASSIST: "manual-assist",
  UNSUPPORTED: "unsupported",
};

export const MEMORY_BACKEND_KIND = {
  ADAPTER: "adapter",
  FALLBACK: "fallback",
  NONE: "none",
};

const LEVEL_LABELS = {
  "full-auto": "auto-save",
  "backfill-only": "import only",
  "manual-assist": "paste/import only",
  "unsupported": "not available on this machine",
};

export function getLevelLabel(level) {
  return LEVEL_LABELS[level] || level;
}
