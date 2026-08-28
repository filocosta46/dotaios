import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import {
  FIRST_TASK_PROMPT,
  readPackageVersion,
  resolveCliInvocation
} from "../../../core/src/bridges.mjs";
import { pathExists, writeFileSafe } from "../../../core/src/files.mjs";
import { previewMigration } from "../../../core/src/migrations.mjs";
import {
  isRecognizedOfficialSkillOverlay,
  loadOfficialSkillPackage,
  officialSkillNames
} from "../../../core/src/official-skills.mjs";
import { planTemplateTree, renderTemplate, renderTemplateTree } from "../../../core/src/render.mjs";
import { createAiosConfig } from "../../../core/src/schema.mjs";
import { collectSkills, compareUtf8Bytes, writeSkillsIndex } from "../../../core/src/skills.mjs";
import { hasStableManagedWorkspaceIgnoreRule } from "../../../core/src/workspace-ignore.mjs";
import { OFFICIAL_SCHEDULES } from "./schedule.mjs";
import {
  SETUP_TRANSACTION_FILE,
  defaultAiosPath,
  expandHome,
  isPathWithin,
  isPathWithinLexically,
  resolveVaultPath
} from "../../../core/src/paths.mjs";
import { assertOneAnswerSource, normalizeAnswerText, parseAnswers, readAllStdin, readAnswersFile } from "../lib/answers.mjs";
import { assertUniqueOptions, hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const BASE_TREE_DIRS = [
  "context/domains",
  "projects",
  "connections/apis",
  "memory/signals",
  "memory/daily",
  "memory/sessions",
  // The shipped AGENTS.md tells agents to check this at session start and the
  // bundled process-inbox skill is built around it, so the folder has to exist.
  "memory/inbox",
  "skills",
  "plugins",
  "decisions"
];
const BUILT_IN_VAULT_DIRS = [
  "vault/wiki",
  "vault/raw",
  "vault/org/companies",
  "vault/org/people",
  "vault/outputs"
];
const SKILL_CATALOG_FILES = ["skills/INDEX.md", "skills/RESOLVER.md"];
const MAX_OFFICIAL_INIT_OVERLAY_BYTES = 1024 * 1024;
const POSIX_MODE_MASK = 0o7777;

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
  const answers = planned ? null : await resolveAnswers(options, lifecycle);
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

  // Render-time only, deliberately NOT part of `data`. The setup transaction
  // persists `data` and revalidates it with an exact-key check
  // (`isSetupPlan` in setup.mjs), so an extra key there invalidates every
  // in-flight transaction and breaks crash recovery. These two are machine and
  // release facts, not the user's answers:
  //   cli     — AGENTS.md tells every agent how to invoke DotAIOS, and a bare
  //             command name is unrunnable after the documented npx install.
  //   version — the doc links are pinned to a release tag, which is how the
  //             hardcoded v2.0.5 pair rotted three releases behind.
  const templateData = {
    ...data,
    cli: await resolveCliInvocation(),
    version: await readPackageVersion()
  };
  const officialSkills = await loadOfficialSkillPackage({ candidateVersion: templateData.version });

  if (options.force) {
    await assertGeneratedDestinationsSafe(target, data, Boolean(config.vault_path), officialSkills);
    await assertOfficialInitDestinations(target, officialSkills, { allowMissing: true });
  }

  await lifecycle.beforeScaffold?.({ config, data });
  // Setup's ownership marker is published by beforeScaffold. Re-check the
  // complete write surface after that hook and before the scaffold itself can
  // mutate anything, so a raced descendant or ignore boundary cannot redirect
  // or weaken this run.
  await assertAiosRootSafe(target);
  await assertGeneratedDestinationsSafe(target, data, Boolean(config.vault_path), officialSkills);
  await assertOfficialInitDestinations(target, officialSkills, { allowMissing: true });
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
  results.push(...await renderTemplates(target, templateData, writeMode));
  results.push(await writeFileSafe(
    path.join(target, "aios.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    writeMode,
    { boundaryRoot: target }
  ));
  results.push(...await copySkills(target, writeMode, officialSkills));
  await assertOfficialInitDestinations(target, officialSkills, { allowMissing: false });
  results.push(...await createStarterFiles(target, templateData, writeMode, officialSkills));
  const officialNames = new Set(officialSkills.skills.map(({ name }) => name));
  const personalSkills = (await collectSkills(target)).filter(({ dir }) => !officialNames.has(dir));
  const catalogSkills = [
    ...personalSkills,
    ...officialSkills.skills.map(({ catalog }) => catalog)
  ].sort((left, right) => (
    compareUtf8Bytes(left.name, right.name) || compareUtf8Bytes(left.dir, right.dir)
  ));
  await assertOfficialInitDestinations(target, officialSkills, { allowMissing: false });
  results.push(await createStarterRegistry(target, templateData, writeMode, officialSkills, catalogSkills));
  const skillsIndex = await writeSkillsIndex(target, {
    writeMode,
    skills: catalogSkills
  });
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
  assertUniqueOptions(args, ["--path", "--vault-path", "--answers"]);
  const options = { force: false, overwrite: false, path: null, vaultPath: null, yes: false, answers: null };

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
    if (arg === "--answers") {
      options.answers = readOptionValue(args, index, "--answers");
      index += 1;
    }
    if (arg === "--path") {
      options.path = readOptionValue(args, index, "--path");
      index += 1;
    }
  }

  assertOneAnswerSource(options);

  return options;
}

