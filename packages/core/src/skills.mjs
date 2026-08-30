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

// Catalog order is part of the portable artifact. Locale-aware comparison can
// produce different bytes across hosts, so names and paths use unsigned UTF-8
// byte order everywhere this module establishes their order.
export function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function compareSkills(left, right) {
  return compareUtf8Bytes(left.name, right.name) || compareUtf8Bytes(left.dir, right.dir);
}

function orderedSkills(skills) {
  return [...skills].sort(compareSkills);
}

// Scan <aiosPath>/skills/ for every <name>/SKILL.md and return its metadata.
export async function collectSkills(aiosPath, { reader = null, root = aiosPath } = {}) {
  const activeReader = reader || createEvidenceReader({
    roots: [path.resolve(root)],
    limits: { maxFiles: 512, maxDirectoryEntries: 512 }
  });
  const skillsDir = path.join(aiosPath, "skills");
  const directories = await activeReader.listDirectories(root, skillsDir, {
    maxEntries: 512,
    skipLinkedEntries: true,
    skipEntry: (name) => name.startsWith(".") || name.startsWith("_")
  });
  directories.sort((left, right) => compareUtf8Bytes(
    path.relative(skillsDir, left),
    path.relative(skillsDir, right)
  ));

  const skills = [];
  for (const directoryPath of directories) {
    const dir = path.basename(directoryPath);
    const skillFile = path.join(directoryPath, "SKILL.md");
    const expectedEntry = await activeReader.inspectEntry(root, skillFile);
    if (expectedEntry === null) continue;
    const content = await activeReader.readFrontmatter(root, skillFile, {
      allowMissing: true,
      maxBytes: MAX_ROUTING_METADATA_BYTES,
      maxFileBytes: MAX_SKILL_SOURCE_BYTES,
      expectedEntry
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

  skills.sort(compareSkills);
  return skills;
}

export function parseSkillMetadata(content) {
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

// Render the human- and agent-readable skills index.
export function renderSkillsIndex(skills) {
  const lines = [
    "# Installed Skills",
    "",
    "Auto-generated by DotAIOS. Do not edit by hand — activation and managed",
    "skill lifecycle operations refresh it.",
    "",
    "Skills are reusable workflows. **Any AI agent can run one**: open that",
    "skill's `SKILL.md` file and follow it. The user invokes a skill by name",
    "(for example: \"use the audit skill\" or \"run plan-today\").",
    "",
    "When the user seems stuck or asks what you can help with, suggest a relevant skill from this list.",
    ""
  ];

  if (skills.length === 0) {
    lines.push("_No skills installed yet. Use the active managed context's `candidate_invocation` with `[\"skill\",\"add\",\"<local-folder>\"]` to add a reviewed local folder._", "");
  } else {
    for (const skill of orderedSkills(skills)) {
      lines.push(`## ${skill.name}`, "");
      if (skill.description) lines.push(skill.description, "");
      lines.push(`Run it: read \`skills/${skill.dir}/SKILL.md\` and follow the steps.`, "");
    }
  }

  return lines.join("\n");
}

// Escape a markdown table cell: pipes break columns, newlines break rows.
function escapeCell(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/g, " ");
}

// Render the agent-facing routing table. The agent matches the user's intent to
// a row's trigger phrases, then opens that skill's SKILL.md. Skills without
// triggers fall back to their description. Plain text — the LLM does the match,
// no embeddings.
export function renderResolver(skills) {
  const lines = [
    "# Skill Resolver",
    "",
    "Auto-generated by DotAIOS. Do not edit by hand — activation and managed",
    "skill lifecycle operations refresh it.",
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
  for (const skill of orderedSkills(skills)) {
    const hints = skill.triggers && skill.triggers.length
      ? skill.triggers.join(" · ")
      : (skill.description || skill.name);
    lines.push(`| ${escapeCell(hints)} | \`skills/${skill.dir}/SKILL.md\` |`);
  }
  lines.push("");
  return lines.join("\n");
}

// Pure catalog-artifact boundaries. ManagedSkillStore owns transactional
// publication; these functions only turn an owned-skill inventory into exact,
// portable bytes.
export function renderSkillsIndexBytes(skills) {
  return Buffer.from(`${renderSkillsIndex(skills)}\n`, "utf8");
}

export function renderResolverBytes(skills) {
  return Buffer.from(`${renderResolver(skills)}\n`, "utf8");
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

// Compatibility writer for existing setup callers. ManagedSkillStore owns
// transactional catalog publication for managed-skill lifecycle operations.
export async function writeResolver(aiosPath) {
  await ensureRealSkillsDirectory(aiosPath);
  const skills = await collectSkills(aiosPath);
  const resolverPath = path.join(aiosPath, "skills", "RESOLVER.md");
  await assertSafeCatalogFiles([resolverPath]);
  await writeFileSafe(
    resolverPath,
    renderResolverBytes(skills),
    "overwrite",
    { boundaryRoot: aiosPath }
  );
  return { path: resolverPath, count: skills.length };
}

// Compatibility writer for existing setup callers. ManagedSkillStore owns
// transactional INDEX.md + RESOLVER.md publication for managed-skill lifecycle
// operations; this wrapper delegates exact artifact creation to the pure
// renderers above.
export async function writeSkillsIndex(aiosPath, { writeMode = "overwrite", skills = null } = {}) {
  if (!["overwrite", "preserve"].includes(writeMode)) {
    throw new Error(`Unsupported skill catalog write mode: ${writeMode}`);
  }
  const skillsDir = await ensureRealSkillsDirectory(aiosPath);
  const catalogSkills = skills || await collectSkills(aiosPath);
  const indexPath = path.join(skillsDir, "INDEX.md");
  const resolverPath = path.join(skillsDir, "RESOLVER.md");
  await assertSafeCatalogFiles([indexPath, resolverPath]);
  const indexResult = await writeCatalogFile(
    indexPath,
    renderSkillsIndexBytes(catalogSkills),
    writeMode,
    aiosPath
  );
  const resolverResult = await writeCatalogFile(
    resolverPath,
    renderResolverBytes(catalogSkills),
    writeMode,
    aiosPath
  );
  const results = [indexResult, resolverResult];
  return {
    path: indexPath,
    resolverPath,
    count: catalogSkills.length,
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
    return (await fs.readFile(filePath)).equals(content)
      ? { action: "unchanged", path: filePath }
      : result;
  } catch {
    return result;
  }
}
