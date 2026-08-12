import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { copyFileSafe, listFiles, pathExists, writeFileSafe } from "../../../core/src/files.mjs";
import { previewMigration } from "../../../core/src/migrations.mjs";
import { planTemplateTree, renderTemplate, renderTemplateTree } from "../../../core/src/render.mjs";
import { createAiosConfig } from "../../../core/src/schema.mjs";
import { writeSkillsIndex } from "../../../core/src/skills.mjs";
import { hasStableManagedWorkspaceIgnoreRule } from "../../../core/src/workspace-ignore.mjs";
import {
  SETUP_TRANSACTION_FILE,
  defaultAiosPath,
  expandHome,
  isPathWithin,
  isPathWithinLexically,
  resolveVaultPath
} from "../../../core/src/paths.mjs";
import { assertUniqueOptions, hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const BASE_TREE_DIRS = [
  "context/domains",
  "projects",
  "connections/apis",
  "memory/signals",
  "memory/daily",
  "memory/sessions",
  "skills",
  "plugins",
  "decisions",
  "archives"
];
const BUILT_IN_VAULT_DIRS = [
  "vault/wiki",
  "vault/raw",
  "vault/org/companies",
  "vault/org/people",
  "vault/outputs"
];
const SKILL_CATALOG_FILES = ["skills/INDEX.md", "skills/RESOLVER.md"];

export async function initCommand(args, lifecycle = {}) {
  if (hasHelpFlag(args)) {
    printInitHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  await assertAiosRootSafe(target);
  if (
    options.force
    && !lifecycle.allowSetupTransactionRecovery
    && await pathExists(path.join(target, SETUP_TRANSACTION_FILE))
  ) {
    throw new Error(
      "An unfinished setup marker is present. Re-run the identical `dotaios setup` command without --force or --overwrite."
    );
  }
  let vaultInsideTarget = false;
  if (options.vaultPath) {
    vaultInsideTarget = isPathWithinLexically(target, options.vaultPath);
    if (!vaultInsideTarget) {
      try {
        vaultInsideTarget = await isPathWithin(target, options.vaultPath);
      } catch {
        // The existing vault usability check below owns invalid-path errors and
        // gives the user the actionable --vault-path diagnostic.
      }
    }
  }
  if (vaultInsideTarget) {
    throw new Error(
      `Invalid --vault-path: ${options.vaultPath}\n` +
      "An external vault must be outside the AIOS target. Omit --vault-path to use the target's built-in vault."
    );
  }
  const exists = await pathExists(target);

  const existingAiosStore = exists && await pathExists(path.join(target, "aios.json"));
  if (existingAiosStore) {
    const migration = await previewMigration({ aiosPath: target });
    if (migration.status === "ready") {
      throw new Error(
        `Existing AIOS schema ${migration.plan.from_schema_version} needs a versioned migration.\n` +
        `Run \`dotaios migrate --path ${target}\` to preview it. --force and --overwrite are not migration ownership proof.`
      );
    }
    if (migration.status === "recovery_required") {
      throw new Error("An interrupted migration must be recovered before init can inspect this folder. Run `dotaios migrate --recover`.");
    }
    if (options.force && !lifecycle.allowSetupTransactionRecovery) {
      throw new Error(
        "Refusing init writes against an existing live AIOS store. " +
        "Canonical skills and catalogs are owned by ManagedSkillStore; use `dotaios skills adopt` or `dotaios skills reconcile`."
      );
    }
  }

  if (exists && !options.force) {
    const entries = await fs.readdir(target);
    if (entries.length > 0) {
      throw new Error(`Target already exists and is not empty: ${target}\nRe-run with --force to add missing files, or --overwrite to replace generated files.`);
    }
  }

  if (options.force && !options.overwrite) {
    await assertPreservedWorkspaceIgnoreSafe(target);
  }

  if (options.vaultPath) {
    await assertVaultPathUsable(options.vaultPath);
  }

  const planned = lifecycle.plan;
  const answers = planned ? null : (options.yes ? defaultAnswers() : await promptAnswers());
  const config = planned?.config || createAiosConfig({
    aiTools: splitCsv(answers.ai_tools),
    vaultPath: options.vaultPath || null
  });

  const data = planned?.data || {
    ...answers,
    created_at: config.created_at,
    ai_tools: config.ai_tools,
    vault_path: config.vault_path
  };

  if (options.force) {
    await assertGeneratedDestinationsSafe(target, data, Boolean(config.vault_path));
  }

  await lifecycle.beforeScaffold?.({ config, data });
  // Setup's ownership marker is published by beforeScaffold. Re-check the
  // complete write surface after that hook and before the scaffold itself can
  // mutate anything, so a raced descendant or ignore boundary cannot redirect
  // or weaken this run.
  await assertAiosRootSafe(target);
  await assertGeneratedDestinationsSafe(target, data, Boolean(config.vault_path));
  if (options.force && !options.overwrite) {
    await assertPreservedWorkspaceIgnoreSafe(target);
  }
  await createBaseTree(target, Boolean(config.vault_path));
  await lifecycle.afterCreateBaseTree?.();
  if (!lifecycle.skipVaultTree) {
    await createVaultTree(resolveVaultPath(config, target));
  }
  const writeMode = options.overwrite ? "overwrite" : "preserve";
  const results = [];
  results.push(...await renderTemplates(target, data, writeMode));
  results.push(await writeFileSafe(
    path.join(target, "aios.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    writeMode,
    { boundaryRoot: target }
  ));
  results.push(...await copySkills(target, writeMode));
  results.push(...await createStarterFiles(target, data, writeMode));
  const skillsIndex = await writeSkillsIndex(target, { writeMode });
  results.push(...skillsIndex.results);
  if (
    skillsIndex.conflicts.length > 0
    && (!options.force || lifecycle.allowSetupTransactionRecovery)
  ) {
    throw new Error(
      `Skill catalog changed while init was running; preserved: ${skillsIndex.conflicts.map(({ path: file }) => file).join(", ")}`
    );
  }

  if (!lifecycle.quiet) {
    printSuccess(target, resolveVaultPath(config, target), results);
  }
}

function parseOptions(args = []) {
  assertUniqueOptions(args, ["--path", "--vault-path"]);
  const options = { force: false, overwrite: false, path: null, vaultPath: null, yes: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") options.force = true;
    if (arg === "--overwrite") {
      options.force = true;
      options.overwrite = true;
    }
    if (arg === "--yes" || arg === "-y") options.yes = true;
    if (arg === "--vault-path") {
      options.vaultPath = expandHome(readOptionValue(args, index, "--vault-path"));
      index += 1;
    }
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    }
  }

  return options;
}

function printInitHelp() {
  console.log(`Usage:
  dotaios init [options]

Options:
  --path <dir>        Create AIOS somewhere other than ~/aios
  --vault-path <dir>  Use an external vault for long-term knowledge
  --yes, -y           Use placeholder answers for non-interactive setup
  --force             Add missing files, preserving existing files
  --overwrite         Replace generated files in the target folder
`);
}


async function promptAnswers() {
  if (!process.stdin.isTTY) {
    console.error("");
    console.error("DotAIOS could not find an interactive terminal.");
    console.error("");
    console.error("This usually means the command was pasted into a chat window");
    console.error("(like ChatGPT or Gemini on the web) instead of the Terminal app.");
    console.error("");
    console.error("How to fix:");
    console.error("  Mac:     press cmd+space, type 'Terminal', press Enter.");
    console.error("  Windows: press the Windows key, type 'cmd', press Enter.");
    console.error("  Linux:   open your usual shell.");
    console.error("");
    console.error("Then paste the same command into that Terminal window.");
    console.error("");
    console.error("Running this in a script? Re-run with --yes to use defaults.");
    throw new Error("interactive terminal required (or pass --yes for non-interactive)");
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log("DotAIOS creates local memory files for the AI tools you already use.\n");
    return {
      user_name: await ask(rl, "Name", "<!-- Your Name -->"),
      user_role: await ask(rl, "What do you do?", "<!-- Your Role -->"),
      current_work: await ask(rl, "What are you working on right now?", "<!-- Add the active work threads agents should keep in mind. -->"),
      priorities: await ask(rl, "What matters most this week?", "<!-- Add the current bets and near-term priorities. -->"),
      ai_tools: await ask(rl, "AI tools you use", "claude-code,codex,cursor")
    };
  } finally {
    rl.close();
  }
}

async function ask(rl, label, fallback) {
  // If fallback is an HTML comment, don't show it as the default in the prompt
  const displayFallback = fallback.startsWith("<!--") ? "" : ` [${fallback}]`;
  const answer = await rl.question(`${label}${displayFallback}: `);
  return answer.trim() || fallback;
}

function defaultAnswers() {
  return {
    user_name: "<!-- Your Name -->",
    user_role: "<!-- Your Role -->",
    current_work: "<!-- Add the active work threads agents should keep in mind. -->",
    priorities: "<!-- Add the current bets and near-term priorities. -->",
    ai_tools: "claude-code,codex,cursor"
  };
}

async function createBaseTree(target, usesExternalVault) {
  const dirs = baseTreeDirs(usesExternalVault);

  await fs.mkdir(target, { recursive: true });
  await assertAiosRootSafe(target);
  for (const dir of dirs) {
    await createSafeDescendantDirectory(target, dir);
  }
}

function baseTreeDirs(usesExternalVault) {
  return usesExternalVault
    ? [...BASE_TREE_DIRS]
    : [...BASE_TREE_DIRS, ...BUILT_IN_VAULT_DIRS];
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertAiosRootSafe(target) {
  const stats = await lstatIfPresent(target);
  if (!stats) return;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Cannot initialize an unsafe AIOS target: ${target}`);
  }
}

async function createSafeDescendantDirectory(target, relative) {
  let current = target;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await lstatIfPresent(current);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Cannot initialize through unsafe generated directory: ${current}`);
    }
  }
}