function printInitHelp() {
  console.log(`Usage:
  dotaios init [options]

Options:
  --path <dir>        Create AIOS somewhere other than ~/aios
  --vault-path <dir>  Use an external vault for long-term knowledge
  --answers <file>    Read the interview answers from a JSON file ("-" for stdin)
  --yes, -y           Use placeholder answers for non-interactive setup
  --force             Add missing files, preserving existing files
  --overwrite         Replace generated files in the target folder

--answers is how an AI assistant installs this for someone who never opens a
terminal: it asks the same questions in the conversation, where they are far
easier to answer, and passes the person's own words through. Accepted keys,
all optional, but at least one must carry content:

  { "name": "...", "role": "...", "work": "...",
    "priorities": "...", "ai_tools": ["claude-code", "codex"] }
`);
}

// The interview answers arrive one of three ways: typed at a TTY, supplied as
// JSON by whoever is driving the install, or waived with --yes. Only the first
// two produce real context, and the JSON path exists because the people this is
// built for are talking to an assistant, not standing at a shell prompt.
//
// setup retries init (--force, transaction recovery) and stdin only drains
// once, so setup reads it and hands the text down through `lifecycle.answersRaw`
// rather than this module holding it for the life of the process.
async function resolveAnswers(options, lifecycle) {
  if (options.answers) {
    const raw = lifecycle.answersRaw
      ?? (options.answers === "-" ? await readAllStdin() : await readAnswersFile(options.answers));
    return parseAnswers(raw, defaultAnswers());
  }
  if (options.yes) return defaultAnswers();
  return promptAnswers();
}

async function promptAnswers() {
  if (!process.stdin.isTTY) {
    console.error("");
    console.error("DotAIOS could not find an interactive terminal.");
    console.error("");
    console.error("If an AI assistant is running this: ask the five questions in the");
    console.error("conversation, save the answers as JSON, and re-run with");
    console.error("--answers <file>. `dotaios init --help` lists the keys.");
    console.error("Do not reach for --yes instead: it installs placeholder context.");
    console.error("");
    console.error("If you are doing this yourself, the command needs a Terminal window:");
    console.error("  Mac:     press cmd+space, type 'Terminal', press Enter.");
    console.error("  Windows: press the Windows key, type 'cmd', press Enter.");
    console.error("  Linux:   open your usual shell.");
    console.error("");
    console.error("Then paste the same command into that Terminal window.");
    throw new Error("interactive terminal required (pass --answers <file> to supply them, or --yes for placeholders)");
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log("DotAIOS creates local memory files for the AI tools you already use.\n");
    return {
      user_name: await ask(rl, "Name", "<!-- Your Name -->", "user_name"),
      user_role: await ask(rl, "What do you do?", "<!-- Your Role -->", "user_role"),
      current_work: await ask(rl, "What are you working on right now?", "<!-- Add the active work threads agents should keep in mind. -->", "current_work"),
      priorities: await ask(rl, "What matters most this week?", "<!-- Add the current bets and near-term priorities. -->", "priorities"),
      ai_tools: await ask(rl, "AI tools you use", "claude-code,codex,cursor", "ai_tools")
    };
  } finally {
    rl.close();
  }
}

