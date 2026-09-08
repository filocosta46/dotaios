const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".obsidian", ".trash"]);
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/,
  /^credentials(?:\.|$)/i,
  /^token(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i
];

export function shouldSkipEntry(name) {
  if (name.startsWith(".") || SKIP_DIR_NAMES.has(name)) return true;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}