async function assertPreservedWorkspaceIgnoreSafe(target) {
  const ignorePath = path.join(target, ".gitignore");
  const stats = await lstatIfPresent(ignorePath);
  if (!stats) return;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Cannot preserve unsafe existing ignore file: ${ignorePath}`);
  }
  const ignoreContent = await fs.readFile(ignorePath, "utf8");
  if (!hasStableManagedWorkspaceIgnoreRule(ignoreContent)) {
    throw new Error([
      `Cannot preserve ${ignorePath} because it does not contain a stable exact /workspaces/ boundary.`,
      "Add /workspaces/ as the final effective rule, then retry --force; or use --overwrite to replace generated files."
    ].join(" "));
  }
}

function templateTreeOptions() {
  return {
    // sync-gitignore.template is a build-time resource for `dotaios sync
    // setup`, not a file the user's AIOS folder should carry.
    include: (outputRelative) =>
      outputRelative !== "aios.json" &&
      outputRelative !== "sync-gitignore.template"
  };
}

async function planGeneratedPaths(target, data, usesExternalVault) {
  const templateRoot = path.join(repoRoot, "templates");
  const templatePlan = await planTemplateTree(templateRoot, target, data, templateTreeOptions());
  const skillRoot = path.join(repoRoot, "skills");
  const skillFiles = await listFiles(skillRoot);
  const files = new Set([
    ...templatePlan.map((item) => item.path),
    path.join(target, "aios.json"),
    ...skillFiles.map((file) => path.join(target, "skills", path.relative(skillRoot, file))),
    ...Object.keys(starterFileContents(data)).map((relative) => path.join(target, relative)),
    ...SKILL_CATALOG_FILES.map((relative) => path.join(target, relative))
  ]);
  const directories = new Set(baseTreeDirs(usesExternalVault).map((relative) => path.join(target, relative)));

  for (const plannedDirectory of [...directories]) {
    let directory = plannedDirectory;
    while (directory !== target) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  for (const file of files) {
    let directory = path.dirname(file);
    while (directory !== target) {
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  return { files: [...files], directories: [...directories] };
}

async function assertGeneratedDestinationsSafe(target, data, usesExternalVault) {
  const { files, directories } = await planGeneratedPaths(target, data, usesExternalVault);

  for (const directory of directories.sort((a, b) => a.length - b.length)) {
    const stats = await lstatIfPresent(directory);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) {
      throw new Error(`Cannot initialize through unsafe generated directory: ${directory}`);
    }
  }

  for (const file of files) {
    const stats = await lstatIfPresent(file);
    if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
      throw new Error(`Cannot overwrite unsafe generated file: ${file}`);
    }
  }
}

// Runs before createBaseTree so a bad --vault-path cannot leave a
// half-created AIOS folder behind.
async function assertVaultPathUsable(vaultPath) {
  let probe = path.resolve(vaultPath);
  while (!(await pathExists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  const stats = await fs.stat(probe).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Invalid --vault-path: ${vaultPath}\n${probe} is not a directory, so the vault cannot be created there.\nPass --vault-path an existing folder, or a new folder inside one you can write to.`);
  }

  try {
    await fs.access(probe, fs.constants.W_OK);
  } catch {
    throw new Error(`Invalid --vault-path: ${vaultPath}\nNo permission to write in ${probe}.\nPass --vault-path a folder you can write to.`);
  }
}

async function createVaultTree(vaultPath) {
  const dirs = [
    "wiki",
    "raw",
    "org/companies",
    "org/people",
    "outputs"
  ];

  await Promise.all(dirs.map((dir) => fs.mkdir(path.join(vaultPath, dir), { recursive: true })));
}

async function renderTemplates(target, data, writeMode) {
  const templateRoot = path.join(repoRoot, "templates");
  return renderTemplateTree(templateRoot, target, data, {
    writeMode,
    boundaryRoot: target,
    ...templateTreeOptions()
  });
}

async function copySkills(target, writeMode) {
  const skillRoot = path.join(repoRoot, "skills");
  const files = await listFiles(skillRoot);
  const results = [];

  for (const file of files) {
    const relative = path.relative(skillRoot, file);
    const destination = path.join(target, "skills", relative);
    results.push(await copyFileSafe(file, destination, writeMode, { boundaryRoot: target }));
  }

  return results;
}

async function createStarterFiles(target, data, writeMode) {
  const files = starterFileContents(data);
  const results = [];

  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(target, relative);
    results.push(await writeFileSafe(destination, content, writeMode, { boundaryRoot: target }));
  }

  return results;
}

function starterFileContents(data) {
  return {
    ".env.example": [
      "# Copy this file to .env when plugins require local secrets.",
      "# Never paste secrets into chat or memory files.",
      "",
      "# Google Workspace",
      "# DotAIOS uses the local gws CLI for Gmail/Calendar/Drive beta access.",
      "# OAuth credentials stay in gws, not in this folder.",
      "# Run: dotaios connect google --dry-run"
    ].join("\n") + "\n",
    "connections/registry.md": "# Connections\n\n| Service | Status | Notes |\n|---|---|---|\n",
    "decisions/log.md": "# Decision Log\n\n",
    "FIRST_SESSION.md": renderTemplate(firstSessionTemplate(), data),
    "README.md": renderTemplate(localReadmeTemplate(), data),
    "memory/events.jsonl": "",
    "memory/errors.jsonl": "",
    // Every schedule ships disabled. DotAIOS never installs an OS job a user did
    // not ask for; `dotaios schedule install` is the explicit opt-in. What these
    // entries guarantee is that when a user does opt in, the checks that fire are
    // the ones that catch memory going stale — no LLM, no network, no cost.
    "schedules.yml": [
      "schedules:",
      "  - name: daily-brief",
      "    cadence: daily",
      "    command: \"dotaios brief\"",
      "    enabled: false",
      "  - name: weekly-health-check",
      "    cadence: weekly",
      "    command: \"dotaios doctor\"",
      "    enabled: false",
      "  - name: weekly-memory-audit",
      "    cadence: weekly",
      "    command: \"dotaios memory audit --all-memory\"",
      "    enabled: false"
    ].join("\n") + "\n",
    "skills/_registry.json": "{\n  \"format\": \"dotaios-skill-install-inventory/v2\",\n  \"skills\": [\"audit\", \"closeday\", \"import-context\", \"ingest\", \"memory-maintenance\", \"plan-today\", \"privacy-brief\", \"process-inbox\", \"research\", \"save-session\", \"summarize-source\", \"today\", \"weekly-review\"],\n  \"managed\": [],\n  \"plugins\": []\n}\n"
  };
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function printSuccess(target, vaultPath, results) {
  const counts = results.reduce((acc, result) => {
    acc[result.action] = (acc[result.action] || 0) + 1;
    return acc;
  }, {});

  console.log("\nDotAIOS initialized");
  console.log(`AIOS path: ${target}`);
  console.log(`Vault path: ${vaultPath}`);
  console.log(`Files: ${counts.created || 0} created, ${counts.updated || 0} updated, ${counts.kept || 0} kept`);
  console.log("\nNext steps:");
  console.log("1. Read FIRST_SESSION.md");
  console.log("2. Run `npx dotaios activate` to connect DotAIOS to your agent tools");
  console.log("3. Optional: run `npx dotaios connect google --dry-run` for Gmail/Calendar beta setup");
  console.log("4. Open Claude Code, Codex, Gemini, Cursor, or another agent-aware tool");
  console.log("5. Run `npx dotaios context` whenever you want to inspect what agents see");
  console.log("6. Run `npx dotaios brief` whenever you want today's local brief written down");
}

function firstSessionTemplate() {
  return `# First Session

Welcome to {{#if user_name}}{{user_name}}'s{{else}}your{{/if}} local AIOS.

## What To Open

Run \`npx dotaios activate\` once to connect DotAIOS to global Claude, Codex, and Gemini memory files.

For Gmail and Calendar beta setup, run:

\`\`\`
npx dotaios connect google --dry-run
\`\`\`

For a project you use in Cursor, run:

\`\`\`
npx dotaios attach /path/to/project
\`\`\`

## First Prompt To Try

\`\`\`
Read my local AIOS entrypoint, then help me plan what to work on today.
\`\`\`

## What To Edit First

- \`context/identity.md\`
- \`context/work.md\`
- \`context/priorities.md\`
- \`context/north-star.md\`

Keep these files short and true. Detail belongs in projects, skills, memory, or vault files.
`;
}

function localReadmeTemplate() {
  return `{{#if user_name}}# {{user_name}}'s AIOS{{else}}# My AIOS{{/if}}

Local-first memory and context for AI agents.

## Start Here

1. Read \`FIRST_SESSION.md\`.
2. Run \`npx dotaios activate\` once.
3. Keep \`context/\` current.
4. Add active work under \`projects/<slug>/README.md\`.
5. Put long-term knowledge in the configured vault.

## Safety

- Keep secrets in \`.env\`, not in chat.
- Durable writes to identity, wiki, and CRM knowledge should be approved.
- Companies and people live only in \`vault/org/\`.
`;
}
