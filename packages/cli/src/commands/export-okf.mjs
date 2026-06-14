import fs from "node:fs/promises";
import path from "node:path";
import { defaultAiosPath, ensureAiosFolder, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { pathExists, readJson, listFiles } from "../../../core/src/files.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

// Knowledge layers only. NOT memory/ (operational JSONL) or skills/ (workflows).
const SRC_ROOTS = ["context", "vault", "projects", "decisions", "connections"];
const RESERVED = new Set(["index.md", "log.md"]);
const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function splitFrontmatter(text) {
  const match = FM_RE.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

function inferType(rel, meta) {
  if (meta.type) return meta.type;
  if (meta.kind) return meta.kind; // DotAIOS authors often use `kind`
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

function buildFrontmatter(meta, type) {
  const out = { type };
  for (const key of ["title", "description", "resource", "tags", "timestamp"]) {
    if (meta[key]) out[key] = meta[key];
  }
  return ["---", ...Object.entries(out).map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
}

/**
 * Project a DotAIOS tree into an OKF v0.1-conformant bundle. READ-ONLY on source.
 * The format is plumbing; this is a disposable projection, never a migration.
 * Returns a stats object.
 */
export async function exportBundle({ srcRoot, outDir, roots = SRC_ROOTS, vaultPath = null }) {
  srcRoot = path.resolve(srcRoot);
  outDir = path.resolve(outDir);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  // Map each logical root to its directory (vault may live outside srcRoot).
  const entries = roots.map((name) => ({
    name,
    dir: name === "vault" && vaultPath ? path.resolve(vaultPath) : path.join(srcRoot, name)
  }));

  const files = [];
  const nameIndex = new Map(); // bare stem -> /bundle/path.md
  for (const { name, dir } of entries) {
    if (!(await pathExists(dir))) continue;
    for (const file of await listFiles(dir)) {
      if (!file.endsWith(".md") || RESERVED.has(path.basename(file))) continue;
      const rel = path.join(name, path.relative(dir, file));
      files.push({ file, rel });
      nameIndex.set(path.basename(rel, ".md"), "/" + rel.split(path.sep).join("/"));
    }
  }

  let injected = 0;
  let rewritten = 0;
  const concepts = [];
  for (const { file, rel } of files) {
    const text = await fs.readFile(file, "utf8");
    const { meta, body } = splitFrontmatter(text);
    const type = inferType(rel, meta);
    if (!meta.type) injected += 1;
    const body2 = body.replace(WIKILINK_RE, (whole, inner) => {
      const key = inner.split("|")[0].trim();
      const target = nameIndex.get(key);
      if (target) {
        rewritten += 1;
        return `[${key}](${target})`;
      }
      return whole; // tolerate unresolved — OKF treats it as not-yet-written
    });
    const dst = path.join(outDir, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, buildFrontmatter(meta, type) + body2);
    concepts.push({ rel, type, description: meta.description || "" });
  }

  // per-directory index.md (progressive disclosure)
  const dirs = new Map();
  for (const concept of concepts) {
    const dir = path.dirname(concept.rel);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(concept);
  }
  for (const [dir, items] of dirs) {
    const lines = [`# ${dir.split(path.sep).join("/")}`, ""];
    for (const concept of items.sort((a, b) => a.rel.localeCompare(b.rel))) {
      const link = "/" + concept.rel.split(path.sep).join("/");
      const desc = concept.description ? ` - ${concept.description}` : "";
      lines.push(`* [${path.basename(concept.rel, ".md")}](${link}) (${concept.type})${desc}`);
    }
    await fs.writeFile(path.join(outDir, dir, "index.md"), lines.join("\n") + "\n");
  }

  // bundle-root index.md — declares okf_version, lists top-level groups
  const groups = new Map();
  for (const concept of concepts) {
    const group = concept.rel.split(path.sep)[0];
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  const rootLines = ["---", 'okf_version: "0.1"', "---", "", "# DotAIOS Knowledge Bundle", ""];
  for (const group of [...groups.keys()].sort()) {
    rootLines.push(`* [${group}](${group}/) (${groups.get(group)} concepts)`);
  }
  await fs.writeFile(path.join(outDir, "index.md"), rootLines.join("\n") + "\n");

  return { concepts: concepts.length, injected, rewritten, indexes: dirs.size, conformant: concepts.length, outDir };
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
  const outDir = options.out
    ? path.resolve(expandHome(options.out))
    : path.join(target, "build", "okf-export");

  const stats = await exportBundle({ srcRoot: target, outDir, vaultPath });

  console.log(`OKF export -> ${stats.outDir}`);
  console.log(`  concepts exported : ${stats.concepts}`);
  console.log(`  type injected     : ${stats.injected} (source untouched)`);
  console.log(`  wikilinks rewired : ${stats.rewritten}`);
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
