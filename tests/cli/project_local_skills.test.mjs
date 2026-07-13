import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(
    result.status,
    0,
    `Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`
  );
  return `${result.stdout}\n${result.stderr}`;
}

function setupProject({ withSkills = true } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-project-skills-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");
  const projectPath = path.join(tempRoot, "project");

  fs.mkdirSync(aiosPath, { recursive: true });
  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [] })
  );
  fs.writeFileSync(path.join(aiosPath, "AGENTS.md"), "# Test AIOS\n");

  if (withSkills) {
    const skillPath = path.join(projectPath, "skills", "project-skill");
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(
      path.join(skillPath, "SKILL.md"),
      "---\nname: project-skill\ndescription: A project-local test skill.\n---\n# Project skill\n"
    );
  }

  return { tempRoot, aiosPath, homePath, projectPath };
}

function addForeignEntries(projectPath) {
  for (const relative of [
    ".claude/skills/foreign-skill",
    ".agents/skills/foreign-skill",
    ".gemini/config/skills/foreign-skill"
  ]) {
    const foreignPath = path.join(projectPath, relative);
    fs.mkdirSync(foreignPath, { recursive: true });
    fs.writeFileSync(path.join(foreignPath, "SKILL.md"), "foreign project skill\n");
  }

  const hermesPath = path.join(projectPath, ".hermes", "config.yaml");
  fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
  fs.writeFileSync(
    hermesPath,
    "model:\n  provider: openrouter\nskills:\n  external_dirs:\n    - /foreign/project/skills\n"
  );
}

function projectSnapshot(root) {
  const snapshot = [];

  function walk(current, relative = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        snapshot.push({
          path: childRelative,
          type: "symlink",
          target: fs.readlinkSync(absolute)
        });
      } else if (entry.isDirectory()) {
        snapshot.push({ path: childRelative, type: "directory" });
        walk(absolute, childRelative);
      } else {
        snapshot.push({
          path: childRelative,
          type: "file",
          content: fs.readFileSync(absolute, "utf8")
        });
      }
    }
  }

  walk(root);
  return snapshot;
}

function assertProjectSkillLinks(projectPath) {
  const source = path.join(projectPath, "skills", "project-skill");
  for (const targetDir of [
    ".claude/skills",
    ".agents/skills",
    ".gemini/config/skills"
  ]) {
    const link = path.join(projectPath, targetDir, "project-skill");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${targetDir} should be a symlink`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(source), `${targetDir} should resolve to project/skills`);
  }
}

function assertForeignEntriesPreserved(projectPath) {
  for (const relative of [
    ".claude/skills/foreign-skill/SKILL.md",
    ".agents/skills/foreign-skill/SKILL.md",
    ".gemini/config/skills/foreign-skill/SKILL.md"
  ]) {
    assert.equal(fs.readFileSync(path.join(projectPath, relative), "utf8"), "foreign project skill\n");
  }
}

test("activate --project and attach expose project skills natively and preserve foreign entries", () => {
  const { tempRoot, aiosPath, homePath, projectPath } = setupProject();
  addForeignEntries(projectPath);

  try {
    run([
      "activate",
      "--path", aiosPath,
      "--home", homePath,
      "--project", projectPath,
      "--all"
    ]);

    assertProjectSkillLinks(projectPath);
    assertForeignEntriesPreserved(projectPath);

    const hermesPath = path.join(projectPath, ".hermes", "config.yaml");
    const projectSkillsPath = path.join(projectPath, "skills");
    const firstConfig = fs.readFileSync(hermesPath, "utf8");
    assert.match(firstConfig, /- \/foreign\/project\/skills/);
    assert.match(firstConfig, new RegExp(`- ${projectSkillsPath.replaceAll("/", "\\/")}`));

    const firstSnapshot = projectSnapshot(projectPath);
    run(["attach", projectPath, "--path", aiosPath]);

    assert.deepEqual(projectSnapshot(projectPath), firstSnapshot, "repeating attach must be idempotent");
    assertProjectSkillLinks(projectPath);
    assertForeignEntriesPreserved(projectPath);
    const secondConfig = fs.readFileSync(hermesPath, "utf8");
    assert.equal(secondConfig.split(projectSkillsPath).length - 1, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach --dry-run previews project-local skill wiring without changing files", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  addForeignEntries(projectPath);

  try {
    const before = projectSnapshot(projectPath);
    const output = run(["attach", projectPath, "--path", aiosPath, "--dry-run"]);

    assert.deepEqual(projectSnapshot(projectPath), before);
    assert.match(output, /project-skill/);
    assert.match(output, /Hermes config action/i);
    for (const targetDir of [
      ".claude/skills",
      ".agents/skills",
      ".gemini/config/skills"
    ]) {
      assert.equal(fs.existsSync(path.join(projectPath, targetDir, "project-skill")), false);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach does not create project-local skill targets when skills/ is absent", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject({ withSkills: false });
  const hermesPath = path.join(projectPath, ".hermes", "config.yaml");
  fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
  fs.writeFileSync(
    hermesPath,
    "model:\n  provider: openrouter\nskills:\n  external_dirs:\n    - /foreign/project/skills\n"
  );

  try {
    const beforeHermes = fs.readFileSync(hermesPath, "utf8");
    run(["attach", projectPath, "--path", aiosPath]);

    assert.equal(fs.existsSync(path.join(projectPath, "skills")), false);
    for (const targetDir of [
      ".claude/skills",
      ".agents/skills",
      ".gemini/config/skills"
    ]) {
      assert.equal(fs.existsSync(path.join(projectPath, targetDir)), false, `${targetDir} should not be created`);
    }
    assert.equal(fs.readFileSync(hermesPath, "utf8"), beforeHermes);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("project-local custom targets are registry-driven and reject unsafe paths", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  fs.writeFileSync(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [
        {
          name: "Custom Runner",
          detect: ".custom-runner",
          bridge: null,
          skills: {
            mode: "symlink",
            dir: ".custom-global/skills",
            project: { mode: "symlink", dir: ".custom/skills" }
          }
        },
        {
          name: "Unsafe Runner",
          detect: ".unsafe-runner",
          bridge: null,
          skills: {
            mode: "symlink",
            dir: ".unsafe-global/skills",
            project: { mode: "symlink", dir: "../outside" }
          }
        }
      ]
    })
  );

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    const source = path.join(projectPath, "skills", "project-skill");
    const customLink = path.join(projectPath, ".custom", "skills", "project-skill");
    assert.equal(fs.realpathSync(customLink), fs.realpathSync(source));
    assert.equal(fs.existsSync(path.join(projectPath, "outside", "project-skill")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
