import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectSkillHealth } from "../../packages/core/src/skill-health.mjs";
import { installSymlinkSkills } from "../../packages/core/src/skills-install.mjs";
import { writeSkillsIndex } from "../../packages/core/src/skills.mjs";

async function makeAios() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-health-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  await fs.mkdir(path.join(aiosPath, "skills", "today"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "today", "SKILL.md"),
    "---\nname: today\ndescription: plan today\ntriggers:\n  - plan today\n---\n"
  );
  await writeSkillsIndex(aiosPath);
  await fs.mkdir(path.join(homePath, ".hermes"), { recursive: true });
  await fs.writeFile(
    path.join(homePath, ".hermes", "config.yaml"),
    `skills:\n  external_dirs:\n    - ${path.join(aiosPath, "skills")}\n`
  );
  return { aiosPath, homePath };
}

async function installProbeAgent({ aiosPath, homePath }) {
  await fs.writeFile(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [{
        name: "Probe Agent",
        detect: ".probe-agent",
        bridge: null,
        command: "node",
        skills: { mode: "symlink", dir: ".agents/skills" }
      }]
    })
  );
  await fs.mkdir(path.join(homePath, ".probe-agent"), { recursive: true });
}

test("inspectSkillHealth reports complete native coverage and fresh catalogs", async () => {
  const { aiosPath, homePath } = await makeAios();
  for (const targetDir of [
    path.join(homePath, ".agents", "skills"),
    path.join(homePath, ".claude", "skills")
  ]) {
    await installSymlinkSkills({ aiosPath, targetDir });
  }

  const report = await inspectSkillHealth({
    aiosPath,
    homePath,
    detection: { env: { PATH: "" } }
  });
  assert.equal(report.source.count, 1);
  assert.equal(report.catalogs.index.current, true);
  assert.equal(report.catalogs.resolver.current, true);
  assert.equal(report.targets.every((target) => target.complete), true);
  assert.equal(report.targets.filter((target) => target.status === "active").every((target) => target.canonicalPresent), true);
  assert.equal(report.hermes.configs[0].status, "healthy");
});

test("inspectSkillHealth accepts a valid indirect link through the shared agents directory", async () => {
  const { aiosPath, homePath } = await makeAios();
  const shared = path.join(homePath, ".agents", "skills");
  const claude = path.join(homePath, ".claude", "skills");
  await installSymlinkSkills({ aiosPath, targetDir: shared });
  await fs.mkdir(path.dirname(claude), { recursive: true });
  await fs.symlink(shared, claude, "dir");

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const target = report.targets.find((entry) => entry.dir === ".claude/skills");
  assert.deepEqual(target.foreign, []);
  assert.deepEqual(target.broken, []);
  assert.deepEqual(target.linked, ["today"]);
});

test("inspectSkillHealth reports missing, foreign, stale, and absent Hermes surfaces without writing", async () => {
  const { aiosPath, homePath } = await makeAios();
  const agentsDir = path.join(homePath, ".agents", "skills");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(path.join(agentsDir, "today"), { recursive: true });
  await fs.mkdir(path.join(homePath, ".claude"), { recursive: true });
  await fs.writeFile(path.join(homePath, ".claude", "settings.json"), "{}\n");
  await fs.writeFile(
    path.join(homePath, ".claude", "CLAUDE.md"),
    "<!-- dotaios-managed:start -->\n@/var/folders/old/aios/AGENTS.md\n<!-- dotaios-managed:end -->\n"
  );
  await fs.writeFile(path.join(aiosPath, "skills", "RESOLVER.md"), "stale\n");
  await fs.rm(path.join(homePath, ".hermes", "config.yaml"));

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const shared = report.targets.find((target) => target.dir === ".agents/skills");
  assert.deepEqual(shared.missing, []);
  assert.equal(shared.foreign.length, 1);
  assert.equal(shared.canonicalPresent, false);
  assert.equal(report.catalogs.resolver.current, false);
  assert.equal(report.bridges.find((bridge) => bridge.name === "Claude Code").status, "stale");
  assert.equal(report.hermes.configs[0].status, "missing");
  assert.equal(report.healthy, false);
});

