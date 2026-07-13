import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverHermesConfigPaths, ensureExternalSkillsDir } from "../../packages/core/src/hermes-config.mjs";

async function writeCfg(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cfg-"));
  const p = path.join(dir, "config.yaml");
  await fs.writeFile(p, body);
  return p;
}

test("adds path to empty inline list `external_dirs: []`", async () => {
  const p = await writeCfg("model:\n  provider: openrouter\nskills:\n  external_dirs: []\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, /external_dirs:\n {4}- \/home\/user\/aios\/skills/);
});

test("can create the skills section for a legacy Hermes profile", async () => {
  const p = await writeCfg("model:\n  provider: openai-codex\n");
  const res = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/filo/aios/skills",
    createMissing: true
  });
  assert.equal(res.action, "added-section");
  assert.match(await fs.readFile(p, "utf8"), /skills:\n  external_dirs:\n    - \/Users\/filo\/aios\/skills/);
});

test("discovers the root Hermes config and existing profile configs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-hermes-home-"));
  await fs.mkdir(path.join(root, ".hermes", "profiles", "legacy"), { recursive: true });
  await fs.writeFile(path.join(root, ".hermes", "config.yaml"), "model: {}\n");
  await fs.writeFile(path.join(root, ".hermes", "profiles", "legacy", "config.yaml"), "model: {}\n");
  const paths = await discoverHermesConfigPaths(root);
  assert.deepEqual(paths, [
    path.join(root, ".hermes", "config.yaml"),
    path.join(root, ".hermes", "profiles", "legacy", "config.yaml")
  ]);
});

test("idempotent when path already present", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /home/user/aios/skills\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "already-present");
});

test("appends to an existing block list", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /other/skills\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, /- \/other\/skills\n {4}- \/home\/user\/aios\/skills/);
});

test("preserves Hermes profiles that indent external_dirs list items by two spaces", async () => {
  const existing = "/Users/filo/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    "  - /other/skills",
    ""
  ].join("\n"));

  const firstInstall = await ensureExternalSkillsDir({ configPath: p, skillsPath: existing });
  assert.equal(firstInstall.action, "added");
  assert.equal(
    await fs.readFile(p, "utf8"),
    [
      "skills:",
      "  external_dirs:",
      "  - /other/skills",
      `  - ${existing}`,
      ""
    ].join("\n")
  );

  const secondInstall = await ensureExternalSkillsDir({ configPath: p, skillsPath: existing });
  assert.equal(secondInstall.action, "already-present");
});

test("normalizes scalar external_dirs without mutating dry-runs or repeat installs", async () => {
  const body = "model:\n  provider: openrouter\nskills:\n  external_dirs: /Users/filo/aios/skills\n  enabled: true\nlogging:\n  level: info\n";
  const p = await writeCfg(body);
  const expected = "model:\n  provider: openrouter\nskills:\n  external_dirs:\n    - /Users/filo/aios/skills\n  enabled: true\nlogging:\n  level: info\n";

  const dryRun = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/filo/aios/skills",
    dryRun: true,
  });
  assert.equal(dryRun.action, "would-add");
  assert.equal(await fs.readFile(p, "utf8"), body);

  const firstInstall = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/filo/aios/skills",
  });
  assert.equal(firstInstall.action, "added");
  assert.equal(await fs.readFile(p, "utf8"), expected);

  const secondInstall = await ensureExternalSkillsDir({
    configPath: p,
    skillsPath: "/Users/filo/aios/skills",
  });
  assert.equal(secondInstall.action, "already-present");
  assert.equal(await fs.readFile(p, "utf8"), expected);
});

test("normalizes scalar external_dirs paths that contain spaces", async () => {
  const skillsPath = "/Users/filo/My AIOS/skills";
  const p = await writeCfg(`skills:\n  external_dirs: ${skillsPath}\n`);
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath });
  assert.equal(res.action, "added");
  assert.match(await fs.readFile(p, "utf8"), /- \/Users\/filo\/My AIOS\/skills/);
});

test("prunes missing DotAIOS temporary external dirs while preserving the canonical path", async () => {
  const stale = path.join(os.tmpdir(), "dotaios-setup-dead", "aios", "skills");
  const canonical = "/Users/filo/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    `    - ${canonical}`,
    `    - ${stale}`,
    "  template_vars: true",
    ""
  ].join("\n"));

  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });
  assert.equal(res.action, "pruned-stale");
  const out = await fs.readFile(p, "utf8");
  assert.match(out, new RegExp(`- ${canonical.replaceAll("/", "\\/")}`));
  assert.doesNotMatch(out, /dotaios-setup-dead/);
});

test("keeps a live DotAIOS-looking temporary external dir", async () => {
  const live = path.join(os.tmpdir(), "dotaios-live", "aios", "skills");
  await fs.mkdir(live, { recursive: true });
  const canonical = "/Users/filo/aios/skills";
  const p = await writeCfg([
    "skills:",
    "  external_dirs:",
    `    - ${live}`,
    ""
  ].join("\n"));

  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: canonical });
  assert.equal(res.action, "added");
  assert.match(await fs.readFile(p, "utf8"), new RegExp(live.replaceAll("/", "\\/")));
  await fs.rm(path.join(os.tmpdir(), "dotaios-live"), { recursive: true, force: true });
});

test("substring path is NOT a false already-present", async () => {
  const p = await writeCfg("skills:\n  external_dirs:\n    - /home/user/aios/skills-backup\n");
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "added");
});

test("fail-closed: no skills section → reports manual, file unchanged", async () => {
  const body = "model:\n  provider: openrouter\n";
  const p = await writeCfg(body);
  const res = await ensureExternalSkillsDir({ configPath: p, skillsPath: "/home/user/aios/skills" });
  assert.equal(res.action, "manual");
  assert.equal(await fs.readFile(p, "utf8"), body);
});
