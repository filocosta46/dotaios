import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { createAiosConfig } from "../../../core/src/schema.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export async function initCommand(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printInitHelp();
    return;
  }

  const options = parseOptions(args);
  const target = path.resolve(expandHome(options.path || defaultAiosPath()));
  const exists = await pathExists(target);

  if (exists && !options.force) {
    const entries = await fs.readdir(target);
    if (entries.length > 0) {
      throw new Error(`Target already exists and is not empty: ${target}\nRe-run with --force to add missing files, or --overwrite to replace generated files.`);
    }
  }

  const answers = options.yes ? defaultAnswers() : await promptAnswers();
  const config = createAiosConfig({
    aiTools: splitCsv(answers.ai_tools),
    vaultPath: options.vaultPath || null
  });

  const data = {
    ...answers,
    created_at: config.created_at,
    ai_tools: config.ai_tools,
    vault_path: config.vault_path
  };

  await createBaseTree(target, Boolean(config.vault_path));
  await createVaultTree(resolveVaultPath(config, target));
  const writeMode = options.overwrite ? "overwrite" : "preserve";
  const results = [];
  results.push(...await renderTemplates(target, data, writeMode));
  results.push(await writeFileSafe(path.join(target, "aios.json"), `${JSON.stringify(config, null, 2)}\n`, writeMode));
  results.push(...await copySkills(target, writeMode));
  results.push(...await createStarterFiles(target, data, writeMode));

  printSuccess(target, resolveVaultPath(config, target), results);
}

