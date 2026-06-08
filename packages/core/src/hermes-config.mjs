import fs from "node:fs/promises";

// Conservative editor for `skills.external_dirs` in Hermes config.yaml.
// Handles: inline empty `external_dirs: []` and block list under `skills:`.
// Anything else → { action: "manual" } and leaves the file untouched.
export async function ensureExternalSkillsDir({ configPath, skillsPath, dryRun = false }) {
  let text;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return { action: "manual", reason: "config not found" };
  }
  const lines = text.split("\n");
  // exact-line match, not substring (avoid `/aios/skills` matching `/aios/skills-backup`)
  if (lines.some((l) => l.trim() === `- ${skillsPath}`)) return { action: "already-present" };
  const skillsIdx = lines.findIndex((l) => /^skills:\s*$/.test(l));
  if (skillsIdx === -1) return { action: "manual", reason: "no skills: section" };

  // find `external_dirs:` within the skills block (2-space indented)
  let edIdx = -1;
  for (let i = skillsIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;                 // left the skills: block
    if (/^\s{2}external_dirs:/.test(lines[i])) { edIdx = i; break; }
  }
  if (edIdx === -1) return { action: "manual", reason: "no external_dirs key" };

  const item = `    - ${skillsPath}`;
  if (/external_dirs:\s*\[\s*\]\s*$/.test(lines[edIdx])) {
    lines[edIdx] = "  external_dirs:";
    lines.splice(edIdx + 1, 0, item);
  } else if (/external_dirs:\s*$/.test(lines[edIdx])) {
    // insert after the last existing `    - ` item (or right after the key)
    let insertAt = edIdx + 1;
    while (insertAt < lines.length && /^\s{4}- /.test(lines[insertAt])) insertAt++;
    lines.splice(insertAt, 0, item);
  } else {
    return { action: "manual", reason: "unexpected external_dirs shape" };
  }

  if (!dryRun) await fs.writeFile(configPath, lines.join("\n"));
  return { action: dryRun ? "would-add" : "added" };
}
