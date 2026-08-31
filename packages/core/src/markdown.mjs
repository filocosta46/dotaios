export function escapeMarkdownTableCell(value) {
  const escaped = String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("!", "&#33;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("(", "&#40;")
    .replaceAll(")", "&#41;")
    .replaceAll("`", "&#96;");
  const lines = escaped.split(/\r\n|[\r\n]/u);
  if (lines.length === 1) return escaped;
  return lines.map((line, index) => {
    if (index === 0) return line.trimEnd();
    if (index === lines.length - 1) return line.trimStart();
    return line.trim();
  }).join(" ");
}
