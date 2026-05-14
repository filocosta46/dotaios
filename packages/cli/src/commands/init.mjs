import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { copyFileSafe, listFiles, pathExists, writeFileSafe } from "../../../core/src/files.mjs";
import { renderTemplate, renderTemplateTree } from "../../../core/src/render.mjs";
import { createAiosConfig } from "../../../core/src/schema.mjs";
import { writeSkillsIndex } from "../../../core/src/skills.mjs";
import { defaultAiosPath, expandHome, resolveVaultPath } from "../../../core/src/paths.mjs";
import { hasHelpFlag, readOptionValue } from "../lib/args.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export async function initCommand(args) {
  if (hasHelpFlag(args)) {
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
  await writeSkillsIndex(target);

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
  return renderTemplateTree(templateRoot, target, data, {
    writeMode,
    include: (outputRelative) => outputRelative !== "aios.json"
  });
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
    "schedules.yml": [
      "schedules:",
      "  - name: daily-brief",
      "    cadence: daily",
      "    command: \"dotaios brief\"",
      "    enabled: false"
    ].join("\n") + "\n",
    "skills/_registry.json": "{\n  \"skills\": [\"plan-today\", \"today\", \"closeday\", \"audit\", \"ingest\", \"import-context\", \"privacy-brief\", \"summarize-source\", \"weekly-review\"]\n}\n"
  };
  const results = [];

  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(target, relative);
    results.push(await writeFileSafe(destination, content, writeMode));
  }

  return results;
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

Welcome to {{user_name}}'s local AIOS.

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
  return `# {{user_name}}'s AIOS

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