test("inspectSkillHealth does not fail for agents and Hermes that are not installed", async () => {
  const { aiosPath, homePath } = await makeAios();
  await fs.rm(path.join(homePath, ".hermes"), { recursive: true, force: true });

  const report = await inspectSkillHealth({
    aiosPath,
    homePath,
    detection: { env: { PATH: "" } }
  });
  assert.equal(report.healthy, true);
  assert.ok(report.targets.every((target) => target.status === "not-detected"));
  assert.ok(report.targets.every((target) => target.canonicalPresent === null));
  assert.ok(report.bridges.filter((bridge) => bridge.bridge !== false).every((bridge) => bridge.status === "not-detected"));
  assert.ok(report.bridges.filter((bridge) => bridge.bridge === false).every((bridge) => bridge.status === "not-applicable"));
  assert.equal(report.hermes.available, false);
});

test("inspectSkillHealth reports a Hermes config behind a symlinked ancestor as unsafe", async () => {
  const { aiosPath, homePath } = await makeAios();
  const hermesPath = path.join(homePath, ".hermes");
  const outsidePath = path.join(path.dirname(homePath), "outside-hermes");
  await fs.rename(hermesPath, outsidePath);
  await fs.symlink(outsidePath, hermesPath);

  const report = await inspectSkillHealth({ aiosPath, homePath });

  assert.equal(report.hermes.configs[0].status, "unsafe");
  assert.equal(report.healthy, false);
});

test("inspectSkillHealth enumerates stale extra native links", async () => {
  const { aiosPath, homePath } = await makeAios();
  const targetDir = path.join(homePath, ".agents", "skills");
  await installSymlinkSkills({ aiosPath, targetDir });
  const staleSource = path.join(aiosPath, "skills", "removed-skill");
  await fs.symlink(staleSource, path.join(targetDir, "removed-skill"), "dir");

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const target = report.targets.find((entry) => entry.dir === ".agents/skills");
  assert.equal(target.extra.length, 1);
  assert.equal(target.stale.length, 1);
  assert.equal(target.extra[0].kind, "stale-owned");
  assert.equal(target.canonicalPresent, true);
  assert.equal(target.complete, false);
  assert.equal(report.healthy, false);
});

test("inspectSkillHealth flags readable foreign aliases that can confuse a client", async () => {
  const { aiosPath, homePath } = await makeAios();
  const targetDir = path.join(homePath, ".agents", "skills");
  await installSymlinkSkills({ aiosPath, targetDir });
  await fs.symlink(path.join(aiosPath, "skills", "today"), path.join(targetDir, "vendor-today"), "dir");
  await installProbeAgent({ aiosPath, homePath });

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const target = report.targets.find((entry) => entry.dir === ".agents/skills");
  assert.equal(target.extra[0].kind, "foreign-symlink");
  assert.match(report.issues.join("\n"), /\.agents\/skills: 1 unmanaged extra link/);
  assert.equal(target.canonicalPresent, true);
  assert.equal(target.complete, false);
  const runtime = report.runtimes.find((entry) => entry.name === "Probe Agent");
  assert.equal(runtime.capabilities.configured, "yes");
  assert.equal(runtime.capabilities.projected, "yes");
  assert.equal(runtime.capabilities.discoverable, "not-probed");
  assert.equal(runtime.capabilities.invocation, "not-run");
  assert.equal(runtime.capabilities.produced, "not-run");
  assert.equal(runtime.evidence.skillTarget.canonicalPresent, true);
  assert.equal(report.healthy, false);
});

test("inspectSkillHealth identifies a canonical frontmatter alias separately", async () => {
  const { aiosPath, homePath } = await makeAios();
  const source = path.join(aiosPath, "skills", "today");
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: plan-today\ndescription: plan today\ntriggers:\n  - plan today\n---\n"
  );
  const targetDir = path.join(homePath, ".agents", "skills");
  await installSymlinkSkills({ aiosPath, targetDir });
  await fs.symlink(source, path.join(targetDir, "plan-today"), "dir");
  await installProbeAgent({ aiosPath, homePath });

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const target = report.targets.find((entry) => entry.dir === ".agents/skills");
  assert.equal(target.aliases.length, 1);
  assert.equal(target.aliases[0].alias, "plan-today");
  assert.equal(target.aliases[0].canonical, "today");
  assert.match(report.issues.join("\n"), /duplicate managed alias/);
  assert.equal(target.canonicalPresent, true);
  assert.equal(target.complete, false);
  const runtime = report.runtimes.find((entry) => entry.name === "Probe Agent");
  assert.equal(runtime.capabilities.configured, "yes");
  assert.equal(runtime.capabilities.projected, "yes");
  assert.equal(runtime.capabilities.discoverable, "not-probed");
  assert.equal(runtime.capabilities.invocation, "not-run");
  assert.equal(runtime.capabilities.produced, "not-run");
  assert.equal(runtime.evidence.skillTarget.canonicalPresent, true);
});

