import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import {
  defaultAiosPath,
  ensureAiosFolder,
  expandHome,
  isPathWithin,
  resolveVaultPath
} from "../../../core/src/paths.mjs";
import { pathExists, readJson, listFiles } from "../../../core/src/files.mjs";
import { renderDirectoryIndex } from "../../../core/src/okf-live.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

// Knowledge layers only. NOT memory/ (operational JSONL) or skills/ (workflows).
const SRC_ROOTS = ["context", "vault", "projects", "decisions", "connections"];
const RESERVED = new Set(["index.md", "log.md"]);
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function splitFrontmatter(text, source = "markdown") {
  const match = FM_RE.exec(text);
  if (!match && /^---(?:\r?\n|$)/.test(text)) {
    throw new Error(`Unclosed YAML frontmatter in ${source}: expected a closing --- delimiter`);
  }
  if (!match) return { meta: {}, body: text, raw: null };
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid YAML frontmatter in ${source}: ${document.errors[0].message}`);
  }
  const value = document.toJS();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid YAML frontmatter in ${source}: expected a mapping`);
  }
  return { meta: value, body: match[2], raw: match[1] };
}

function inferType(rel, meta) {
  if (typeof meta.type === "string" && meta.type.trim()) return meta.type.trim();
  if (typeof meta.kind === "string" && meta.kind.trim()) return meta.kind.trim();
  const p = rel.split(path.sep).join("/");
  if (p.startsWith("vault/research/scout")) return "Scout Evaluation";
  if (p.startsWith("vault/research")) return "Research";
  if (p.startsWith("vault/raw")) return "Reference";
  if (p.startsWith("vault/wiki")) return "Reference";
  if (p.startsWith("decisions")) return "Decision";
  if (p.startsWith("context")) return "Context";
  if (p.startsWith("connections")) return "Connection";
  if (path.basename(rel) === "README.md" && p.startsWith("projects")) return "Project";
  return "Note";
}

// Preserve the source frontmatter verbatim (OKF v0.1 §4.1: keep unknown keys);
// inject the required `type` only when the source lacks it. Files with no
// frontmatter get a minimal block.
function renderFrontmatter(raw, hasType, type) {
  if (raw === null) return `---\ntype: ${type}\n---\n`;
  if (hasType) return `---\n${raw}\n---\n`;
  return `---\ntype: ${type}\n${raw}\n---\n`;
}

async function assertSafeOutput(srcRoot, outDir, entries, { allowInternalOutput = false } = {}) {
  const resolvedSource = path.resolve(srcRoot);
  const resolvedOutput = path.resolve(outDir);
  if (resolvedSource === resolvedOutput || await isPathWithin(outDir, srcRoot)) {
    throw new Error("Unsafe OKF output: --out cannot equal or contain the AIOS folder");
  }

  for (const { dir } of entries) {
    if (!(await pathExists(dir))) continue;
    if (await isPathWithin(dir, outDir) || await isPathWithin(outDir, dir)) {
      throw new Error(`Unsafe OKF output: --out overlaps source folder ${path.resolve(dir)}`);
    }
  }

  if (!allowInternalOutput && await isPathWithin(srcRoot, outDir)) {
    throw new Error("Unsafe OKF output: --out cannot be inside the AIOS folder");
  }
}

function readType(frontmatter, source) {
  const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid exported YAML frontmatter in ${source}: ${document.errors[0].message}`);
  }
  const value = document.toJS();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid exported YAML frontmatter in ${source}: expected a mapping`);
  }
  if (typeof value.type !== "string" || !value.type.trim()) {
    throw new Error(`Invalid exported YAML frontmatter in ${source}: type must be a non-empty string`);
  }
  return value.type.trim();
}

function markdownFrontmatter(text) {
  const match = FM_RE.exec(text);
  return match ? match[1] : "";
}

function createWikilinkIndex(files) {
  const byStem = new Map();
  const byPath = new Map();
  for (const { rel } of files) {
    const normalized = rel.split(path.sep).join("/");
    const target = `/${normalized}`;
    const withoutExtension = normalized.replace(/\.md$/i, "");
    byPath.set(withoutExtension, target);
    const stem = path.posix.basename(withoutExtension);
    const candidates = byStem.get(stem) || [];
    byStem.set(stem, [...candidates, target]);
  }
  return { byStem, byPath };
}

