import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("activate creates global and project agent bridges for installed tools", () => {
  const { aiosPath, homePath, projectPath } = setupAios();
  installAgents(homePath);

  run(["activate", "--path", aiosPath, "--home", homePath, "--project", projectPath]);

  assert.match(read(path.join(homePath, ".claude", "CLAUDE.md")), new RegExp(`@${escapeRegex(path.join(aiosPath, "AGENTS.md"))}`));
  assert.match(read(path.join(homePath, ".codex", "AGENTS.md")), new RegExp(escapeRegex(path.join(aiosPath, "AGENTS.md"))));
  assert.match(read(path.join(homePath, ".gemini", "GEMINI.md")), new RegExp(`@${escapeRegex(path.join(aiosPath, "AGENTS.md"))}`));
  assert.equal(fs.existsSync(path.join(projectPath, ".cursor", "rules", "dotaios.mdc")), false);
  assert.match(read(path.join(projectPath, "AGENTS.md")), /DotAIOS Project Bridge/);
});

test("activate skips AI tools that are not installed on the machine", () => {
  const { aiosPath, homePath } = setupAios();

  const result = run(["activate", "--path", aiosPath, "--home", homePath], {
    env: { ...process.env, PATH: "" }
  });

  assert.equal(fs.existsSync(path.join(homePath, ".claude", "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(homePath, ".codex", "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(homePath, ".claude")), false);
  assert.equal(fs.existsSync(path.join(homePath, ".gemini")), false);
  assert.equal(fs.existsSync(path.join(homePath, ".agents", "skills")), true);
  assert.match(result.stdout, /No known AI tools were detected/);
});

test("activate --all connects every known tool even when not detected", () => {
  const { aiosPath, homePath } = setupAios();

  run(["activate", "--path", aiosPath, "--home", homePath, "--all"]);

  assert.match(read(path.join(homePath, ".claude", "CLAUDE.md")), new RegExp(`@${escapeRegex(path.join(aiosPath, "AGENTS.md"))}`));
  assert.match(read(path.join(homePath, ".codex", "AGENTS.md")), new RegExp(escapeRegex(path.join(aiosPath, "AGENTS.md"))));
  assert.match(read(path.join(homePath, ".gemini", "GEMINI.md")), new RegExp(`@${escapeRegex(path.join(aiosPath, "AGENTS.md"))}`));
});

test("retired 1.x catalog commands fail with a boundary-safe migration message", () => {
  for (const command of ["license", "market"]) {
    const result = runFail([command]);
    assert.doesNotMatch(result.stderr, /Unknown command/i, command);
    assert.match(result.stderr, /removed from the free core in 1\.28\.0/i, command);
    assert.match(result.stderr, /no action was taken/i, command);
  }
});

test("activate preserves unmanaged files by default", () => {
  const { aiosPath, homePath } = setupAios();
  const codexPath = path.join(homePath, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, "# Existing\n\nKeep me.\n");

  run(["activate", "--path", aiosPath, "--home", homePath]);

  assert.equal(read(codexPath), "# Existing\n\nKeep me.\n");
});

test("init generates a skills index every agent can read", () => {
  const { aiosPath } = setupAios();

  const index = read(path.join(aiosPath, "skills", "INDEX.md"));
  assert.match(index, /# Installed Skills/);
  assert.match(index, /Any AI agent can run one/i);
  assert.match(index, /## audit/);
  assert.match(index, /skills\/audit\/SKILL\.md/);
});

test("activate refreshes the skills index and prints the unknown-tool paste line", () => {
  const { aiosPath, homePath } = setupAios();
  installAgents(homePath);

  const result = run(["activate", "--path", aiosPath, "--home", homePath]);

  assert.match(result.stdout, /refreshed/i);
  assert.match(result.stdout, /Paste this line into it/);
  assert.match(result.stdout, new RegExp(escapeRegex(path.join(aiosPath, "AGENTS.md"))));
  assert.match(read(path.join(aiosPath, "skills", "INDEX.md")), /## audit/);
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
  assert.match(read(path.join(aiosPath, "AGENTS.md")), /Ada's AIOS/);
  assert.match(read(path.join(aiosPath, "CLAUDE.md")), /@AGENTS\.md/);
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
  installAgents(homePath);

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

test("schedule doctor and install dry-run explain local OS handoff", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "schedules.yml"), [
    "schedules:",
    "  - name: weekly-status",
    "    cadence: weekly",
    "    command: \"dotaios status\"",
    "    enabled: true",
    ""
  ].join("\n"));

  const doctor = run(["schedule", "doctor", "--path", aiosPath]);
  assert.match(doctor.stdout, /DotAIOS schedule doctor/);
  assert.match(doctor.stdout, /dotaios schedule run-due/);

  const cron = run(["schedule", "install", "--dry-run", "--target", "cron", "--path", aiosPath]);
  assert.match(cron.stdout, /Target: cron/);
  assert.match(cron.stdout, /schedule run-due --path/);

  const launchd = run(["schedule", "install", "--dry-run", "--target", "launchd", "--path", aiosPath]);
  assert.match(launchd.stdout, /com\.dotaios\.schedule/);
  assert.match(launchd.stdout, /<string>run-due<\/string>/);
});

test("schedule run-due runs due DotAIOS schedules", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "schedules.yml"), [
    "schedules:",
    "  - name: weekly-status",
    "    cadence: weekly",
    "    command: \"dotaios status\"",
    "    enabled: true",
    ""
  ].join("\n"));

  run(["schedule", "run-due", "--path", aiosPath]);
  assert.match(read(path.join(aiosPath, "schedules.yml")), /last_run:/);
});

test("install refuses remote URL schemes", () => {
  const result = runFail(["install", "ftp://example.com/plugin"]);
  assert.match(result.stderr, /Remote plugin sources are not executed directly/);
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

// Simulate the per-tool config folders that DotAIOS uses to detect an
// installed AI tool. Without these, `activate` correctly skips the tool.
function installAgents(homePath) {
  for (const dir of [".claude", ".codex", ".gemini"]) {
    fs.mkdirSync(path.join(homePath, dir), { recursive: true });
  }
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
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
