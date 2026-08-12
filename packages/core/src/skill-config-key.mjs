const BARE_KEY_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function parseExternalSkillsKey(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const segments = value.split(".");
  if (segments.length !== 2 || !segments.every((segment) => BARE_KEY_SEGMENT.test(segment))) {
    return null;
  }
  return segments;
}

export function isSafeRegistryPathText(value) {
  return typeof value === "string"
    && Boolean(value.trim())
    && !/[\0-\x1f\x7f]/.test(value);
}
