import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// Every spawn gets an isolated HOME. `createContext` (packages/core/src/projects.mjs)
// falls back to `os.homedir()/.dotaios/projects.json` whenever `--home` is absent,
// so a single call that forgets the flag writes the machine's real project registry.
// Defence in depth: pin HOME here too, not only the flag, so a missing `--home`
// costs a failed assertion instead of the developer's own state.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-home-"));

function run(args, { home = sandboxHome } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home }
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
    ".agents/skills/foreign-skill"
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
    ".agents/skills"
  ]) {
    const link = path.join(projectPath, targetDir, "project-skill");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${targetDir} should be a symlink`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(source), `${targetDir} should resolve to project/skills`);
  }
}

function assertForeignEntriesPreserved(projectPath) {
  for (const relative of [
    ".claude/skills/foreign-skill/SKILL.md",
    ".agents/skills/foreign-skill/SKILL.md"
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

test("attach removes only DotAIOS-owned links from retired Antigravity project target", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const source = path.join(projectPath, "skills", "project-skill");
  const retiredDir = path.join(projectPath, ".gemini", "config", "skills");
  const managedLink = path.join(retiredDir, "project-skill");
  const foreignDir = path.join(retiredDir, "foreign-skill");
  fs.mkdirSync(retiredDir, { recursive: true });
  fs.symlinkSync(source, managedLink, "dir");
  fs.mkdirSync(foreignDir, { recursive: true });
  fs.writeFileSync(path.join(foreignDir, "SKILL.md"), "foreign project skill\n");

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    assert.equal(fs.existsSync(managedLink), false);
    assert.equal(
      fs.readFileSync(path.join(foreignDir, "SKILL.md"), "utf8"),
      "foreign project skill\n"
    );
    assert.equal(
      fs.realpathSync(path.join(projectPath, ".agents", "skills", "project-skill")),
      fs.realpathSync(source)
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach removes only a managed legacy Cursor rule", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const rulePath = path.join(projectPath, ".cursor", "rules", "dotaios.mdc");
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(
    rulePath,
    [
      "---",
      "description: DotAIOS personal context",
      "globs:",
      "alwaysApply: true",
      "---",
      "<!-- dotaios-managed:start -->",
      "legacy DotAIOS Cursor bridge",
      "<!-- dotaios-managed:end -->",
      ""
    ].join("\n")
  );

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    assert.equal(fs.existsSync(rulePath), false);
    assert.match(fs.readFileSync(path.join(projectPath, "AGENTS.md"), "utf8"), /DotAIOS Project Bridge/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach removes the retired Cursor block and preserves surrounding content", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const rulePath = path.join(projectPath, ".cursor", "rules", "dotaios.mdc");
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(
    rulePath,
    [
      "user content before",
      "<!-- dotaios-managed:start -->",
      "legacy DotAIOS Cursor bridge",
      "<!-- dotaios-managed:end -->",
      "user content after",
      ""
    ].join("\n")
  );

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    const current = fs.readFileSync(rulePath, "utf8");
    assert.match(current, /user content before/);
    assert.match(current, /user content after/);
    assert.doesNotMatch(current, /legacy DotAIOS Cursor bridge|dotaios-managed/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach dry-run previews legacy Cursor cleanup without changing the file", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const rulePath = path.join(projectPath, ".cursor", "rules", "dotaios.mdc");
  const original = [
    "---",
    "description: DotAIOS personal context",
    "globs:",
    "alwaysApply: true",
    "---",
    "<!-- dotaios-managed:start -->",
    "legacy DotAIOS Cursor bridge",
    "<!-- dotaios-managed:end -->",
    ""
  ].join("\n");
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, original);

  try {
    const output = run(["attach", projectPath, "--path", aiosPath, "--dry-run"]);

    assert.match(output, /would remove/i);
    assert.equal(fs.readFileSync(rulePath, "utf8"), original);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach preserves an unmanaged legacy Cursor rule", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const rulePath = path.join(projectPath, ".cursor", "rules", "dotaios.mdc");
  const original = "foreign Cursor rule\n";
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, original);

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    assert.equal(fs.readFileSync(rulePath, "utf8"), original);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach preserves a Cursor rule with reversed managed markers", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const rulePath = path.join(projectPath, ".cursor", "rules", "dotaios.mdc");
  const original = [
    "user content",
    "<!-- dotaios-managed:end -->",
    "more user content",
    "<!-- dotaios-managed:start -->",
    ""
  ].join("\n");
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, original);

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    assert.equal(fs.readFileSync(rulePath, "utf8"), original);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach preserves a retired Cursor rule with duplicate managed blocks", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const rulePath = path.join(projectPath, ".cursor", "rules", "dotaios.mdc");
  const block = [
    "<!-- dotaios-managed:start -->",
    "legacy DotAIOS Cursor bridge",
    "<!-- dotaios-managed:end -->"
  ].join("\n");
  const original = `user content before\n${block}\n${block}\nuser content after\n`;
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, original);

  try {
    const output = run(["attach", projectPath, "--path", aiosPath]);

    assert.match(output, /managed markers are malformed/i);
    assert.equal(fs.readFileSync(rulePath, "utf8"), original);
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
      ".agents/skills"
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
      ".agents/skills"
    ]) {
      assert.equal(fs.existsSync(path.join(projectPath, targetDir)), false, `${targetDir} should not be created`);
    }
    assert.equal(fs.readFileSync(hermesPath, "utf8"), beforeHermes);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach does not follow foreign symlinked skill roots", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const outside = path.join(tempRoot, "outside-skills");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(projectPath, ".agents"), { recursive: true });
  fs.symlinkSync(outside, path.join(projectPath, ".agents", "skills"), "dir");

  try {
    run(["attach", projectPath, "--path", aiosPath]);
    assert.equal(fs.existsSync(path.join(outside, "project-skill")), false);
    assert.equal(fs.lstatSync(path.join(projectPath, ".agents", "skills")).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(projectPath, ".claude", "skills", "project-skill")), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach refuses a project skills root that resolves outside the project", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const outside = path.join(tempRoot, "outside-skills");
  fs.rmSync(path.join(projectPath, "skills"), { recursive: true, force: true });
  fs.mkdirSync(path.join(outside, "external-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(outside, "external-skill", "SKILL.md"),
    "---\nname: external-skill\ndescription: external\n---\n"
  );
  fs.symlinkSync(outside, path.join(projectPath, "skills"), "dir");

  try {
    const output = run(["attach", projectPath, "--path", aiosPath]);

    assert.match(output, /unsafe.*source|source.*unsafe/i);
    assert.equal(fs.lstatSync(path.join(projectPath, "skills")).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(outside, "external-skill", "external-skill")), false);
      for (const targetDir of [
        ".claude/skills",
        ".agents/skills"
    ]) {
      assert.equal(
        fs.existsSync(path.join(projectPath, targetDir, "external-skill")),
        false,
        `${targetDir} must not expose an external project skill`
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach refuses a project skill file that resolves outside the project", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const outside = path.join(tempRoot, "external-skill.md");
  const skillFile = path.join(projectPath, "skills", "project-skill", "SKILL.md");
  fs.writeFileSync(outside, "---\nname: external-skill\ndescription: external\n---\n");
  fs.rmSync(skillFile);
  fs.symlinkSync(outside, skillFile, "file");

  try {
    const output = run(["attach", projectPath, "--path", aiosPath]);

    assert.match(output, /unsafe.*source|source.*unsafe/i);
    assert.equal(fs.readFileSync(outside, "utf8"), "---\nname: external-skill\ndescription: external\n---\n");
    assert.equal(fs.existsSync(path.join(projectPath, ".claude", "skills", "project-skill")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach does not overwrite foreign symlinked bridge files", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const externalAgents = path.join(tempRoot, "external-agents.md");
  const externalCursor = path.join(tempRoot, "external-cursor.mdc");
  const foreignAgents = "<!-- dotaios-managed:start -->\nforeign agents\n<!-- dotaios-managed:end -->\n";
  const foreignCursor = "<!-- dotaios-managed:start -->\nforeign cursor\n<!-- dotaios-managed:end -->\n";
  fs.writeFileSync(externalAgents, foreignAgents);
  fs.writeFileSync(externalCursor, foreignCursor);
  fs.symlinkSync(externalAgents, path.join(projectPath, "AGENTS.md"), "file");
  fs.mkdirSync(path.join(projectPath, ".cursor", "rules"), { recursive: true });
  fs.symlinkSync(externalCursor, path.join(projectPath, ".cursor", "rules", "dotaios.mdc"), "file");

  try {
    const output = run(["attach", projectPath, "--path", aiosPath]);

    assert.match(output, /unsafe.*target|target.*unsafe/i);
    assert.equal(fs.readFileSync(externalAgents, "utf8"), foreignAgents);
    assert.equal(fs.readFileSync(externalCursor, "utf8"), foreignCursor);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach refuses a custom project target that overlaps the source skills root", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  fs.writeFileSync(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [{
        name: "Overlapping Runner",
        detect: ".overlapping-runner",
        bridge: null,
        skills: {
          mode: "symlink",
          dir: ".overlapping-global/skills",
          project: { mode: "symlink", dir: "skills" }
        }
      }]
    })
  );

  try {
    const output = run(["attach", projectPath, "--path", aiosPath, "--overwrite"]);

    assert.match(output, /unsafe.*target|target.*unsafe/i);
    assert.equal(fs.existsSync(path.join(projectPath, "skills", "project-skill", "SKILL.md")), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach does not follow a foreign symlinked Hermes config", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();
  const outside = path.join(tempRoot, "external-hermes.yaml");
  fs.writeFileSync(outside, "skills:\n  external_dirs:\n    - /foreign/project/skills\n");
  const hermesPath = path.join(projectPath, ".hermes", "config.yaml");
  fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
  fs.symlinkSync(outside, hermesPath);

  try {
    run(["attach", projectPath, "--path", aiosPath]);
    assert.equal(fs.readFileSync(outside, "utf8"), "skills:\n  external_dirs:\n    - /foreign/project/skills\n");
    assert.equal(fs.lstatSync(hermesPath).isSymbolicLink(), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("attach cleans owned dangling project links after skills are removed", () => {
  const { tempRoot, aiosPath, projectPath } = setupProject();

  try {
    run(["attach", projectPath, "--path", aiosPath]);
    fs.rmSync(path.join(projectPath, "skills"), { recursive: true, force: true });
    run(["attach", projectPath, "--path", aiosPath]);
    for (const targetDir of [
      ".claude/skills",
      ".agents/skills"
    ]) {
      assert.equal(fs.existsSync(path.join(projectPath, targetDir, "project-skill")), false);
    }
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
        },
        {
          name: "Custom Hermes",
          detect: ".custom-hermes",
          bridge: null,
          skills: {
            mode: "config-external-dir",
            configFile: ".custom-hermes/config.yaml",
            key: "runner.skill_paths",
            project: {
              mode: "config-external-dir",
              configFile: ".custom-hermes/config.yaml",
              key: "runner.skill_paths"
            }
          }
        }
      ]
    })
  );
  fs.mkdirSync(path.join(projectPath, ".custom-hermes"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, ".custom-hermes", "config.yaml"),
    "runner:\n  skill_paths:\n    - /foreign/project/skills\n"
  );

  try {
    run(["attach", projectPath, "--path", aiosPath]);

    const source = path.join(projectPath, "skills", "project-skill");
    const customLink = path.join(projectPath, ".custom", "skills", "project-skill");
    assert.equal(fs.realpathSync(customLink), fs.realpathSync(source));
    const customHermesConfig = fs.readFileSync(
      path.join(projectPath, ".custom-hermes", "config.yaml"),
      "utf8"
    );
    assert.match(customHermesConfig, /- \/foreign\/project\/skills/);
    assert.match(customHermesConfig, new RegExp(`- ${path.join(projectPath, "skills").replaceAll("/", "\\/")}`));
    assert.equal(fs.existsSync(path.join(projectPath, "outside", "project-skill")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
