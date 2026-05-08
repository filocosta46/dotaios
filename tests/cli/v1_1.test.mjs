import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("activate creates global and project agent bridges", () => {
  const { aiosPath, homePath, projectPath } = setupAios();

  run(["activate", "--path", aiosPath, "--home", homePath, "--project", projectPath]);

  assert.match(read(path.join(homePath, ".claude", "CLAUDE.md")), new RegExp(`@${escapeRegex(path.join(aiosPath, "CLAUDE.md"))}`));
  assert.match(read(path.join(homePath, ".codex", "AGENTS.md")), new RegExp(escapeRegex(path.join(aiosPath, "AGENTS.md"))));
  assert.match(read(path.join(homePath, ".gemini", "GEMINI.md")), new RegExp(`@${escapeRegex(path.join(aiosPath, "AGENTS.md"))}`));
  assert.match(read(path.join(projectPath, ".cursor", "rules", "dotaios.mdc")), /alwaysApply: true/);
  assert.match(read(path.join(projectPath, "AGENTS.md")), /DotAIOS Project Bridge/);
});

test("activate preserves unmanaged files by default", () => {
  const { aiosPath, homePath } = setupAios();
  const codexPath = path.join(homePath, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, "# Existing\n\nKeep me.\n");

  run(["activate", "--path", aiosPath, "--home", homePath]);

  assert.equal(read(codexPath), "# Existing\n\nKeep me.\n");
});

test("context prints files and refreshes generated entrypoints", () => {
  const { aiosPath } = setupAios();
  const identityPath = path.join(aiosPath, "context", "identity.md");
  fs.writeFileSync(identityPath, [
    "# Identity",
    "",
    "## Basics",
    "",
    "- Name: Ada",
    "- Role: researcher",
    ""
  ].join("\n"));

  const contextResult = run(["context", "identity", "--path", aiosPath]);
  assert.match(contextResult.stdout, /- Name: Ada/);

  run(["context", "--refresh", "--path", aiosPath]);
  assert.match(read(path.join(aiosPath, "CLAUDE.md")), /Ada's AIOS/);
});

test("init creates secret-safe env placeholders", () => {
  const { aiosPath } = setupAios();

  assert.equal(fs.existsSync(path.join(aiosPath, ".env")), false);
  assert.match(read(path.join(aiosPath, ".env.example")), /Never paste secrets/);
  assert.match(read(path.join(aiosPath, ".gitignore")), /^\.env$/m);
  assert.match(read(path.join(aiosPath, ".gitignore")), /^token\.\*$/m);
});

test("status guides beta testers toward activation", () => {
  const { aiosPath, homePath } = setupAios();

  const before = run(["status", "--path", aiosPath, "--home", homePath]);
  assert.match(before.stdout, /Agent bridges/);
  assert.match(before.stdout, /npx dotaios activate/);

  run(["activate", "--path", aiosPath, "--home", homePath]);
  const after = run(["status", "--path", aiosPath, "--home", homePath]);
  assert.match(after.stdout, /global agent bridges look ready/);
});

test("import previews by default and applies with explicit approval", () => {
  const { aiosPath, tempRoot } = setupAios();
  const importPath = path.join(tempRoot, "import.json");
  fs.writeFileSync(importPath, JSON.stringify({
    context: {
      work: "Building DotAIOS with a small beta group."
    },
    projects: [
      {
        slug: "dotaios",
        content: "# DotAIOS\n\nLocal-first AI memory."
      }
    ],
    signals: [
      {
        type: "chat-import",
        project: "dotaios",
        summary: "Tester onboarding is the next priority."
      }
    ]
  }, null, 2));

  const preview = run(["import", importPath, "--path", aiosPath]);
  assert.match(preview.stdout, /Dry run only/);
  assert.doesNotMatch(read(path.join(aiosPath, "context", "work.md")), /Building DotAIOS/);

  run(["import", importPath, "--path", aiosPath, "--apply"]);
  assert.match(read(path.join(aiosPath, "context", "work.md")), /Building DotAIOS/);
  assert.match(read(path.join(aiosPath, "projects", "dotaios", "README.md")), /Local-first AI memory/);
  assert.match(read(path.join(aiosPath, "memory", "signals", new Date().toISOString().slice(0, 10) + ".jsonl")), /Tester onboarding/);
});

test("import blocks sensitive-looking content unless explicitly allowed", () => {
  const { aiosPath, tempRoot } = setupAios();
  const importPath = path.join(tempRoot, "secret-import.json");
  fs.writeFileSync(importPath, JSON.stringify({
    context: {
      work: "OPENAI_API_KEY should never live here."
    }
  }));

  const result = runFail(["import", importPath, "--path", aiosPath, "--apply"]);
  assert.match(result.stderr, /Sensitive-looking terms found/);
});

test("schedule lists due schedules and runs DotAIOS commands only", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "schedules.yml"), [
    "schedules:",
    "  - name: weekly-status",
    "    cadence: weekly",
    "    command: \"dotaios status\"",
    "    enabled: true",
    "  - name: unsafe",
    "    cadence: daily",
    "    command: \"node -v\"",
    "    enabled: true",
    ""
  ].join("\n"));

  assert.match(run(["schedule", "list", "--path", aiosPath]).stdout, /weekly-status/);
  assert.match(run(["schedule", "due", "--path", aiosPath]).stdout, /weekly-status/);
  run(["schedule", "run", "weekly-status", "--path", aiosPath]);
  assert.match(read(path.join(aiosPath, "schedules.yml")), /last_run:/);

  const unsafe = runFail(["schedule", "run", "unsafe", "--path", aiosPath]);
  assert.match(unsafe.stderr, /only run DotAIOS commands/);
});

test("install refuses remote plugin URLs", () => {
  const result = runFail(["install", "https://example.com/plugin"]);
  assert.match(result.stderr, /Remote plugin installs are not supported/);
});

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-test-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");
  const projectPath = path.join(tempRoot, "project");

  fs.mkdirSync(projectPath, { recursive: true });
  run(["init", "--path", aiosPath, "--yes"]);

  return { aiosPath, homePath, projectPath, tempRoot };
}

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }

  return result;
}

function runFail(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status === 0) {
    throw new Error(`Command unexpectedly passed: dotaios ${args.join(" ")}\n${result.stdout}`);
  }

  return result;
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