function resolveWikilink(key, index) {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  if (normalized.includes("/")) return index.byPath.get(normalized) || null;
  const candidates = index.byStem.get(normalized) || [];
  return candidates.length === 1 ? candidates[0] : null;
}

function addDirectory(directoryMap, dir) {
  if (!directoryMap.has(dir)) directoryMap.set(dir, { concepts: [], children: new Set() });
  return directoryMap.get(dir);
}

function buildDirectoryMap(concepts) {
  const directories = new Map();
  for (const concept of concepts) {
    const dir = path.dirname(concept.rel);
    addDirectory(directories, dir).concepts.push(concept);
    const parts = dir.split(path.sep);
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join(path.sep);
      const child = parts.slice(0, index + 1).join(path.sep);
      addDirectory(directories, parent).children.add(child);
      addDirectory(directories, child);
    }
  }
  return directories;
}

async function replaceDirectory(stagingDir, outDir) {
  const backupDir = `${outDir}.backup-${randomUUID()}`;
  const hadOutput = await pathExists(outDir);
  if (hadOutput) await fs.rename(outDir, backupDir);
  try {
    await fs.rename(stagingDir, outDir);
    if (hadOutput) await fs.rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (hadOutput && !(await pathExists(outDir)) && (await pathExists(backupDir))) {
      await fs.rename(backupDir, outDir);
    }
    throw error;
  }
}

/**
 * Project a DotAIOS tree into an OKF v0.1-conformant bundle. READ-ONLY on source.
 * The format is plumbing; this is a disposable projection, never a migration.
 * Returns a stats object.
 */