function parseOptions(args = []) {
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
  --path <dir>        Create AIOS somewhere other than ~/.aios
  --vault-path <dir>  Use an external vault for long-term knowledge
  --yes, -y           Use placeholder answers for non-interactive setup
  --force             Add missing files, preserving existing files
  --overwrite         Replace generated files in the target folder
`);
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

async function promptAnswers() {
  if (!process.stdin.isTTY) return defaultAnswers();

  const rl = readline.createInterface({ input, output });
  try {
    console.log("DotAIOS creates local memory files for the AI tools you already use.\n");
    return {
      user_name: await ask(rl, "Name", "Your Name"),
      user_role: await ask(rl, "What do you do?", "student / operator / builder"),
      current_work: await ask(rl, "What are you working on right now?", "Your active work threads"),
      priorities: await ask(rl, "What matters most this week?", "Your current bets and next actions"),
      ai_tools: await ask(rl, "AI tools you use", "claude-code,codex,cursor")
    };
  } finally {
    rl.close();
  }
}

async function ask(rl, label, fallback) {
  const answer = await rl.question(`${label} [${fallback}]: `);
  return answer.trim() || fallback;
}

function defaultAnswers() {
  return {
    user_name: "Your Name",
    user_role: "student / operator / builder",
    current_work: "Add the active work threads agents should keep in mind.",
    priorities: "Add the current bets and near-term priorities.",
    ai_tools: "claude-code,codex,cursor"
  };
}

async function createBaseTree(target, usesExternalVault) {
  const dirs = [
    "context/domains",
    "projects",
    "connections/apis",
    "memory/signals",
    "skills",
    "plugins",
    "decisions",
    "archives"
  ];

  if (!usesExternalVault) {
    dirs.push(
      "vault/wiki",
      "vault/raw",
      "vault/org/companies",
      "vault/org/people",
      "vault/outputs"
    );
  }

  await fs.mkdir(target, { recursive: true });
  await Promise.all(dirs.map((dir) => fs.mkdir(path.join(target, dir), { recursive: true })));
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
  const files = await listFiles(templateRoot);
  const results = [];

  for (const file of files) {
    const relative = path.relative(templateRoot, file);
    let outputRelative = relative.endsWith(".hbs") ? relative.slice(0, -4) : relative;
    if (outputRelative === "cursorrules") outputRelative = ".cursorrules";
    if (outputRelative === "aios.json") continue;

    const source = await fs.readFile(file, "utf8");
    const rendered = relative.endsWith(".hbs") ? render(source, data) : source;
    const destination = path.join(target, outputRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    results.push(await writeFileSafe(destination, rendered, writeMode));
  }

  return results;
}

async function copySkills(target, writeMode) {
  const skillRoot = path.join(repoRoot, "skills");
  const files = await listFiles(skillRoot);
  const results = [];

  for (const file of files) {
    const relative = path.relative(skillRoot, file);
    const destination = path.join(target, "skills", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    results.push(await copyFileSafe(file, destination, writeMode));
  }

  return results;
}

async function createStarterFiles(target, data, writeMode) {
  const files = {
    ".env.example": [
      "# Add local secrets here when plugins require them.",
      "",
      "# Gmail plugin",
      "# GOOGLE_CLIENT_ID=",
      "# GOOGLE_CLIENT_SECRET=",
      "",
      "# Calendar plugin",
      "# GOOGLE_CALENDAR_ID="
    ].join("\n") + "\n",
    "connections/registry.md": "# Connections\n\n| Service | Status | Notes |\n|---|---|---|\n",
    "decisions/log.md": "# Decision Log\n\n",
    "FIRST_SESSION.md": render(firstSessionTemplate(), data),
    "README.md": render(localReadmeTemplate(), data),
    "memory/events.jsonl": "",
    "memory/errors.jsonl": "",
    "schedules.yml": "schedules: []\n",
    "skills/_registry.json": "{\n  \"skills\": [\"plan-today\", \"audit\", \"ingest\", \"morning-digest\"]\n}\n"
  };
  const results = [];

  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(target, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    results.push(await writeFileSafe(destination, content, writeMode));
  }

  return results;
}

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(resolved) : resolved;
  }));

  return files.flat();
}

function render(template, data) {
  return template.replaceAll(/{{#if vault_path}}([\s\S]*?){{else}}([\s\S]*?){{\/if}}/g, (_match, yes, no) => (
    data.vault_path ? yes.replaceAll("{{vault_path}}", data.vault_path) : no
  )).replaceAll(/{{#each ai_tools}}([\s\S]*?){{\/each}}/g, () => (
    data.ai_tools.map((tool) => `"${tool}"`).join(", ")
  )).replaceAll(/{{(\w+)}}/g, (_match, key) => data[key] ?? "");
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function writeFileSafe(destination, content, writeMode) {
  const exists = await pathExists(destination);
  if (exists && writeMode === "preserve") {
    return { action: "kept", path: destination };
  }

  await fs.writeFile(destination, content);
  return { action: exists ? "updated" : "created", path: destination };
}

async function copyFileSafe(source, destination, writeMode) {
  const exists = await pathExists(destination);
  if (exists && writeMode === "preserve") {
    return { action: "kept", path: destination };
  }

  await fs.copyFile(source, destination);
  return { action: exists ? "updated" : "created", path: destination };
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
  console.log("2. Open Claude Code, Codex, Cursor, or another agent-aware tool");
  console.log("3. Ask it to read CLAUDE.md or AGENTS.md");
  console.log("4. Run `dotaios status` whenever you want a quick health check");
}

function firstSessionTemplate() {
  return `# First Session

Welcome to {{user_name}}'s local AIOS.

## What To Open

- Claude Code: read \`CLAUDE.md\`
- Codex, Gemini, OpenHands, or generic agents: read \`AGENTS.md\`
- Cursor: use \`.cursorrules\`

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
  return `# {{user_name}}'s AIOS

Local-first memory and context for AI agents.

## Start Here

1. Read \`FIRST_SESSION.md\`.
2. Keep \`context/\` current.
3. Add active work under \`projects/<slug>/README.md\`.
4. Put long-term knowledge in the configured vault.

## Safety

- Keep secrets in \`.env\`, not in chat.
- Durable writes to identity, wiki, and CRM knowledge should be approved.
- Companies and people live only in \`vault/org/\`.
`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
