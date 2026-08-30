export function escapeMarkdownTableCell(value) {
  const escaped = String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|");
  const lines = escaped.split(/\r?\n/u);
  if (lines.length === 1) return escaped;
  return lines.map((line, index) => {
    if (index === 0) return line.trimEnd();
    if (index === lines.length - 1) return line.trimStart();
    return line.trim();
  }).join(" ");
}