// The prompt was the one door that applied none of the answer rules: this was
// `answer.trim() || fallback`, so an ellipsis, this repo's own
// `<!-- Your Name -->` placeholder, a zero-width space, a bidi override or a
// bare carriage return went straight into context/identity.md and the install
// reported success — a folder byte-identical to a --yes placeholder one, which
// is the outcome --answers exists to prevent.
//
// A failure here means something different than it does for --answers, though.
// --answers has nobody left to ask, so it stops the run and leaves nothing
// behind. The person is standing at this prompt, so the answer is to say what
// was wrong and ask again. Enter still accepts the field as unanswered, which
// is the one way to reach the placeholder deliberately.
const MAX_REASKS = 3;

// The rules are shared with --answers, so their messages end by telling the
// caller to omit the key — correct advice for a JSON file, meaningless to
// someone standing at a prompt who has no keys to omit. Keep the sentence that
// says what is wrong, drop the one that names a remedy this reader does not
// have; the next line offers the remedy they do have.
function promptReason(message) {
  return message
    .split("\n")
    .flatMap((line) => line.split(/(?<=\.)\s+(?=[A-Z])/))
    .filter((sentence) => sentence.trim() && !/omit the key/i.test(sentence))
    .map((sentence) => `  ${sentence.trim()}`)
    .join("\n");
}