test("inspectSkillHealth separates configured and discoverable from unverified invocation", async () => {
  const { aiosPath, homePath } = await makeAios();
  await fs.writeFile(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [{
        name: "Probe Agent",
        detect: ".probe-agent",
        bridge: null,
        command: process.execPath,
        skills: { mode: "symlink", dir: ".agents/skills" }
      }]
    })
  );
  await fs.mkdir(path.join(homePath, ".probe-agent"), { recursive: true });
  await installSymlinkSkills({ aiosPath, targetDir: path.join(homePath, ".agents", "skills") });

  const report = await inspectSkillHealth({
    aiosPath,
    homePath,
    detection: { env: { PATH: "" } }
  });
  const runtime = report.runtimes.find((entry) => entry.name === "Probe Agent");

  assert.deepEqual(runtime.capabilities, {
    configured: "yes",
    projected: "yes",
    discoverable: "not-probed",
    binary: "available",
    invocation: "not-run",
    produced: "not-run"
  });
  assert.equal(runtime.installed, true);
  assert.equal(report.healthy, true);
});

test("inspectSkillHealth keeps filesystem projection distinct from host discovery", async () => {
  const { aiosPath, homePath } = await makeAios();
  await installSymlinkSkills({
    aiosPath,
    targetDir: path.join(homePath, ".claude", "skills")
  });

  const report = await inspectSkillHealth({
    aiosPath,
    homePath,
    detection: {
      env: {
        PATH: ""
      }
    }
  });
  const runtime = report.runtimes.find((entry) => entry.name === "Claude Code");

  assert.equal(runtime.capabilities.configured, "yes");
  assert.equal(runtime.capabilities.projected, "yes");
  assert.equal(runtime.capabilities.discoverable, "not-probed");
  assert.doesNotMatch(JSON.stringify(report), /path-ready/);
});

test("inspectSkillHealth keeps warning-only foreign extras path-ready", async () => {
  const { aiosPath, homePath } = await makeAios();
  const targetDir = path.join(homePath, ".agents", "skills");
  await installSymlinkSkills({ aiosPath, targetDir });
  await fs.symlink(path.join(aiosPath, "skills", "today"), path.join(targetDir, "vendor-today"), "dir");
  await fs.mkdir(path.join(homePath, ".probe-agent"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [{
        name: "Probe Agent",
        detect: ".probe-agent",
        bridge: null,
        command: "node",
        skills: { mode: "symlink", dir: ".agents/skills" }
      }]
    })
  );

  const report = await inspectSkillHealth({ aiosPath, homePath });
  const runtime = report.runtimes.find((entry) => entry.name === "Probe Agent");

  assert.equal(runtime.capabilities.projected, "yes");
  assert.equal(runtime.capabilities.discoverable, "not-probed");
  assert.equal(runtime.evidence.skillTarget.canonicalPresent, true);
  assert.equal(runtime.evidence.skillTarget.complete, false);
});

