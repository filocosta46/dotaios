import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { createEvidenceReader } from "./evidence-reader.mjs";
import { writeFileSafe } from "./files.mjs";

const MAX_ROUTING_METADATA_BYTES = 64 * 1024;
const MAX_SKILL_SOURCE_BYTES = 8 * 1024 * 1024;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

// `when_to_use` is prose the host appends to the description, so it is written
// with a middot rather than the comma `triggers` uses. Accept both on read.
const TRIGGER_SEPARATOR_RE = /[·,]/;
const TRIGGER_JOINER = " · ";

// Scan <aiosPath>/skills/ for every <name>/SKILL.md and return its metadata.
export async function collectSkills(aiosPath, { reader = null, root = aiosPath } = {}) {
  const activeReader = reader || createEvidenceReader({
    roots: [path.resolve(root)],
    limits: { maxFiles: 512, maxDirectoryEntries: 512 }
  });
  const skillsDir = path.join(aiosPath, "skills");
  const directories = await activeReader.listDirectories(root, skillsDir, {
    maxEntries: 512,
    skipEntry: (name) => name.startsWith(".") || name.startsWith("_")
  });

  const skills = [];
  for (const directoryPath of directories) {
    const dir = path.basename(directoryPath);
    const skillFile = path.join(directoryPath, "SKILL.md");
    const content = await activeReader.readFrontmatter(root, skillFile, {
      allowMissing: true,
      maxBytes: MAX_ROUTING_METADATA_BYTES,
      maxFileBytes: MAX_SKILL_SOURCE_BYTES
    });
    if (content === null) throw skillMetadataError();
    const metadata = parseSkillMetadata(content);

    skills.push({
      dir,
      name: metadata.name || dir,
      description: metadata.description,
      triggers: metadata.triggers,
      whenToUse: metadata.whenToUse
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function parseSkillMetadata(content) {
  if (content === "") {
    return { name: "", description: "", triggers: [], whenToUse: [] };
  }
  const frontmatter = content.match(FRONTMATTER_RE)?.[1];
  if (frontmatter === undefined) throw skillMetadataError();
  const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw skillMetadataError();
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw skillMetadataError();
  return {
    name: optionalMetadataString(metadata.name),
    description: optionalMetadataString(metadata.description),
    triggers: metadataList(metadata.triggers, TRIGGER_SEPARATOR_RE),
    whenToUse: metadataList(metadata.when_to_use, TRIGGER_SEPARATOR_RE)
  };
}

function optionalMetadataString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw skillMetadataError();
  return value.trim();
}

function metadataList(value, separator) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) throw skillMetadataError();
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value !== "string") throw skillMetadataError();
  return value.split(separator).map((entry) => entry.trim()).filter(Boolean);
}

function skillMetadataError() {
  const error = new Error("DotAIOS could not read skill routing metadata safely.");
  error.code = "DOTAIOS_SKILL_METADATA_INVALID";
  return error;
}

// Hosts route on a listing built from `description` (+ `when_to_use` where the
// host documents it). DotAIOS has always authored routing phrases as
// `triggers:`, which no host reads — so the phrases that make
// `dotaios skills resolve` deterministic stayed invisible to the agent actually
// choosing the skill. Report every skill in that state. Preview only: this
// plans the edit, it never writes.
export async function planTriggerVisibility(aiosPath) {
  const skills = await collectSkills(aiosPath);
  return skills
    .filter((skill) => skill.triggers.length > 0 && skill.whenToUse.length === 0)
    .map((skill) => ({
      dir: skill.dir,
      name: skill.name,
      path: path.join(aiosPath, "skills", skill.dir, "SKILL.md"),
      whenToUse: skill.triggers.join(TRIGGER_JOINER)
    }));
}