export async function exportBundle({ srcRoot, outDir, roots = SRC_ROOTS, vaultPath = null, allowInternalOutput = false }) {
  srcRoot = path.resolve(srcRoot);
  outDir = path.resolve(outDir);

  // Map each logical root to its directory (vault may live outside srcRoot).
  const entries = roots.map((name) => ({
    name,
    dir: name === "vault" && vaultPath ? path.resolve(vaultPath) : path.join(srcRoot, name)
  }));
  await assertSafeOutput(srcRoot, outDir, entries, { allowInternalOutput });

  const stagingDir = `${outDir}.staging-${randomUUID()}`;
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    const files = [];
    for (const { name, dir } of entries) {
      if (!(await pathExists(dir))) continue;
      for (const file of await listFiles(dir)) {
        if (!file.endsWith(".md") || RESERVED.has(path.basename(file))) continue;
        const rel = path.join(name, path.relative(dir, file));
        files.push({ file, rel });
      }
    }
    const wikilinkIndex = createWikilinkIndex(files);

    let injected = 0;
    let rewritten = 0;
    let ambiguous = 0;
    const concepts = [];
    for (const { file, rel } of files) {
      const text = await fs.readFile(file, "utf8");
      const { meta, body, raw } = splitFrontmatter(text, file);
      const hasType = Object.hasOwn(meta, "type");
      if (hasType && (typeof meta.type !== "string" || !meta.type.trim())) {
        throw new Error(`Invalid YAML frontmatter in ${file}: type must be a non-empty string`);
      }
      const type = inferType(rel, meta);
      if (!hasType) injected += 1;
      const body2 = body.replace(WIKILINK_RE, (whole, inner) => {
        const key = inner.split("|")[0].trim();
        const target = resolveWikilink(key, wikilinkIndex);
        if (target) {
          rewritten += 1;
          return `[${key}](${target})`;
        }
        if (!key.includes("/") && (wikilinkIndex.byStem.get(key)?.length || 0) > 1) ambiguous += 1;
        return whole;
      });
      const rendered = renderFrontmatter(raw, hasType, type) + body2;
      const exportedType = readType(markdownFrontmatter(rendered), rel);
      const dst = path.join(stagingDir, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.writeFile(dst, rendered);
      concepts.push({
        rel,
        type: exportedType,
        description: typeof meta.description === "string" ? meta.description : ""
      });
    }

    // Same renderer as the live folder's index maintenance (core/okf-live.mjs):
    // the export and the live tree can never drift in format.
    const directories = buildDirectoryMap(concepts);
    for (const [dir, node] of directories) {
      const childLinks = [...node.children].sort().map((child) => ({
        label: path.basename(child),
        href: `/${child.split(path.sep).join("/")}/`
      }));
      const docLinks = node.concepts
        .sort((a, b) => a.rel.localeCompare(b.rel))
        .map((concept) => ({
          label: path.basename(concept.rel, ".md"),
          href: "/" + concept.rel.split(path.sep).join("/"),
          type: concept.type,
          description: concept.description || ""
        }));
      await fs.writeFile(
        path.join(stagingDir, dir, "index.md"),
        renderDirectoryIndex({ heading: dir.split(path.sep).join("/"), childLinks, docLinks })
      );
    }

    const groups = new Map();
    for (const concept of concepts) {
      const group = concept.rel.split(path.sep)[0];
      groups.set(group, (groups.get(group) || 0) + 1);
    }
    const rootLines = ["---", 'okf_version: "0.1"', "---", "", "# DotAIOS Knowledge Bundle", ""];
    for (const group of [...groups.keys()].sort()) {
      rootLines.push(`* [${group}](${group}/) (${groups.get(group)} concepts)`);
    }
    await fs.writeFile(path.join(stagingDir, "index.md"), rootLines.join("\n") + "\n");

    await fs.mkdir(path.dirname(outDir), { recursive: true });
    await replaceDirectory(stagingDir, outDir);
    return {
      concepts: concepts.length,
      injected,
      rewritten,
      ambiguous,
      indexes: directories.size,
      conformant: concepts.length,
      outDir
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function parseOptions(args = []) {
  const options = { path: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    } else if (arg === "--out") {
      options.out = readOptionValue(args, index, "--out");
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export async function exportOkfCommand(args) {
  if (hasHelpFlag(args)) {
    printExportOkfHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await ensureAiosFolder(target);

  const config = await readJson(path.join(target, "aios.json"), {});
  const vaultPath = resolveVaultPath(config, target);
  const usingDefaultOut = !options.out;
  const outDir = usingDefaultOut
    ? path.join(target, "build", "okf-export")
    : path.resolve(expandHome(options.out));

  // Keep the gate honest: the default bundle lives under <aios>/build, which the
  // sync hook would otherwise pick up. Make build/ self-ignoring so the bundle is
  // never committed or synced, even on installs whose .gitignore predates this.
  if (usingDefaultOut) {
    const buildDir = path.join(target, "build");
    await fs.mkdir(buildDir, { recursive: true });
    await fs.writeFile(path.join(buildDir, ".gitignore"), "*\n");
  }

  const stats = await exportBundle({ srcRoot: target, outDir, vaultPath, allowInternalOutput: usingDefaultOut });

  console.log(`OKF export -> ${stats.outDir}`);
  console.log(`  concepts exported : ${stats.concepts}`);
  console.log(`  type injected     : ${stats.injected} (source untouched)`);
  console.log(`  wikilinks rewired : ${stats.rewritten}`);
  console.log(`  ambiguous links   : ${stats.ambiguous}`);
  console.log(`  index.md written  : ${stats.indexes} (+ bundle root)`);
  console.log(`  conformant        : ${stats.conformant}/${stats.concepts} (every concept has a non-empty type)`);
  console.log(
    [
      "",
      "────────────────────────────────────────────────────────────────",
      ` HUMAN GATE — bundle is LOCAL ONLY  (${path.relative(target, stats.outDir) || stats.outDir})`,
      " Nothing was published, committed, pushed, or shared.",
      " Review it, then decide any external move yourself:",
      `   open ${stats.outDir}`,
      "────────────────────────────────────────────────────────────────"
    ].join("\n")
  );
}

function printExportOkfHelp() {
  console.log(`Usage:
  dotaios export-okf [options]

Project your DotAIOS knowledge (context, vault, projects, decisions, connections)
into an Open Knowledge Format (OKF v0.1) bundle: plain markdown + YAML frontmatter,
git-shaped, readable by any OKF tool. Read-only — your source files are never changed.

Options:
  --path <dir>  Use an AIOS folder other than ~/aios
  --out <dir>   Write the bundle here (default: <aios>/build/okf-export)

The bundle is produced locally only. Publishing or sharing it is your decision.`);
}