async function ask(rl, label, fallback, field) {
  const displayFallback = fallback.startsWith("<!--") ? "" : ` [${fallback}]`;

  for (let attempt = 0; ; attempt += 1) {
    const answer = (await rl.question(`${label}${displayFallback}: `)).trim();
    if (!answer) return fallback;

    try {
      return field === "ai_tools" ? answer : normalizeAnswerText(answer, "What you typed", field);
    } catch (error) {
      // Three tries, then take them at their word rather than trapping someone
      // in a loop they cannot leave — a stubborn answer is still better than an
      // abandoned install, and the field is theirs.
      if (attempt >= MAX_REASKS - 1) {
        console.log("  Keeping it as typed.\n");
        return answer;
      }
      console.log(promptReason(error.message));
      console.log("  Press Enter to leave this blank, or type it again.\n");
    }
  }
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

async function lstatIfPresent(filePath, options = undefined) {
  try {
    return await fs.lstat(filePath, options);
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

async function planGeneratedPaths(target, data, usesExternalVault, officialSkills) {
  const templateRoot = path.join(repoRoot, "templates");
  const templatePlan = await planTemplateTree(templateRoot, target, data, templateTreeOptions());
  const files = new Set([
    ...templatePlan.map((item) => item.path),
    path.join(target, "aios.json"),
    ...officialSkills.skills.flatMap((skill) => skill.files.map((file) => (
      path.join(target, "skills", skill.name, file.path)
    ))),
    ...Object.keys(starterFileContents(data, officialSkills)).map((relative) => path.join(target, relative)),
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

async function assertGeneratedDestinationsSafe(target, data, usesExternalVault, officialSkills) {
  const { files, directories } = await planGeneratedPaths(
    target,
    data,
    usesExternalVault,
    officialSkills
  );

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

async function assertOfficialInitDestinations(target, officialSkills, { allowMissing }) {
  const skillsRoot = path.join(target, "skills");
  for (const skill of officialSkills.skills) {
    const root = path.join(skillsRoot, skill.name);
    const rootStats = await lstatIfPresent(root, { bigint: true });
    if (!rootStats) {
      if (allowMissing) continue;
      throw new Error(`Official skill is missing after initialization: ${skill.name}`);
    }
    if (
      !rootStats.isDirectory()
      || rootStats.isSymbolicLink()
      || (process.platform !== "win32" && (Number(rootStats.mode) & POSIX_MODE_MASK) !== skill.mode)
    ) throw new Error(`Official skill conflicts with the package manifest: ${skill.name}`);

    const declared = new Map(skill.files.map((file) => [file.path, file]));
    const overlays = new Map(skill.generated_overlays.map((overlay) => [overlay.path, overlay]));
    const entries = await fs.readdir(root, { withFileTypes: true });
    const names = entries.map(({ name }) => name).sort(compareUtf8Bytes);
    for (const entry of entries) {
      await assertOfficialInitEntry(skill, root, entry, declared, overlays);
    }
    if (!allowMissing) {
      for (const relative of declared.keys()) {
        if (!names.includes(relative)) {
          throw new Error(`Official skill is incomplete after initialization: ${skill.name}/${relative}`);
        }
      }
    }
    const finalRoot = await lstatIfPresent(root, { bigint: true });
    const finalEntries = await fs.readdir(root, { withFileTypes: true });
    const finalNames = finalEntries.map(({ name }) => name).sort(compareUtf8Bytes);
    if (
      !finalRoot?.isDirectory()
      || finalRoot.isSymbolicLink()
      || finalRoot.dev !== rootStats.dev
      || finalRoot.ino !== rootStats.ino
      || (process.platform !== "win32" && (Number(finalRoot.mode) & POSIX_MODE_MASK) !== skill.mode)
      || names.length !== finalNames.length
      || names.some((name, index) => name !== finalNames[index])
    ) throw new Error(`Official skill changed during initialization: ${skill.name}`);
    for (const entry of finalEntries) {
      await assertOfficialInitEntry(skill, root, entry, declared, overlays);
    }
  }
}

async function assertOfficialInitEntry(skill, root, entry, declared, overlays) {
  const expected = declared.get(entry.name);
  const overlay = overlays.get(entry.name);
  if ((!expected && !overlay) || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Official skill conflicts with the package manifest: ${skill.name}/${entry.name}`);
  }
  const observed = await readStableOfficialInitFile(
    path.join(root, entry.name),
    expected?.bytes ?? MAX_OFFICIAL_INIT_OVERLAY_BYTES
  );
  const expectedMode = expected?.mode ?? overlay.mode;
  if (
    observed.stats.nlink !== 1n
    || (process.platform !== "win32" && observed.mode !== expectedMode)
    || (expected && !observed.bytes.equals(expected.installed_bytes))
    || (overlay && !isRecognizedOfficialSkillOverlay(skill.name, entry.name, observed.bytes))
  ) throw new Error(`Official skill conflicts with the package manifest: ${skill.name}/${entry.name}`);
}

async function readStableOfficialInitFile(filePath, maxBytes) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Official skill file is unsafe: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== before.size
    ) throw new Error(`Official skill file changed during initialization: ${filePath}`);
    return { bytes, stats: after, mode: Number(after.mode) & POSIX_MODE_MASK };
  } finally {
    await handle.close();
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

async function copySkills(target, writeMode, officialSkills) {
  const results = [];

  for (const skill of officialSkills.skills) {
    const skillRoot = path.join(target, "skills", skill.name);
    let createdRoot = false;
    try {
      await fs.mkdir(skillRoot, { mode: skill.mode });
      createdRoot = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const rootStats = await lstatIfPresent(skillRoot);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error(`Cannot initialize through unsafe generated directory: ${skillRoot}`);
    }
    const createdRootIdentity = createdRoot
      ? await normalizeCreatedOfficialRoot(skillRoot, skill.mode)
      : null;
    for (const file of skill.files) {
      const destination = path.join(skillRoot, file.path);
      const result = await writeFileSafe(destination, file.installed_bytes, writeMode, {
        boundaryRoot: target,
        mode: file.mode,
        exactMode: process.platform !== "win32"
      });
      results.push(result);
    }
    if (createdRootIdentity) {
      const finalStats = await fs.lstat(skillRoot, { bigint: true });
      if (
        !finalStats.isDirectory()
        || finalStats.isSymbolicLink()
        || finalStats.dev !== createdRootIdentity.dev
        || finalStats.ino !== createdRootIdentity.ino
      ) throw new Error(`Official skill root changed during initialization: ${skillRoot}`);
    }
  }

  return results;
}

async function normalizeCreatedOfficialRoot(skillRoot, mode) {
  const before = await fs.lstat(skillRoot, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Cannot initialize through unsafe generated directory: ${skillRoot}`);
  }
  if (process.platform === "win32") return { dev: before.dev, ino: before.ino };
  const handle = await fs.open(
    skillRoot,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0)
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Official skill root changed during initialization: ${skillRoot}`);
    }
    await handle.chmod(mode);
    await handle.sync();
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

async function createStarterFiles(target, data, writeMode, officialSkills) {
  const files = starterFileContents(data, officialSkills);
  delete files["skills/_registry.json"];
  const results = [];

  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(target, relative);
    results.push(await writeFileSafe(destination, content, writeMode, { boundaryRoot: target }));
  }

  return results;
}

async function createStarterRegistry(target, data, writeMode, officialSkills, catalogSkills) {
  const content = starterFileContents(data, officialSkills, catalogSkills)["skills/_registry.json"];
  return writeFileSafe(path.join(target, "skills", "_registry.json"), content, writeMode, {
    boundaryRoot: target
  });
}

function starterFileContents(data, officialSkills = null, catalogSkills = null) {
  const names = catalogSkills
    ? catalogSkills.map(({ dir }) => dir).sort(compareUtf8Bytes)
    : officialSkills
      ? officialSkills.skills.map(({ name }) => name)
    : officialSkillNames();
  return {
    ".env.example": [
      "# Copy this file to .env when plugins require local secrets.",
      "# Never paste secrets into chat or memory files.",
      "",
      "# Google Workspace",
      "# DotAIOS uses the local gws CLI for Gmail/Calendar/Drive beta access.",
      "# OAuth credentials stay in gws, not in this folder.",
      `# Run: ${data.cli} connect google --dry-run`
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
      // Persist the exact candidate identity for inspection and field repair.
      // The scheduler parses this field, then invokes the in-package CLI module;
      // it never executes the recorded PATH command.
      ...OFFICIAL_SCHEDULES.flatMap(({ name, cadence, commandTail }) => [
        `  - name: ${name}`,
        `    cadence: ${cadence}`,
        `    command: "${data.cli} ${commandTail}"`,
        "    enabled: false"
      ])
    ].join("\n") + "\n",
    "skills/_registry.json": `${JSON.stringify({
      format: "dotaios-skill-install-inventory/v2",
      skills: names,
      managed: [],
      plugins: []
    }, null, 2)}\n`
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
  return `# How this works

{{#if user_name}}{{user_name}}, this folder is yours.{{else}}This folder is yours.{{/if}}

It holds what you just told us: who you are, what you are working on, and what
matters right now. All of it as ordinary text files on this computer.

Every AI you use starts from nothing and asks you to explain yourself again.
This folder is what they read first, so you do not have to.

Open any file, change it, delete it. Nothing here is locked.

## Do one useful task first

Start Claude Code, Codex, or another supported local agent outside this AIOS
folder, from your usual work folder. Paste this exact prompt:

> ${FIRST_TASK_PROMPT}

The agent asks for any missing folder, purpose, and desired outcome. If the
folder is new to DotAIOS, it previews the connection and waits for you to
confirm it. Then it understands the bounded project context, proposes one exact
action, and waits again. Nothing is changed until a fresh reply approves the
proposal you can see. Declining stops the work.

A browser-only chat cannot access your local folder or run this flow. Use a
supported local agent on this computer; do not paste folder paths into a browser
chat and assume it can open them.

## Deciding what an AI can see

Say one of these at the start of a conversation:

- \`Use my memory\`: it can read everything in this folder.
- \`Only this project\`: it can read that one project and nothing else about you.
- \`Private chat\`: it reads nothing and saves nothing.
  Your AI app may still keep its own conversation history; that part is not ours
  to erase.

The assistant tells you which one it is using in its first line, so you never
have to guess.

Opening this AIOS folder can let your app read it before your first prompt, and
saying \`Private chat\` afterwards cannot undo a read that already happened. Work
somewhere else when you want a conversation that touches none of this.

## Keeping it true

- When something changes, just tell the assistant and ask it to update your
  context. You do not have to edit files yourself.
- Nothing is saved unless you ask. Save only if you explicitly ask for it and
  name or confirm the Shared or This project scope. It will not quietly remember
  things you said in passing.
- Never put passwords, keys, or recovery codes in here.

## What is in the folder

- \`context/\`: your role, your work, your priorities.
- \`projects/\`: one folder for each thing you are working on.
- \`memory/\`: what you have asked it to remember, over time.

Gmail, Calendar, and Drive can be connected later, read-only. There is no rush.
`;
}

function localReadmeTemplate() {
  return `{{#if user_name}}# {{user_name}}'s AIOS{{else}}# My AIOS{{/if}}

Local-first memory and context for AI agents.

## Start Here

1. Read \`FIRST_SESSION.md\`.
2. Run \`{{cli}} activate\` once.
3. Paste the stable first-task prompt into a supported local agent.
4. Approve only the exact folder connection or action you reviewed.
5. Keep \`context/\` current and put long-term knowledge in the configured vault.

## Safety

- Keep passwords in a password manager and provider credentials in provider-owned auth. Use \`.env\` only for a required local environment variable; never paste it into chat or memory.
- Durable writes to identity, wiki, and CRM knowledge should be approved.
- Companies and people live only in \`vault/org/\`.
`;
}