// Routing phrases are the user's own words, so the writer has to survive their
// punctuation. A YAML plain scalar cannot hold ": " or " #", cannot open with an
// indicator character, and cannot carry leading or trailing space — any of those
// makes the whole frontmatter unparseable, which drops the skill from the very
// host listing this field exists to reach. Fall back to a double-quoted scalar;
// JSON's escape set is a subset of YAML's, and the YAML parser restores the
// scalar on read.
const YAML_PLAIN_UNSAFE_RE = /^[-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|[\n\r\t]/;

function yamlScalar(value) {
  const unsafe = value === "" || value !== value.trim() || YAML_PLAIN_UNSAFE_RE.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

// Apply a plan produced by planTriggerVisibility. Appends one `when_to_use:`
// line to the frontmatter and touches nothing else — the existing `triggers:`
// list stays authoritative for DotAIOS's own resolver, and the body is never
// rewritten. Skills absent from the supplied plan are never opened.
export async function applyTriggerVisibility(aiosPath, plan) {
  const written = [];

  for (const entry of plan) {
    const content = await fs.readFile(entry.path, "utf8");
    const frontmatter = content.match(FRONTMATTER_RE);
    if (!frontmatter) continue;
    if (/^when_to_use:/m.test(frontmatter[1])) continue;

    // Both replacements take a function, not a string: `$&`, `` $` ``, `$'` and
    // `$$` in a routing phrase would otherwise expand as replacement patterns
    // and splice the frontmatter into itself. The captured newline is reused so
    // a CRLF-authored file does not come back with mixed line endings.
    const line = `when_to_use: ${yamlScalar(entry.whenToUse)}`;
    const updated = content.replace(FRONTMATTER_RE, (block) =>
      block.replace(/(\r?\n)---$/, (_match, eol) => `${eol}${line}${eol}---`)
    );

    await fs.writeFile(entry.path, updated);
    written.push(entry);
  }

  return written;
}

// Render the human- and agent-readable skills index.
export function renderSkillsIndex(skills) {
  const lines = [
    "# Installed Skills",
    "",
    "Auto-generated by DotAIOS. Do not edit by hand — it refreshes when you run",
    "`dotaios activate` or install/remove a skill.",
    "",
    "Skills are reusable workflows. **Any AI agent can run one**: open that",
    "skill's `SKILL.md` file and follow it. The user invokes a skill by name",
    "(for example: \"use the audit skill\" or \"run plan-today\").",
    "",
    "When the user seems stuck or asks what you can help with, suggest a relevant skill from this list.",
    ""
  ];

  if (skills.length === 0) {
    lines.push("_No skills installed yet. Add a reviewed local folder with_ `dotaios skill add <local-folder>`.", "");
  } else {
    for (const skill of skills) {
      lines.push(`## ${skill.name}`, "");
      if (skill.description) lines.push(skill.description, "");
      lines.push(`Run it: read \`skills/${skill.dir}/SKILL.md\` and follow the steps.`, "");
    }
  }

  return lines.join("\n");
}

// Escape a markdown table cell: pipes break columns, newlines break rows.
function escapeCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

// Render the agent-facing routing table. The agent matches the user's intent to
// a row's trigger phrases, then opens that skill's SKILL.md. Skills without
// triggers fall back to their description. Plain text — the LLM does the match,
// no embeddings.
export function renderResolver(skills) {
  const lines = [
    "# Skill Resolver",
    "",
    "Auto-generated by DotAIOS. Do not edit by hand — it refreshes when you run",
    "`dotaios activate` or install/remove a skill.",
    "",
    "To handle a request, match the user's intent to a row below, then open that",
    "skill's `SKILL.md` and follow it. Prefer the most specific match. If nothing",
    "fits, fall back to `skills/INDEX.md`.",
    ""
  ];

  if (skills.length === 0) {
    lines.push("_No skills installed yet._", "");
    return lines.join("\n");
  }

  lines.push("| If the user wants… | Run this skill |", "| --- | --- |");
  for (const skill of skills) {
    const hints = skill.triggers && skill.triggers.length
      ? skill.triggers.join(" · ")
      : (skill.description || skill.name);
    lines.push(`| ${escapeCell(hints)} | \`skills/${skill.dir}/SKILL.md\` |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureRealSkillsDirectory(aiosPath) {
  const rootStats = await lstatIfPresent(aiosPath);
  if (rootStats && (!rootStats.isDirectory() || rootStats.isSymbolicLink())) {
    throw new Error(`Cannot write a skill catalog through unsafe AIOS root: ${aiosPath}`);
  }
  if (!rootStats) await fs.mkdir(aiosPath, { recursive: true });

  const skillsDir = path.join(aiosPath, "skills");
  const skillsStats = await lstatIfPresent(skillsDir);
  if (skillsStats && (!skillsStats.isDirectory() || skillsStats.isSymbolicLink())) {
    throw new Error(`Cannot write a skill catalog through unsafe directory: ${skillsDir}`);
  }
  if (!skillsStats) await fs.mkdir(skillsDir);
  return skillsDir;
}

async function assertSafeCatalogFiles(paths) {
  for (const filePath of paths) {
    const stats = await lstatIfPresent(filePath);
    if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
      throw new Error(`Cannot overwrite unsafe skill catalog file: ${filePath}`);
    }
  }
}

// Regenerate <aiosPath>/skills/RESOLVER.md from the skills currently on disk.
export async function writeResolver(aiosPath) {
  await ensureRealSkillsDirectory(aiosPath);
  const skills = await collectSkills(aiosPath);
  const resolverPath = path.join(aiosPath, "skills", "RESOLVER.md");
  await assertSafeCatalogFiles([resolverPath]);
  await writeFileSafe(
    resolverPath,
    `${renderResolver(skills)}\n`,
    "overwrite",
    { boundaryRoot: aiosPath }
  );
  return { path: resolverPath, count: skills.length };
}

// Regenerate the agent-facing skill files (INDEX.md + RESOLVER.md) from the
// skills currently on disk. Called after any operation that can change the
// installed skill set.
export async function writeSkillsIndex(aiosPath, { writeMode = "overwrite" } = {}) {
  if (!["overwrite", "preserve"].includes(writeMode)) {
    throw new Error(`Unsupported skill catalog write mode: ${writeMode}`);
  }
  const skillsDir = await ensureRealSkillsDirectory(aiosPath);
  const skills = await collectSkills(aiosPath);
  const indexPath = path.join(skillsDir, "INDEX.md");
  const resolverPath = path.join(skillsDir, "RESOLVER.md");
  await assertSafeCatalogFiles([indexPath, resolverPath]);
  const indexResult = await writeCatalogFile(
    indexPath,
    `${renderSkillsIndex(skills)}\n`,
    writeMode,
    aiosPath
  );
  const resolverResult = await writeCatalogFile(
    resolverPath,
    `${renderResolver(skills)}\n`,
    writeMode,
    aiosPath
  );
  const results = [indexResult, resolverResult];
  return {
    path: indexPath,
    resolverPath,
    count: skills.length,
    results,
    conflicts: results.filter(({ action }) => action === "kept")
  };
}

async function writeCatalogFile(filePath, content, writeMode, boundaryRoot) {
  const result = await writeFileSafe(filePath, content, writeMode, { boundaryRoot });
  if (result.action !== "kept") return result;

  // Preserve mode is also used as a compare-and-publish boundary during setup.
  // An identical winner is harmless; different bytes belong to another writer
  // and must survive for the caller to report as a collision.
  try {
    return await fs.readFile(filePath, "utf8") === content
      ? { action: "unchanged", path: filePath }
      : result;
  } catch {
    return result;
  }
}