test("inspectSkillHealth keeps missing, broken, and same-name foreign canonical entries not discoverable", async () => {
  const cases = [
    {
      name: "missing",
      prepare: async ({ aiosPath, targetDir }) => {
        await fs.mkdir(targetDir, { recursive: true });
      }
    },
    {
      name: "broken",
      prepare: async ({ aiosPath, targetDir }) => {
        await installSymlinkSkills({ aiosPath, targetDir });
        await fs.rm(path.join(targetDir, "today"), { recursive: true, force: true });
        await fs.symlink(path.join(targetDir, "missing-today"), path.join(targetDir, "today"), "dir");
      }
    },
    {
      name: "same-name foreign",
      prepare: async ({ aiosPath, homePath, targetDir }) => {
        await installSymlinkSkills({ aiosPath, targetDir });
        await fs.rm(path.join(targetDir, "today"), { recursive: true, force: true });
        const foreignSource = path.join(homePath, "foreign-skills", "today");
        await fs.mkdir(foreignSource, { recursive: true });
        await fs.symlink(foreignSource, path.join(targetDir, "today"), "dir");
      }
    }
  ];

  for (const current of cases) {
    const { aiosPath, homePath } = await makeAios();
    const targetDir = path.join(homePath, ".agents", "skills");
    await current.prepare({ aiosPath, homePath, targetDir });
    await installProbeAgent({ aiosPath, homePath });

    const report = await inspectSkillHealth({ aiosPath, homePath });
    const target = report.targets.find((entry) => entry.dir === ".agents/skills");
    const runtime = report.runtimes.find((entry) => entry.name === "Probe Agent");

    assert.equal(target.canonicalPresent, false, current.name);
    assert.equal(target.complete, false, current.name);
    assert.equal(runtime.capabilities.configured, "yes", current.name);
    assert.equal(runtime.capabilities.projected, "no", current.name);
    assert.equal(runtime.capabilities.discoverable, "not-probed", current.name);
    assert.equal(runtime.capabilities.invocation, "not-run", current.name);
    assert.equal(runtime.evidence.skillTarget.canonicalPresent, false, current.name);
  }
});

test("inspectSkillHealth keeps configured paths separate from runtime installation", async () => {
  const { aiosPath, homePath } = await makeAios();
  await fs.writeFile(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [{
        name: "Uninstalled Probe Agent",
        detect: ".not-installed",
        bridge: null,
        skills: { mode: "symlink", dir: ".agents/skills" }
      }]
    })
  );
  await installSymlinkSkills({ aiosPath, targetDir: path.join(homePath, ".agents", "skills") });

  const report = await inspectSkillHealth({
    aiosPath,
    homePath,
    detection: { env: { PATH: "" } }
  });
  const runtime = report.runtimes.find((entry) => entry.name === "Uninstalled Probe Agent");

  assert.equal(runtime.installed, false);
  assert.equal(runtime.capabilities.configured, "yes");
  assert.equal(runtime.capabilities.projected, "yes");
  assert.equal(runtime.capabilities.discoverable, "not-probed");
  assert.equal(runtime.capabilities.binary, "not-detected");
  assert.equal(runtime.capabilities.invocation, "not-run");
  assert.equal(report.healthy, true);
});

test("inspectSkillHealth reports Kimi Code CLI and OpenCode as separate runtimes", async () => {
  const { aiosPath, homePath } = await makeAios();
  await installSymlinkSkills({
    aiosPath,
    targetDir: path.join(homePath, ".agents", "skills")
  });
  await fs.mkdir(path.join(homePath, ".kimi-code"), { recursive: true });
  await fs.mkdir(path.join(homePath, ".config", "opencode"), { recursive: true });

  const report = await inspectSkillHealth({ aiosPath, homePath });

  for (const name of ["Kimi Code CLI", "OpenCode"]) {
    const runtime = report.runtimes.find((entry) => entry.name === name);
    assert.ok(runtime, `${name} should have its own runtime row`);
    assert.equal(runtime.installed, true);
    assert.equal(runtime.capabilities.configured, "yes");
    assert.equal(runtime.capabilities.projected, "yes");
    assert.equal(runtime.capabilities.discoverable, "not-probed");
    assert.equal(runtime.capabilities.invocation, "not-run");
  }
});

test("inspectSkillHealth activates the shared target for Kimi-only and OpenCode-only installs", async () => {
  for (const detectedHome of [".kimi-code", path.join(".config", "opencode")]) {
    const { aiosPath, homePath } = await makeAios();
    await fs.mkdir(path.join(homePath, detectedHome), { recursive: true });

    const report = await inspectSkillHealth({ aiosPath, homePath });
    const shared = report.targets.find((entry) => entry.dir === ".agents/skills");

    assert.equal(shared.status, "active", detectedHome);
    assert.ok(shared.missing.length > 0, detectedHome);
    assert.equal(report.healthy, false, detectedHome);
  }
});
