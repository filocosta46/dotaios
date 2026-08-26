import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  isRecognizedOfficialSkillOverlay,
  loadOfficialSkillPackage,
  materializeOfficialCandidateBytes,
  officialSkillNames
} from "../../packages/core/src/official-skills.mjs";
import {
  applyManagedBridgeFile,
  bridgeContent,
  bridgePath,
  loadAgentRegistry,
  previewManagedBridgeFile
} from "../../packages/core/src/bridges.mjs";
import { createManagedSkillStore } from "../../packages/core/src/managed-skill-store.mjs";
import { snapshotTree } from "../helpers/managed-skills.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
).version;
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const predecessorFixture = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "tests", "fixtures", "official-skills-predecessor.json"),
  "utf8"
));

test("the predecessor fixture reconstructs the exact tagged Git skills tree", () => {
  assert.deepEqual(predecessorFixture.origins, [
    {
      release: "2.0.9",
      commit: "551f5a0907f85136060e221755e0f1291b918bfc",
      skills_tree: "7c51d7ccd0a3e49c7ae2770c42b2f32c20b032ef"
    },
    {
      release: "2.0.10",
      commit: "3334282a2caaa2a3cca9f9d57443714265f6bcff",
      skills_tree: "7c51d7ccd0a3e49c7ae2770c42b2f32c20b032ef"
    }
  ]);

  const filesBySkill = new Map();
  for (const file of predecessorFixture.files) {
    const coordinates = file.path.split("/");
    assert.equal(coordinates.length, 2, file.path);
    const bytes = Buffer.from(predecessorFixture.blobs[file.sha256], "base64");
    assert.equal(sha256(bytes), file.sha256, file.path);
    const rows = filesBySkill.get(coordinates[0]) || [];
    rows.push({
      mode: `100${file.mode.toString(8)}`,
      name: coordinates[1],
      objectId: gitObjectId("blob", bytes)
    });
    filesBySkill.set(coordinates[0], rows);
  }
  assert.deepEqual([...filesBySkill.keys()].sort(compareUtf8), officialSkillNames());

  const skillTrees = [...filesBySkill.entries()].map(([name, rows]) => ({
    mode: "40000",
    name,
    objectId: gitTreeObjectId(rows)
  }));
  const reconstructed = gitTreeObjectId(skillTrees);
  for (const origin of predecessorFixture.origins) {
    assert.equal(reconstructed, origin.skills_tree, origin.release);
  }
});

test("the official manifest owns every packed skill file and materializes exact-candidate guidance", async () => {
  const official = await loadOfficialSkillPackage();
  const packedSkillNames = fs.readdirSync(path.join(repoRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareUtf8);

  assert.equal(official.format, "dotaios-official-skill-package/v1");
  assert.equal(official.candidate_invocation, `npx dotaios@${packageVersion}`);
  assert.deepEqual(officialSkillNames(), packedSkillNames);
  assert.deepEqual(official.skills.map(({ name }) => name), packedSkillNames);

  for (const skill of official.skills) {
    const packedRoot = path.join(repoRoot, "skills", skill.name);
    const packedFiles = fs.readdirSync(packedRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort(compareUtf8);
    assert.deepEqual(skill.files.map(({ path: relative }) => relative), packedFiles);

    for (const file of skill.files) {
      const packedPath = path.join(packedRoot, file.path);
      const packedBytes = fs.readFileSync(packedPath);
      assert.equal(sha256(packedBytes), file.packed_sha256, `${skill.name}/${file.path}`);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(packedPath).mode & 0o7777, file.mode, `${skill.name}/${file.path} mode`);
      }
      assert.equal(file.predecessors.length, 2);
      assert.deepEqual(file.predecessors.map(({ release }) => release), ["2.0.9", "2.0.10"]);
    }

    const instructions = skill.files.find(({ path: relative }) => relative === "SKILL.md");
    const text = instructions.installed_bytes.toString("utf8");
    assert.doesNotMatch(text, /<exact-candidate-version>/);
    assert.doesNotMatch(text, /\bnpx\s+dotaios(?!@)/);
    for (const match of text.matchAll(/\bnpx\s+dotaios@([^\s`"'\\]+)/g)) {
      assert.equal(match[1], packageVersion, `${skill.name} contains a non-candidate invocation`);
    }
  }
});

test("candidate materialization binds every official runnable instruction to the requested package version", async () => {
  const official = await loadOfficialSkillPackage({ candidateVersion: "9.8.7" });
  assert.equal(official.candidate_invocation, "npx dotaios@9.8.7");
  for (const skill of official.skills) {
    const instructions = skill.files.find(({ path: relative }) => relative === "SKILL.md");
    const text = instructions.installed_bytes.toString("utf8");
    assert.doesNotMatch(text, /<exact-candidate-version>/);
    assert.doesNotMatch(text, /\bnpx\s+dotaios(?!@9\.8\.7\b)/);
  }
});

test("candidate materialization rejects bytes that would change beyond exact token substitution", () => {
  const render = { kind: "exact-candidate-version/v1", token_count: 1 };
  assert.throws(
    () => materializeOfficialCandidateBytes(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("npx dotaios@<exact-candidate-version> brief\n")
      ]),
      render,
      "9.8.7"
    ),
    (error) => error?.code === "DOTAIOS_OFFICIAL_SKILL_PACKAGE_INVALID"
  );
  assert.throws(
    () => materializeOfficialCandidateBytes(
      Buffer.from("npx dotaios@<exact-candidate-version> brief\n"),
      { ...render, token_count: 2 },
      "9.8.7"
    ),
    (error) => error?.code === "DOTAIOS_OFFICIAL_SKILL_PACKAGE_INVALID"
  );
});

test("official package loader rejects drifted or unsafe source inventory", async (t) => {
  const cases = [
    ["extra root", (packageRoot) => {
      fs.mkdirSync(path.join(packageRoot, "skills", "foreign"));
    }],
    ["missing root", (packageRoot) => {
      fs.rmSync(path.join(packageRoot, "skills", "audit"), { recursive: true });
    }],
    ["extra leaf", (packageRoot) => {
      fs.writeFileSync(path.join(packageRoot, "skills", "audit", "notes.md"), "extra\n");
    }],
    ["missing leaf", (packageRoot) => {
      fs.unlinkSync(path.join(packageRoot, "skills", "audit", "LICENSE"));
    }],
    ["root symlink", (packageRoot) => {
      const source = path.join(packageRoot, "skills", "audit");
      const real = path.join(packageRoot, "audit-real");
      fs.renameSync(source, real);
      fs.symlinkSync("../audit-real", source, "dir");
    }],
    ["leaf symlink", (packageRoot) => {
      const leaf = path.join(packageRoot, "skills", "audit", "SKILL.md");
      fs.unlinkSync(leaf);
      fs.symlinkSync("LICENSE", leaf);
    }],
    ["leaf hardlink", (packageRoot) => {
      const leaf = path.join(packageRoot, "skills", "audit", "SKILL.md");
      const external = path.join(packageRoot, "audit-skill-copy");
      fs.copyFileSync(leaf, external);
      fs.unlinkSync(leaf);
      fs.linkSync(external, leaf);
    }],
    ["root mode drift", (packageRoot) => {
      fs.chmodSync(path.join(packageRoot, "skills", "audit"), 0o2755);
    }],
    ["leaf mode drift", (packageRoot) => {
      fs.chmodSync(path.join(packageRoot, "skills", "audit", "SKILL.md"), 0o4644);
    }],
    ["special leaf", (packageRoot) => {
      const leaf = path.join(packageRoot, "skills", "audit", "SKILL.md");
      fs.unlinkSync(leaf);
      const created = spawnSync("mkfifo", [leaf], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
    }],
    ["digest drift", (packageRoot) => {
      fs.appendFileSync(path.join(packageRoot, "skills", "audit", "SKILL.md"), "drift\n");
    }]
  ];
  const posixOnly = new Set([
    "root symlink",
    "leaf symlink",
    "root mode drift",
    "leaf mode drift",
    "special leaf"
  ]);

  for (const [label, mutate] of cases) {
    if (process.platform === "win32" && posixOnly.has(label)) {
      await t.test(label, { skip: "POSIX filesystem semantics" }, () => {});
      continue;
    }
    await t.test(label, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-source-invalid-"));
      const packageRoot = path.join(root, "package");
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.mkdirSync(packageRoot);
      fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
      fs.cpSync(path.join(repoRoot, "skills"), path.join(packageRoot, "skills"), { recursive: true });
      mutate(packageRoot);
      await assert.rejects(
        loadOfficialSkillPackage({ packageRoot }),
        (error) => error?.code === "DOTAIOS_OFFICIAL_SKILL_PACKAGE_INVALID"
      );
    });
  }
});

test("generated-overlay recognition accepts only the bounded interview prompt grammar", () => {
  const legacy = Buffer.from(renderGeneratedPrompt("legacy"));
  const versioned = Buffer.from(renderGeneratedPrompt(
    "versioned",
    "This file is generated by DotAIOS. Re-run `npx dotaios@9.8.7 interview` to refresh it."
  ));
  const unavailable = Buffer.from(renderGeneratedPrompt(
    "unavailable",
    "This file is generated by DotAIOS. The candidate version was unavailable, so it contains no runnable refresh command."
  ));
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", legacy), true);
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", versioned), true);
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", unavailable), true);
  assert.equal(
    isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), legacy])),
    false
  );
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", Buffer.from([0xff])), false);
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", Buffer.concat([legacy, Buffer.from("extra\n")])), false);
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "other.md", legacy), false);
});

test("fresh init derives official bytes, registry, and catalogs from the manifest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-init-"));
  const target = path.join(root, "aios");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--path", target], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const official = await loadOfficialSkillPackage();
  const expectedNames = officialSkillNames();
  const registry = JSON.parse(fs.readFileSync(path.join(target, "skills", "_registry.json"), "utf8"));
  assert.deepEqual(registry.skills, expectedNames);

  for (const skill of official.skills) {
    for (const file of skill.files) {
      assert.deepEqual(
        fs.readFileSync(path.join(target, "skills", skill.name, file.path)),
        file.installed_bytes,
        `${skill.name}/${file.path}`
      );
    }
  }

  const index = fs.readFileSync(path.join(target, "skills", "INDEX.md"), "utf8");
  const resolver = fs.readFileSync(path.join(target, "skills", "RESOLVER.md"), "utf8");
  for (const name of expectedNames) {
    assert.match(index, new RegExp(`skills/${escapeRegExp(name)}/SKILL\\.md`));
    assert.match(resolver, new RegExp(`skills/${escapeRegExp(name)}/SKILL\\.md`));
  }
});

test("fresh init enforces manifest modes under a restrictive process umask", async (t) => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-init-mode-"));
  const target = path.join(root, "aios");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initModule = new URL("../../packages/cli/src/commands/init.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    process.umask(0o077);
    const { initCommand } = await import(${JSON.stringify(initModule)});
    await initCommand(["--yes", "--path", ${JSON.stringify(target)}]);
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const official = await loadOfficialSkillPackage();
  for (const skill of official.skills) {
    const installedRoot = path.join(target, "skills", skill.name);
    assert.equal(fs.statSync(installedRoot).mode & 0o7777, skill.mode, `${skill.name} root mode`);
    for (const file of skill.files) {
      assert.equal(
        fs.statSync(path.join(installedRoot, file.path)).mode & 0o7777,
        file.mode,
        `${skill.name}/${file.path} mode`
      );
    }
  }
});

test("init --force refuses unrecognized same-name official bytes before any scaffold mutation", async (t) => {
  for (const [label, prepare] of [
    ["personal same-name skill", async (target) => {
      const root = path.join(target, "skills", "audit");
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "SKILL.md"), [
        "---",
        "name: personal-audit",
        "description: Personal bytes must not become official by catalog assertion.",
        "---",
        "# Personal audit",
        ""
      ].join("\n"));
    }],
    ["modified candidate leaf", async (target) => {
      const official = await loadOfficialSkillPackage();
      writeCandidateSkills(target, official);
      fs.appendFileSync(path.join(target, "skills", "audit", "SKILL.md"), "\nlocal edit\n");
    }]
  ]) {
    await t.test(label, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-init-conflict-"));
      const target = path.join(root, "aios");
      fs.mkdirSync(target);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      await prepare(target);
      const before = snapshotTree(target);

      const result = spawnSync(process.execPath, [cli, "init", "--yes", "--force", "--path", target], {
        encoding: "utf8"
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Official skill/);
      assert.deepEqual(snapshotTree(target), before);
      assert.equal(fs.existsSync(path.join(target, "skills", "INDEX.md")), false);
      assert.equal(fs.existsSync(path.join(target, "skills", "RESOLVER.md")), false);
    });
  }
});

test("init --force retains unrelated personal skills in every derived catalog", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-init-personal-"));
  const target = path.join(root, "aios");
  const personalRoot = path.join(target, "skills", "personal-workflow");
  fs.mkdirSync(personalRoot, { recursive: true });
  fs.writeFileSync(path.join(personalRoot, "SKILL.md"), [
    "---",
    "name: personal-workflow",
    "description: Personal routing survives forced scaffold recovery.",
    "triggers: keep my workflow",
    "---",
    "# Personal workflow",
    ""
  ].join("\n"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [cli, "init", "--yes", "--force", "--path", target], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(target, "skills", "_registry.json"), "utf8"));
  assert.deepEqual(registry.skills, [...officialSkillNames(), "personal-workflow"].sort(compareUtf8));
  for (const catalog of ["INDEX.md", "RESOLVER.md"]) {
    assert.match(
      fs.readFileSync(path.join(target, "skills", catalog), "utf8"),
      /skills\/personal-workflow\/SKILL\.md/
    );
  }
});

test("one official-batch transaction installs every missing official skill before publishing catalogs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-batch-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const checkpoints = [];
  const store = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: { checkpoint: async (name) => checkpoints.push(name) }
  });
  const preview = await store.previewOfficialBatch();
  assert.equal(preview.format, "dotaios-official-skill-batch-proof/v1");
  assert.equal(preview.conflicts.length, 0);
  assert.deepEqual(preview.targets.map(({ classification }) => classification), (
    officialSkillNames().map(() => "missing-official")
  ));

  const result = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.repaired, officialSkillNames());

  const official = await loadOfficialSkillPackage();
  for (const skill of official.skills) {
    for (const file of skill.files) {
      assert.deepEqual(
        fs.readFileSync(path.join(aiosPath, "skills", skill.name, file.path)),
        file.installed_bytes
      );
    }
  }
  assert.ok(checkpoints.indexOf("official_batch_verified") >= 0);
  assert.ok(checkpoints.indexOf("official_batch_verified") < checkpoints.indexOf("portable_inventory_published"));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(aiosPath, "skills", "_registry.json"), "utf8")).skills,
    officialSkillNames()
  );
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("official-batch repairs stale catalogs when every official root is already current", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-catalog-only-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const official = await loadOfficialSkillPackage();
  writeCandidateSkills(aiosPath, official);
  fs.writeFileSync(path.join(aiosPath, "skills", "_registry.json"), `${JSON.stringify({
    format: "dotaios-skill-install-inventory/v2",
    skills: ["audit"],
    managed: [],
    plugins: [{ name: "legacy", path: root }]
  }, null, 2)}\n`);
  const pluginPath = path.join(aiosPath, "plugins", "legacy");
  fs.mkdirSync(pluginPath, { recursive: true });
  fs.writeFileSync(path.join(pluginPath, "plugin.json"), "legacy plugin bytes\n");
  const pluginBefore = snapshotTree(pluginPath);
  fs.writeFileSync(path.join(aiosPath, "skills", "INDEX.md"), "stale index\n");
  fs.writeFileSync(path.join(aiosPath, "skills", "RESOLVER.md"), "stale resolver\n");

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  assert.ok(preview.targets.every(({ classification }) => classification === "candidate-official"));
  assert.equal(preview.effects.publish_catalogs, true);
  const result = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.repaired, []);
  assert.equal(result.catalogs_published, true);
  const registry = JSON.parse(fs.readFileSync(path.join(aiosPath, "skills", "_registry.json"), "utf8"));
  assert.deepEqual(registry.skills, officialSkillNames());
  assert.deepEqual(registry.plugins, []);
  assert.equal(JSON.stringify(registry).includes(root), false);
  assert.deepEqual(snapshotTree(pluginPath), pluginBefore);
});

test("root-only repair preserves already-current catalog bytes and inodes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-root-only-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aiosPath], {
    encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.unlinkSync(path.join(aiosPath, "skills", "closeday", "LICENSE"));

  const artifacts = new Map(["_registry.json", "INDEX.md", "RESOLVER.md"].map((name) => {
    const destination = path.join(aiosPath, "skills", name);
    const stats = fs.statSync(destination, { bigint: true });
    return [name, { bytes: fs.readFileSync(destination), dev: stats.dev, ino: stats.ino }];
  }));
  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.targets.find(({ name }) => name === "closeday").action, "repair");
  assert.equal(preview.effects.publish_catalogs, false);

  const result = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.repaired, ["closeday"]);
  assert.equal(result.catalogs_published, false);
  for (const [name, expected] of artifacts) {
    const destination = path.join(aiosPath, "skills", name);
    const stats = fs.statSync(destination, { bigint: true });
    assert.deepEqual(fs.readFileSync(destination), expected.bytes, `${name} bytes`);
    assert.equal(stats.dev, expected.dev, `${name} device`);
    assert.equal(stats.ino, expected.ino, `${name} inode`);
  }
});

for (const origin of predecessorFixture.origins) {
  test(`official-batch upgrades the real ${origin.release} skill bytes and preserves generated personalization`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-official-${origin.release}-`));
    const aiosPath = path.join(root, "aios");
    const homePath = path.join(root, "home");
    fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
    fs.mkdirSync(homePath);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writePredecessorSkills(aiosPath);
    fs.mkdirSync(path.join(aiosPath, "skills", "personal-workflow"));
    fs.writeFileSync(path.join(aiosPath, "skills", "personal-workflow", "SKILL.md"), [
      "---",
      "name: personal-workflow",
      "description: A personal workflow outside the official manifest.",
      "---",
      "# Personal",
      ""
    ].join("\n"));
    const promptPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
    const promptBytes = Buffer.from(renderGeneratedPrompt(origin.release));
    fs.writeFileSync(promptPath, promptBytes, { mode: 0o644 });

    const store = createManagedSkillStore({ aiosPath, homePath });
    const preview = await store.previewOfficialBatch();
    assert.equal(preview.conflicts.length, 0);
    assert.ok(preview.targets.some(({ classification }) => classification === "accepted-official-predecessor"));
    assert.ok(preview.targets.every(({ classification }) => [
      "accepted-official-predecessor",
      "candidate-official"
    ].includes(classification)));
    const result = await store.applyOfficialBatch({
      operation_id: preview.operation_id,
      plan_fingerprint: preview.plan_fingerprint
    });

    assert.equal(result.status, "verified");
    assert.deepEqual(fs.readFileSync(promptPath), promptBytes);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(promptPath).mode & 0o7777, 0o644);
    }
    const official = await loadOfficialSkillPackage();
    for (const skill of official.skills) {
      for (const file of skill.files) {
        assert.deepEqual(
          fs.readFileSync(path.join(aiosPath, "skills", skill.name, file.path)),
          file.installed_bytes
        );
      }
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(aiosPath, "skills", "_registry.json"), "utf8")).skills,
      [...officialSkillNames(), "personal-workflow"].sort(compareUtf8)
    );
    for (const catalog of ["INDEX.md", "RESOLVER.md"]) {
      assert.match(
        fs.readFileSync(path.join(aiosPath, "skills", catalog), "utf8"),
        /skills\/personal-workflow\/SKILL\.md/,
        `${catalog} retains personal routing`
      );
    }
  });
}

test("official preview composes desired catalogs into the exact skills-first bridge bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-bridge-composition-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writePredecessorSkills(aiosPath);
  const personalSkill = path.join(aiosPath, "skills", "personal-workflow");
  fs.mkdirSync(personalSkill);
  fs.writeFileSync(path.join(personalSkill, "SKILL.md"), [
    "---",
    "name: personal-workflow",
    "description: A personal workflow outside the official manifest.",
    "---",
    "# Personal",
    ""
  ].join("\n"));
  const promptPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
  const promptBytes = Buffer.from(renderGeneratedPrompt("2.0.10"));
  fs.writeFileSync(promptPath, promptBytes);
  fs.writeFileSync(path.join(aiosPath, "skills", "INDEX.md"), "# stale index sentinel\n");
  fs.writeFileSync(path.join(aiosPath, "skills", "RESOLVER.md"), "# stale resolver sentinel\n");

  const codex = (await loadAgentRegistry(aiosPath)).find(({ name }) => name === "Codex");
  const destination = bridgePath(homePath, codex);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    await bridgeContent(codex, aiosPath, {
      skillsFirst: true,
      cli: `npx dotaios@${packageVersion}`
    })
  );

  const store = createManagedSkillStore({ aiosPath, homePath });
  const composition = await store.previewOfficialBatchComposition();
  const publicPreview = await store.previewOfficialBatch();
  assert.deepEqual(composition.proof, publicPreview);
  assert.equal(JSON.stringify(composition), JSON.stringify({ proof: publicPreview }));
  assert.doesNotMatch(JSON.stringify(publicPreview), /indexText|resolverText|stale .* sentinel/i);
  assert.ok(composition.skillsCatalog);
  assert.doesNotMatch(composition.skillsCatalog.indexText, /stale index sentinel/i);
  assert.doesNotMatch(composition.skillsCatalog.resolverText, /stale resolver sentinel/i);
  assert.match(composition.skillsCatalog.indexText, /skills\/personal-workflow\/SKILL\.md/);
  assert.match(composition.skillsCatalog.resolverText, /skills\/personal-workflow\/SKILL\.md/);
  assert.equal(
    sha256(Buffer.from(composition.skillsCatalog.indexText, "utf8")),
    composition.proof.desired_catalogs.index_sha256
  );
  assert.equal(
    sha256(Buffer.from(composition.skillsCatalog.resolverText, "utf8")),
    composition.proof.desired_catalogs.resolver_sha256
  );

  const generated = await bridgeContent(codex, aiosPath, {
    skillsFirst: true,
    skillsCatalog: composition.skillsCatalog,
    cli: composition.proof.candidate_invocation
  });
  const bridgePreview = await previewManagedBridgeFile(destination, generated, {
    refreshOnly: true,
    boundaryRoot: homePath
  });
  assert.equal(bridgePreview.status, "ready");

  const officialResult = await store.applyOfficialBatch({
    operationId: composition.proof.operation_id,
    planFingerprint: composition.proof.plan_fingerprint
  });
  assert.equal(officialResult.status, "verified");
  assert.deepEqual(fs.readFileSync(promptPath), promptBytes);

  const generatedFromPublishedCatalogs = await bridgeContent(codex, aiosPath, {
    skillsFirst: true,
    cli: composition.proof.candidate_invocation
  });
  assert.equal(generatedFromPublishedCatalogs, generated);
  const bridgeResult = await applyManagedBridgeFile(destination, generatedFromPublishedCatalogs, {
    refreshOnly: true,
    expectedFingerprint: bridgePreview.fingerprint,
    boundaryRoot: homePath
  });
  assert.equal(bridgeResult.action, "updated");
  assert.equal(sha256(fs.readFileSync(destination)), bridgePreview.next_fingerprint);

  fs.writeFileSync(path.join(aiosPath, "skills", "audit", "personal.txt"), "personal\n");
  const blockedComposition = await store.previewOfficialBatchComposition();
  assert.ok(blockedComposition.proof.conflicts.length > 0);
  assert.equal(blockedComposition.skillsCatalog, null);
  assert.equal(JSON.stringify(blockedComposition), JSON.stringify({ proof: blockedComposition.proof }));
});

const conflictCases = [
  ["unknown extra file", (aiosPath) => {
    fs.writeFileSync(path.join(aiosPath, "skills", "audit", "notes.md"), "personal\n");
  }],
  ["unknown extra directory", (aiosPath) => {
    const directory = path.join(aiosPath, "skills", "audit", "assets");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "personal.txt"), "personal\n");
  }],
  ["modified official instructions", (aiosPath) => {
    fs.appendFileSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), "\nPersonal edit.\n");
  }],
  ["modified official license", (aiosPath) => {
    fs.appendFileSync(path.join(aiosPath, "skills", "audit", "LICENSE"), "\nmodified\n");
  }],
  ["official leaf symlink", (aiosPath) => {
    const skill = path.join(aiosPath, "skills", "audit");
    fs.unlinkSync(path.join(skill, "SKILL.md"));
    fs.symlinkSync("LICENSE", path.join(skill, "SKILL.md"));
  }],
  ["official hardlink", (aiosPath) => {
    const skill = path.join(aiosPath, "skills", "audit");
    fs.unlinkSync(path.join(skill, "SKILL.md"));
    fs.linkSync(path.join(skill, "LICENSE"), path.join(skill, "SKILL.md"));
  }],
  ["executable mode drift", (aiosPath) => {
    fs.chmodSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), 0o755);
  }],
  ["restrictive mode drift", (aiosPath) => {
    fs.chmodSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), 0o600);
  }],
  ["official root mode drift", (aiosPath) => {
    fs.chmodSync(path.join(aiosPath, "skills", "audit"), 0o700);
  }],
  ["official root special-bit drift", (aiosPath) => {
    fs.chmodSync(path.join(aiosPath, "skills", "audit"), 0o2755);
  }],
  ["official leaf special-bit drift", (aiosPath) => {
    fs.chmodSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), 0o4644);
  }],
  ["official root symlink", (aiosPath) => {
    const skill = path.join(aiosPath, "skills", "audit");
    const foreign = path.join(aiosPath, "foreign-audit");
    fs.renameSync(skill, foreign);
    fs.symlinkSync(foreign, skill, "dir");
  }],
  ["official special leaf", (aiosPath) => {
    const leaf = path.join(aiosPath, "skills", "audit", "SKILL.md");
    fs.unlinkSync(leaf);
    const created = spawnSync("mkfifo", [leaf], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
  }],
  ["personal same-name directory", (aiosPath) => {
    const skill = path.join(aiosPath, "skills", "audit");
    fs.rmSync(skill, { recursive: true });
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "SKILL.md"), [
      "---",
      "name: audit",
      "description: My personal audit workflow.",
      "---",
      "# Personal audit",
      ""
    ].join("\n"));
  }],
  ["unrecognized generated overlay", (aiosPath) => {
    fs.writeFileSync(path.join(aiosPath, "skills", "plan-today", "prompt.md"), "personal prompt\n");
  }]
];

const POSIX_ONLY_CONFLICT_CASES = new Set([
  "official leaf symlink",
  "executable mode drift",
  "restrictive mode drift",
  "official root mode drift",
  "official root special-bit drift",
  "official leaf special-bit drift",
  "official root symlink",
  "official special leaf"
]);

test("official-batch fingerprints blocked roots with stable type-preserving identity", {
  skip: process.platform === "win32" ? "POSIX filesystem semantics" : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-blocked-identity-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const auditRoot = path.join(aiosPath, "skills", "audit");
  fs.chmodSync(auditRoot, 0o700);
  const store = createManagedSkillStore({ aiosPath, homePath });
  const before = await store.previewOfficialBatch();
  const beforeAudit = before.targets.find(({ name }) => name === "audit");
  const stats = fs.statSync(auditRoot, { bigint: true });

  assert.equal(beforeAudit.action, "blocked");
  assert.deepEqual(beforeAudit.current_manifest.root_identity, {
    type: "directory",
    dev: String(stats.dev),
    ino: String(stats.ino)
  });

  fs.utimesSync(auditRoot, new Date(946684800000), new Date(946684800000));
  const after = await store.previewOfficialBatch();
  assert.equal(after.plan_fingerprint, before.plan_fingerprint);

  fs.rmSync(auditRoot, { recursive: true });
  fs.writeFileSync(auditRoot, "foreign root\n");
  const beforeFile = await store.previewOfficialBatch();
  const beforeFileAudit = beforeFile.targets.find(({ name }) => name === "audit");
  const fileStats = fs.lstatSync(auditRoot, { bigint: true });

  assert.equal(beforeFileAudit.action, "blocked");
  assert.deepEqual(beforeFileAudit.current_manifest.root_identity, {
    type: "file",
    dev: String(fileStats.dev),
    ino: String(fileStats.ino)
  });

  fs.utimesSync(auditRoot, new Date(978307200000), new Date(978307200000));
  const afterFile = await store.previewOfficialBatch();
  assert.equal(afterFile.plan_fingerprint, beforeFile.plan_fingerprint);
});

test("official-batch blocks the complete foreign/conflict matrix without refreshing dependent catalogs", async (t) => {
  for (const [label, mutate] of conflictCases) {
    if (process.platform === "win32" && POSIX_ONLY_CONFLICT_CASES.has(label)) {
      await t.test(label, { skip: "POSIX filesystem semantics" }, () => {});
      continue;
    }
    await t.test(label, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-conflict-"));
      const aiosPath = path.join(root, "aios");
      const homePath = path.join(root, "home");
      fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
      fs.mkdirSync(homePath);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      writePredecessorSkills(aiosPath);
      mutate(aiosPath);
      const conflictRoot = path.join(aiosPath, "skills", label.includes("overlay") ? "plan-today" : "audit");
      const beforeConflict = snapshotTree(conflictRoot);
      const derived = {
        "_registry.json": Buffer.from('{"sentinel":"registry"}\n'),
        "INDEX.md": Buffer.from("sentinel index\n"),
        "RESOLVER.md": Buffer.from("sentinel resolver\n")
      };
      for (const [name, bytes] of Object.entries(derived)) {
        fs.writeFileSync(path.join(aiosPath, "skills", name), bytes);
      }

      const store = createManagedSkillStore({ aiosPath, homePath });
      const preview = await store.previewOfficialBatch();
      assert.ok(preview.conflicts.length > 0, label);
      if (label === "personal same-name directory") {
        assert.ok(preview.conflicts.some(({ classification }) => classification === "personal-same-name-directory"));
      }
      assert.equal(preview.desired_catalogs, null);
      const result = await store.applyOfficialBatch({
        operationId: preview.operation_id,
        planFingerprint: preview.plan_fingerprint
      });
      assert.equal(result.status, "blocked-conflict");
      assert.ok(result.repaired.includes("export-okf"), `${label}: safe targets still repair`);
      assert.deepEqual(snapshotTree(conflictRoot), beforeConflict);
      const candidate = (await loadOfficialSkillPackage()).skills.find(({ name }) => name === "export-okf");
      for (const file of candidate.files) {
        assert.deepEqual(
          fs.readFileSync(path.join(aiosPath, "skills", candidate.name, file.path)),
          file.installed_bytes,
          `${label}: ${candidate.name}/${file.path} repaired`
        );
      }
      for (const [name, bytes] of Object.entries(derived)) {
        assert.deepEqual(fs.readFileSync(path.join(aiosPath, "skills", name)), bytes, `${label}: ${name}`);
      }
    });
  }
});

test("official-batch reports hardlinked official files and overlays precisely", async (t) => {
  const cases = [
    {
      label: "declared official file",
      expectedReason: "official_file_hardlinked",
      mutate: (aiosPath) => {
        const skillPath = path.join(aiosPath, "skills", "audit", "SKILL.md");
        const externalPath = path.join(aiosPath, "audit-hardlink-source.md");
        fs.renameSync(skillPath, externalPath);
        fs.linkSync(externalPath, skillPath);
        assert.equal(fs.statSync(skillPath, { bigint: true }).nlink, 2n);
      }
    },
    {
      label: "generated overlay",
      expectedReason: "generated_overlay_unrecognized",
      mutate: (aiosPath) => {
        const externalPath = path.join(aiosPath, "prompt-hardlink-source.md");
        fs.writeFileSync(externalPath, renderGeneratedPrompt("hardlink-overlay"), { mode: 0o644 });
        const overlayPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
        fs.linkSync(externalPath, overlayPath);
        assert.equal(fs.statSync(overlayPath, { bigint: true }).nlink, 2n);
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-hardlink-reason-"));
      const aiosPath = path.join(root, "aios");
      const homePath = path.join(root, "home");
      fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
      fs.mkdirSync(homePath);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      writePredecessorSkills(aiosPath);
      scenario.mutate(aiosPath);

      const preview = await createManagedSkillStore({ aiosPath, homePath }).previewOfficialBatch();
      assert.ok(
        preview.conflicts.some(({ reason }) => reason === scenario.expectedReason),
        `${scenario.label}: ${JSON.stringify(preview.conflicts)}`
      );
    });
  }
});

test("official-batch repairs a missing file inside a recognized mixed predecessor and is idempotent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-partial-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  fs.unlinkSync(path.join(aiosPath, "skills", "audit", "LICENSE"));

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const audit = preview.targets.find(({ name }) => name === "audit");
  assert.equal(audit.action, "repair");
  assert.ok(audit.files.some(({ classification }) => classification === "missing-official"));
  const applied = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(applied.status, "verified");

  const current = await store.previewOfficialBatch();
  assert.ok(current.targets.every(({ classification }) => classification === "candidate-official"));
  const retry = await store.applyOfficialBatch({
    operationId: current.operation_id,
    planFingerprint: current.plan_fingerprint
  });
  assert.equal(retry.status, "verified");
  assert.deepEqual(retry.repaired, []);
});

test("failed conflict-batch repair rolls back roots without touching unowned concurrent catalogs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-conflict-rollback-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const skillsRoot = path.join(aiosPath, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const official = await loadOfficialSkillPackage();
  writeCandidateSkills(aiosPath, official);
  fs.writeFileSync(path.join(skillsRoot, "audit", "notes.md"), "foreign conflict\n");
  fs.unlinkSync(path.join(skillsRoot, "closeday", "LICENSE"));
  const beforeRepair = snapshotTree(path.join(skillsRoot, "closeday"));
  const artifactNames = ["_registry.json", "INDEX.md", "RESOLVER.md"];
  for (const name of artifactNames) {
    const bytes = name === "_registry.json"
      ? `${JSON.stringify({
        format: "dotaios-skill-install-inventory/v2",
        skills: [],
        managed: [],
        plugins: []
      }, null, 2)}\n`
      : `prepared ${name}\n`;
    fs.writeFileSync(path.join(skillsRoot, name), bytes);
  }

  const concurrent = new Map();
  const store = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: {
      checkpoint(name) {
        if (name !== "official_repairs_verified") return;
        for (const artifact of artifactNames) {
          const destination = path.join(skillsRoot, artifact);
          const bytes = Buffer.from(`concurrent ${artifact}\n`);
          fs.writeFileSync(destination, bytes);
          const stats = fs.statSync(destination, { bigint: true });
          concurrent.set(artifact, { bytes, dev: stats.dev, ino: stats.ino });
        }
        throw new Error("injected conflict repair failure");
      }
    }
  });
  const preview = await store.previewOfficialBatch();
  assert.ok(preview.conflicts.length > 0);
  assert.equal(preview.effects.publish_catalogs, false);
  assert.equal(preview.targets.find(({ name }) => name === "closeday").action, "repair");

  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    /injected conflict repair failure/
  );

  assert.deepEqual(snapshotTree(path.join(skillsRoot, "closeday")), beforeRepair);
  for (const [name, expected] of concurrent) {
    const destination = path.join(skillsRoot, name);
    const stats = fs.statSync(destination, { bigint: true });
    assert.deepEqual(fs.readFileSync(destination), expected.bytes, `${name} bytes`);
    assert.equal(stats.dev, expected.dev, `${name} device`);
    assert.equal(stats.ino, expected.ino, `${name} inode`);
  }
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("pre-publication failure rolls back official roots without clobbering concurrent catalogs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-prepublish-rollback-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const skillsRoot = path.join(aiosPath, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const official = await loadOfficialSkillPackage();
  writeCandidateSkills(aiosPath, official);
  fs.unlinkSync(path.join(skillsRoot, "closeday", "LICENSE"));
  const beforeRepair = snapshotTree(path.join(skillsRoot, "closeday"));
  const artifactNames = ["_registry.json", "INDEX.md", "RESOLVER.md"];
  for (const name of artifactNames) {
    const bytes = name === "_registry.json"
      ? `${JSON.stringify({
        format: "dotaios-skill-install-inventory/v2",
        skills: [],
        managed: [],
        plugins: []
      }, null, 2)}\n`
      : `prepared ${name}\n`;
    fs.writeFileSync(path.join(skillsRoot, name), bytes);
  }

  const concurrent = new Map();
  const store = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: {
      checkpoint(name) {
        if (name !== "official_batch_verified") return;
        for (const artifact of artifactNames) {
          const destination = path.join(skillsRoot, artifact);
          const bytes = Buffer.from(`concurrent ${artifact}\n`);
          fs.writeFileSync(destination, bytes);
          const stats = fs.statSync(destination, { bigint: true });
          concurrent.set(artifact, { bytes, dev: stats.dev, ino: stats.ino });
        }
        throw new Error("injected pre-publication failure");
      }
    }
  });
  const preview = await store.previewOfficialBatch();
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.effects.publish_catalogs, true);

  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    /injected pre-publication failure/
  );

  assert.deepEqual(snapshotTree(path.join(skillsRoot, "closeday")), beforeRepair);
  for (const [name, expected] of concurrent) {
    const destination = path.join(skillsRoot, name);
    const stats = fs.statSync(destination, { bigint: true });
    assert.deepEqual(fs.readFileSync(destination), expected.bytes, `${name} bytes`);
    assert.equal(stats.dev, expected.dev, `${name} device`);
    assert.equal(stats.ino, expected.ino, `${name} inode`);
  }
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("official-batch journals canonical overlay mode when Windows reports synthetic permissions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-windows-overlay-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  const promptPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
  const promptBytes = Buffer.from(renderGeneratedPrompt("windows-synthetic-mode"));
  fs.writeFileSync(promptPath, promptBytes);
  fs.chmodSync(promptPath, 0o666);

  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    Object.defineProperty(process, "platform", { value: "win32" });
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)}
    });
    const preview = await store.previewOfficialBatch();
    const applied = await store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    });
    if (applied.status !== "verified") process.exit(97);
  `], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(promptPath), promptBytes);
});

test("official-batch recovers truncated incomplete staging when Windows reports synthetic permissions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-windows-stage-recovery-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  const official = await loadOfficialSkillPackage();
  const auditInstructions = official.skills
    .find(({ name }) => name === "audit")
    .files.find(({ path: relative }) => relative === "SKILL.md")
    .installed_bytes;
  const stagedPrefix = auditInstructions.subarray(0, 32);

  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    Object.defineProperty(process, "platform", { value: "win32" });
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    let preview;
    let injected = false;
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name, detail) => {
        if (name !== "official_stage_root_identity_persisted" || injected) return;
        injected = true;
        const stagedPath = path.join(
          ${JSON.stringify(aiosPath)},
          "skills",
          ".managed-skill-store",
          "staging",
          preview.operation_id,
          detail.name
        );
        await fs.writeFile(
          path.join(stagedPath, "SKILL.md"),
          Buffer.from(${JSON.stringify(stagedPrefix.toString("base64"))}, "base64"),
          { flag: "wx", mode: 0o644 }
        );
        throw new Error("injected synthetic Windows staging interruption");
      } }
    });
    preview = await store.previewOfficialBatch();
    try {
      await store.applyOfficialBatch({
        operationId: preview.operation_id,
        planFingerprint: preview.plan_fingerprint
      });
      process.exit(96);
    } catch (error) {
      if (error.message !== "injected synthetic Windows staging interruption") throw error;
    }
    const retried = await store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    });
    if (retried.status !== "verified") process.exit(97);
    const current = await store.previewOfficialBatch();
    if (current.targets.some(({ classification }) => classification !== "candidate-official")) process.exit(98);
  `], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("official-batch revalidates candidate source after staging and rolls back without touching the destination", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-source-race-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  fs.mkdirSync(packageRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  fs.writeFileSync(
    path.join(aiosPath, "skills", "plan-today", "prompt.md"),
    renderGeneratedPrompt("source-race"),
    { mode: 0o644 }
  );
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
  fs.cpSync(path.join(repoRoot, "skills"), path.join(packageRoot, "skills"), { recursive: true });
  const before = snapshotTree(aiosPath);

  let changed = false;
  const store = createManagedSkillStore({
    aiosPath,
    homePath,
    officialPackageRoot: packageRoot,
    hooks: {
      checkpoint: async (name) => {
        if (name !== "official_batch_staged" || changed) return;
        changed = true;
        fs.appendFileSync(path.join(packageRoot, "skills", "audit", "SKILL.md"), "\nsource race\n");
      }
    }
  });
  const preview = await store.previewOfficialBatch();
  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error.code === "source_changed" && error.reason === "official_source_changed_after_staging"
  );
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("official-batch rolls back an interrupted publication even when package source later changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-source-recovery-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  fs.mkdirSync(packageRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
  fs.cpSync(path.join(repoRoot, "skills"), path.join(packageRoot, "skills"), { recursive: true });
  const before = snapshotTree(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath, officialPackageRoot: packageRoot });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      officialPackageRoot: ${JSON.stringify(packageRoot)},
      hooks: { checkpoint: async (name) => {
        if (name === "official_target_published") process.exit(95);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 95, interrupted.stderr);
  fs.appendFileSync(path.join(packageRoot, "skills", "audit", "SKILL.md"), "\nsource changed after crash\n");

  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "unsafe_source"
  );
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills", ".managed-skill-store")), false);
});

test("official-batch refuses catalog publication when an untouched official target changes after staging", async (t) => {
  for (const racePoint of [
    "official_target_published",
    "official_batch_verified",
    "portable_inventory_published"
  ]) {
    await t.test(racePoint, (t) => runUntouchedOfficialTargetRace(t, racePoint));
  }
});

async function runUntouchedOfficialTargetRace(t, racePoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-full-verify-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  const official = await loadOfficialSkillPackage();
  const audit = official.skills.find(({ name }) => name === "audit");
  for (const file of audit.files) {
    const destination = path.join(aiosPath, "skills", audit.name, file.path);
    fs.writeFileSync(destination, file.installed_bytes);
    fs.chmodSync(destination, file.mode);
  }
  const artifactPaths = ["_registry.json", "INDEX.md", "RESOLVER.md"];
  for (const [index, name] of artifactPaths.entries()) {
    const destination = path.join(aiosPath, "skills", name);
    const content = name === "_registry.json"
      ? `${JSON.stringify({
        format: "dotaios-skill-install-inventory/v2",
        skills: ["audit"],
        managed: [],
        plugins: []
      }, null, 2)}\n`
      : `catalog sentinel ${name}\n`;
    fs.writeFileSync(destination, content);
    fs.chmodSync(destination, 0o640 + index);
  }

  const beforeRepairs = new Map();
  let raced = false;
  const store = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: {
      checkpoint(name) {
        if (name === racePoint && !raced) {
          raced = true;
          fs.appendFileSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), "\nexternal race\n");
        }
      }
    }
  });
  const preview = await store.previewOfficialBatch();
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.targets.find(({ name }) => name === "audit").action, "none");
  for (const target of preview.targets.filter(({ action }) => action === "repair")) {
    beforeRepairs.set(target.name, snapshotTree(path.join(aiosPath, "skills", target.name)));
  }
  const beforeArtifacts = new Map(artifactPaths.map((name) => {
    const destination = path.join(aiosPath, "skills", name);
    return [name, {
      bytes: fs.readFileSync(destination),
      mode: fs.statSync(destination).mode & 0o777
    }];
  }));

  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "destination_changed"
  );
  for (const [name, before] of beforeRepairs) {
    assert.deepEqual(snapshotTree(path.join(aiosPath, "skills", name)), before, `${name} rollback`);
  }
  for (const [name, before] of beforeArtifacts) {
    const destination = path.join(aiosPath, "skills", name);
    assert.deepEqual(fs.readFileSync(destination), before.bytes, `${name} bytes`);
    assert.equal(fs.statSync(destination).mode & 0o777, before.mode, `${name} mode`);
  }
  assert.match(fs.readFileSync(path.join(aiosPath, "skills", "audit", "SKILL.md"), "utf8"), /external race/);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
}

test("official-batch restores every root when publication fails after the first rename", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-rollback-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);
  const before = snapshotTree(aiosPath);

  let failed = false;
  const store = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: {
      checkpoint: async (name) => {
        if (name === "official_target_published" && !failed) {
          failed = true;
          throw new Error("injected publication failure");
        }
      }
    }
  });
  const preview = await store.previewOfficialBatch();
  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    /injected publication failure/
  );
  assert.deepEqual(snapshotTree(aiosPath), before);
});

test("official-batch recovers a hard interruption after creating an empty unjournaled stage root", {
  skip: process.platform === "win32" ? "POSIX staged-root modes" : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-empty-interrupt-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const interruptedTarget = preview.targets.find(({ action }) => action === "repair").name;
  const stagedPath = path.join(
    aiosPath,
    "skills",
    ".managed-skill-store",
    "staging",
    preview.operation_id,
    interruptedTarget
  );
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name === "official_stage_root_created") process.exit(81);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });

  assert.equal(interrupted.status, 81, interrupted.stderr);
  assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(stagedPath), []);

  const recovered = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(recovered.status, "verified");
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills", ".managed-skill-store")), false);
});

test("official-batch recovers a hard interruption with a truncated declared stage file", {
  skip: process.platform === "win32" ? "POSIX staged-root modes" : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-truncated-interrupt-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const interruptedTarget = preview.targets.find(({ action }) => action === "repair").name;
  const official = await loadOfficialSkillPackage();
  const expectedInstructions = official.skills
    .find(({ name }) => name === interruptedTarget)
    .files.find(({ path: relative }) => relative === "SKILL.md")
    .installed_bytes;
  const stagedPrefix = expectedInstructions.subarray(0, 32);
  const stagedPath = path.join(
    aiosPath,
    "skills",
    ".managed-skill-store",
    "staging",
    preview.operation_id,
    interruptedTarget
  );
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name !== "official_stage_root_identity_persisted") return;
        await fs.writeFile(
          path.join(${JSON.stringify(stagedPath)}, "SKILL.md"),
          Buffer.from(${JSON.stringify(stagedPrefix.toString("base64"))}, "base64"),
          { flag: "wx", mode: 0o644 }
        );
        process.exit(82);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });

  assert.equal(interrupted.status, 82, interrupted.stderr);
  assert.equal(fs.statSync(stagedPath).mode & 0o777, 0o700);
  assert.deepEqual(fs.readFileSync(path.join(stagedPath, "SKILL.md")), stagedPrefix);

  const recovered = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(recovered.status, "verified");
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills", ".managed-skill-store")), false);
});

test("official-batch recovers a staged overlay prefix only while its live source remains proved", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-overlay-prefix-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const promptPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
  const promptBytes = Buffer.from(renderGeneratedPrompt("staged-overlay-prefix"));
  fs.writeFileSync(promptPath, promptBytes, { mode: 0o644 });
  fs.chmodSync(promptPath, 0o644);
  const promptPrefix = promptBytes.subarray(0, 32);
  const official = await loadOfficialSkillPackage();
  const planTodayFiles = official.skills
    .find(({ name }) => name === "plan-today")
    .files.map((file) => ({
      path: file.path,
      bytes: file.installed_bytes.toString("base64")
    }));

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name, detail) => {
        if (name !== "official_stage_root_identity_persisted" || detail.name !== "plan-today") return;
        const stagedPath = path.join(
          ${JSON.stringify(aiosPath)},
          "skills",
          ".managed-skill-store",
          "staging",
          ${JSON.stringify(preview.operation_id)},
          "plan-today"
        );
        for (const file of ${JSON.stringify(planTodayFiles)}) {
          await fs.writeFile(
            path.join(stagedPath, file.path),
            Buffer.from(file.bytes, "base64"),
            { flag: "wx", mode: 0o644 }
          );
        }
        await fs.writeFile(
          path.join(stagedPath, "prompt.md"),
          Buffer.from(${JSON.stringify(promptPrefix.toString("base64"))}, "base64"),
          { flag: "wx", mode: 0o644 }
        );
        process.exit(85);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });

  assert.equal(interrupted.status, 85, interrupted.stderr);
  const recovered = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(recovered.status, "verified");
  assert.deepEqual(fs.readFileSync(promptPath), promptBytes);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("official-batch rechecks live overlay authority immediately before cleanup unlink", async (t) => {
  for (const scenario of [
    { name: "incomplete 0700 stage", complete: false, exitCode: 87 },
    { name: "complete 0755 stage before manifest", complete: true, exitCode: 88 }
  ]) {
    await t.test(scenario.name, {
      skip: scenario.complete && process.platform === "win32" ? "POSIX staged-root modes" : false
    }, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-overlay-race-"));
      const aiosPath = path.join(root, "aios");
      const homePath = path.join(root, "home");
      fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
      fs.mkdirSync(homePath);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      writePredecessorSkills(aiosPath);

      const promptPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
      const promptBytes = Buffer.from(renderGeneratedPrompt(`overlay-race-old-${scenario.name}`));
      const changedPromptBytes = Buffer.from(renderGeneratedPrompt(`overlay-race-new-longer-${scenario.name}`));
      fs.writeFileSync(promptPath, promptBytes, { mode: 0o644 });
      fs.chmodSync(promptPath, 0o644);
      const stagedPromptBytes = scenario.complete ? promptBytes : promptBytes.subarray(0, 32);
      const official = await loadOfficialSkillPackage();
      const planTodayFiles = official.skills
        .find(({ name }) => name === "plan-today")
        .files.map((file) => ({
          path: file.path,
          bytes: file.installed_bytes.toString("base64")
        }));

      const store = createManagedSkillStore({ aiosPath, homePath });
      const preview = await store.previewOfficialBatch();
      const stagedPath = path.join(
        aiosPath,
        "skills",
        ".managed-skill-store",
        "staging",
        preview.operation_id,
        "plan-today"
      );
      const stagedPromptPath = path.join(stagedPath, "prompt.md");
      const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
      const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
        const store = createManagedSkillStore({
          aiosPath: ${JSON.stringify(aiosPath)},
          homePath: ${JSON.stringify(homePath)},
          hooks: { checkpoint: async (name, detail) => {
            if (name !== "official_stage_root_identity_persisted" || detail.name !== "plan-today") return;
            for (const file of ${JSON.stringify(planTodayFiles)}) {
              await fs.writeFile(
                path.join(${JSON.stringify(stagedPath)}, file.path),
                Buffer.from(file.bytes, "base64"),
                { flag: "wx", mode: 0o644 }
              );
            }
            await fs.writeFile(
              ${JSON.stringify(stagedPromptPath)},
              Buffer.from(${JSON.stringify(stagedPromptBytes.toString("base64"))}, "base64"),
              { flag: "wx", mode: 0o644 }
            );
            if (${JSON.stringify(scenario.complete)}) await fs.chmod(${JSON.stringify(stagedPath)}, 0o755);
            process.exit(${JSON.stringify(scenario.exitCode)});
          } }
        });
        await store.applyOfficialBatch({
          operationId: ${JSON.stringify(preview.operation_id)},
          planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
        });
      `], { encoding: "utf8" });
      assert.equal(interrupted.status, scenario.exitCode, interrupted.stderr);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(stagedPath).mode & 0o777, scenario.complete ? 0o755 : 0o700);
      }

      let mutated = false;
      const recoveringStore = createManagedSkillStore({
        aiosPath,
        homePath,
        hooks: {
          checkpoint: async (name, detail) => {
            if (name !== "official_cleanup_file_removed" || detail.root !== stagedPath || mutated) return;
            mutated = true;
            fs.writeFileSync(promptPath, changedPromptBytes, { mode: 0o644 });
          }
        }
      });
      await assert.rejects(
        recoveringStore.applyOfficialBatch({
          operationId: preview.operation_id,
          planFingerprint: preview.plan_fingerprint
        }),
        (error) => error?.code === "recovery_required"
          && error.reason === "official_cleanup_file_changed"
      );
      assert.equal(mutated, true);
      assert.deepEqual(fs.readFileSync(stagedPromptPath), stagedPromptBytes);
      assert.deepEqual(fs.readFileSync(promptPath), changedPromptBytes);
      const journal = JSON.parse(fs.readFileSync(
        path.join(homePath, ".dotaios", "managed-skills", "transaction.json"),
        "utf8"
      ));
      assert.equal(journal.state, "needs_attention");
    });
  }
});

test("official-batch rechecks each staged leaf immediately before unlinking it", {
  skip: process.platform === "win32" ? "POSIX staged-root modes" : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-cleanup-race-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const interruptedTarget = preview.targets.find(({ action }) => action === "repair").name;
  const official = await loadOfficialSkillPackage();
  const stagedPrefixes = official.skills
    .find(({ name }) => name === interruptedTarget)
    .files.slice(0, 2)
    .map((file) => ({
      path: file.path,
      bytes: file.installed_bytes.subarray(0, 32).toString("base64")
    }));
  assert.equal(stagedPrefixes.length, 2);
  const stagedPath = path.join(
    aiosPath,
    "skills",
    ".managed-skill-store",
    "staging",
    preview.operation_id,
    interruptedTarget
  );
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name !== "official_stage_root_identity_persisted") return;
        for (const file of ${JSON.stringify(stagedPrefixes)}) {
          await fs.writeFile(
            path.join(${JSON.stringify(stagedPath)}, file.path),
            Buffer.from(file.bytes, "base64"),
            { flag: "wx", mode: 0o644 }
          );
        }
        process.exit(86);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 86, interrupted.stderr);

  const laterPath = path.join(stagedPath, stagedPrefixes[1].path);
  let replaced = false;
  const recoveringStore = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: {
      checkpoint: async (name, detail) => {
        if (
          name !== "official_cleanup_file_removed"
          || detail.root !== stagedPath
          || detail.path !== stagedPrefixes[0].path
          || replaced
        ) return;
        replaced = true;
        fs.unlinkSync(laterPath);
        fs.writeFileSync(laterPath, "foreign replacement\n", { mode: 0o644 });
      }
    }
  });

  await assert.rejects(
    recoveringStore.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
      && error.reason === "official_cleanup_file_changed"
  );
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(laterPath, "utf8"), "foreign replacement\n");
  const journal = JSON.parse(fs.readFileSync(
    path.join(homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
});

test("official-batch preserves an undeclared entry found in interrupted 0700 staging", {
  skip: process.platform === "win32" ? "POSIX staged-root modes" : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-foreign-interrupt-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const interruptedTarget = preview.targets.find(({ action }) => action === "repair").name;
  const stagedPath = path.join(
    aiosPath,
    "skills",
    ".managed-skill-store",
    "staging",
    preview.operation_id,
    interruptedTarget
  );
  const foreignPath = path.join(stagedPath, "foreign.txt");
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name !== "official_stage_root_identity_persisted") return;
        await fs.writeFile(path.join(${JSON.stringify(stagedPath)}, "foreign.txt"), "foreign sentinel\\n", { flag: "wx", mode: 0o644 });
        process.exit(83);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });

  assert.equal(interrupted.status, 83, interrupted.stderr);
  const before = snapshotTree(stagedPath);
  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
      && error.reason === "official_cleanup_tree_changed"
  );
  assert.deepEqual(snapshotTree(stagedPath), before);
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign sentinel\n");
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), true);
});

test("official-batch rejects a forged stage identity before deleting foreign declared-name bytes", {
  skip: process.platform === "win32" ? "POSIX staged-root modes" : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-stage-forged-identity-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name === "official_prepared") process.exit(84);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 84, interrupted.stderr);

  const journalPath = path.join(homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const target = journal.targets.at(-1);
  assert.equal(journal.state, "official_prepared");
  assert.equal(target.stage_root_identity, null);
  assert.equal(target.staged_manifest, null);

  fs.mkdirSync(target.staged_path, { recursive: true, mode: 0o700 });
  fs.chmodSync(target.staged_path, 0o700);
  const foreignPath = path.join(target.staged_path, target.desired_files[0].path);
  fs.writeFileSync(foreignPath, "foreign sentinel\n", { mode: 0o644 });
  const stagedStats = fs.lstatSync(target.staged_path, { bigint: true });
  target.stage_root_identity = {
    type: "directory",
    dev: String(stagedStats.dev),
    ino: String(stagedStats.ino)
  };
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

  const before = snapshotTree(target.staged_path);
  journal.state = "official_staged";
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "unsafe_state"
      && error.reason === "incomplete_official_batch_staged_authority"
  );
  assert.deepEqual(snapshotTree(target.staged_path), before);

  journal.state = "official_prepared";
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
      && error.reason === "official_cleanup_file_changed"
  );
  assert.deepEqual(snapshotTree(target.staged_path), before);
  assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign sentinel\n");
  assert.equal(fs.existsSync(journalPath), true);
});

test("official-batch recovers an interrupted root publication through the existing journal and retries the exact proof", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-interrupt-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name === "official_target_published") process.exit(91);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 91, interrupted.stderr);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), true);

  const recovered = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(recovered.status, "verified");
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
  const current = await store.previewOfficialBatch();
  assert.ok(current.targets.every(({ classification }) => classification === "candidate-official"));
});

test("official-batch recovery finishes a rollback interrupted after partial candidate cleanup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-rollback-interrupt-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name, detail) => {
        if (name === "official_target_published") throw new Error("begin rollback");
        if (name === "official_cleanup_file_removed" && detail.root.includes("official-rollbacks")) {
          process.exit(93);
        }
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 93, interrupted.stderr);
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), true);

  const recovered = await store.applyOfficialBatch({
    operationId: preview.operation_id,
    planFingerprint: preview.plan_fingerprint
  });
  assert.equal(recovered.status, "verified");
  assert.equal(fs.existsSync(path.join(homePath, ".dotaios", "managed-skills", "transaction.json")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills", ".managed-skill-store")), false);
});

test("official-batch serializes with reconcile through the one managed-store lock", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-lock-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  t.after(() => releaseResolve?.());
  const officialStore = createManagedSkillStore({
    aiosPath,
    homePath,
    hooks: {
      async checkpoint(name) {
        if (name === "official_prepared") {
          enteredResolve();
          await release;
        }
      }
    }
  });
  const competingStore = createManagedSkillStore({ aiosPath, homePath });
  const official = await officialStore.previewOfficialBatch();
  const reconcile = await competingStore.reconcile();
  const applying = officialStore.applyOfficialBatch({
    operationId: official.operation_id,
    planFingerprint: official.plan_fingerprint
  });

  await entered;
  await assert.rejects(
    competingStore.reconcile({
      apply: true,
      operationId: reconcile.operation_id,
      planFingerprint: reconcile.plan_fingerprint
    }),
    (error) => error?.code === "store_busy"
  );
  releaseResolve();
  assert.equal((await applying).status, "verified");
});

test("official-batch recovery rejects forged journal coordinates before mutating any skill root", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-journal-guard-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const victim = path.join(root, "outside-victim");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "sentinel.txt"), "do not touch\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name === "official_target_published") process.exit(92);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 92, interrupted.stderr);

  const journalPath = path.join(homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.targets[0].destination = victim;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const beforeAios = snapshotTree(aiosPath);
  const beforeVictim = snapshotTree(victim);

  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "unsafe_state"
  );
  assert.deepEqual(snapshotTree(aiosPath), beforeAios);
  assert.deepEqual(snapshotTree(victim), beforeVictim);
  assert.equal(fs.existsSync(journalPath), true);
});

test("official-batch recovery rejects forged staged authority before deleting candidate-looking bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-journal-authority-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePredecessorSkills(aiosPath);

  const store = createManagedSkillStore({ aiosPath, homePath });
  const preview = await store.previewOfficialBatch();
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const interrupted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(aiosPath)},
      homePath: ${JSON.stringify(homePath)},
      hooks: { checkpoint: async (name) => {
        if (name === "official_target_published") process.exit(94);
      } }
    });
    await store.applyOfficialBatch({
      operationId: ${JSON.stringify(preview.operation_id)},
      planFingerprint: ${JSON.stringify(preview.plan_fingerprint)}
    });
  `], { encoding: "utf8" });
  assert.equal(interrupted.status, 94, interrupted.stderr);

  const journalPath = path.join(homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.targets[0].staged_manifest.files[0].sha256 = "0".repeat(64);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const before = snapshotTree(aiosPath);

  await assert.rejects(
    store.applyOfficialBatch({
      operationId: preview.operation_id,
      planFingerprint: preview.plan_fingerprint
    }),
    (error) => error?.code === "unsafe_state"
  );
  assert.deepEqual(snapshotTree(aiosPath), before);
  assert.equal(fs.existsSync(journalPath), true);
});

test("official-batch restores roots and all dependent artifacts at every derived-publication checkpoint", async (t) => {
  for (const failurePoint of [
    "portable_inventory_published",
    "index_catalog_published",
    "resolver_catalog_published"
  ]) {
    await t.test(failurePoint, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-official-derived-"));
      const aiosPath = path.join(root, "aios");
      const homePath = path.join(root, "home");
      fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
      fs.mkdirSync(homePath);
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      writePredecessorSkills(aiosPath);
      fs.writeFileSync(path.join(aiosPath, "skills", "_registry.json"), `${JSON.stringify({
        format: "dotaios-skill-install-inventory/v2",
        skills: ["audit"],
        managed: [],
        plugins: []
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(aiosPath, "skills", "INDEX.md"), "old index\n");
      fs.writeFileSync(path.join(aiosPath, "skills", "RESOLVER.md"), "old resolver\n");
      const before = snapshotTree(aiosPath);
      let failed = false;
      const store = createManagedSkillStore({
        aiosPath,
        homePath,
        hooks: {
          checkpoint: async (name) => {
            if (name === failurePoint && !failed) {
              failed = true;
              throw new Error(`injected ${failurePoint}`);
            }
          }
        }
      });
      const preview = await store.previewOfficialBatch();
      await assert.rejects(
        store.applyOfficialBatch({
          operationId: preview.operation_id,
          planFingerprint: preview.plan_fingerprint
        }),
        new RegExp(`injected ${failurePoint}`)
      );
      assert.deepEqual(snapshotTree(aiosPath), before);
    });
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitObjectId(type, bytes) {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

function gitTreeObjectId(rows) {
  const body = Buffer.concat(rows
    .sort((left, right) => compareUtf8(left.name, right.name))
    .flatMap((row) => [
      Buffer.from(`${row.mode} ${row.name}\0`),
      Buffer.from(row.objectId, "hex")
    ]));
  return gitObjectId("tree", body);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writePredecessorSkills(aiosPath) {
  assert.equal(predecessorFixture.format, "dotaios-official-skill-predecessor-fixture/v1");
  for (const file of predecessorFixture.files) {
    const destination = path.join(aiosPath, "skills", ...file.path.split("/"));
    const bytes = Buffer.from(predecessorFixture.blobs[file.sha256], "base64");
    assert.equal(sha256(bytes), file.sha256, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, bytes, { mode: file.mode });
    fs.chmodSync(destination, file.mode);
  }
}

function writeCandidateSkills(aiosPath, official) {
  for (const skill of official.skills) {
    const destinationRoot = path.join(aiosPath, "skills", skill.name);
    fs.mkdirSync(destinationRoot, { recursive: true, mode: skill.mode });
    fs.chmodSync(destinationRoot, skill.mode);
    for (const file of skill.files) {
      const destination = path.join(destinationRoot, file.path);
      fs.writeFileSync(destination, file.installed_bytes, { mode: file.mode });
      fs.chmodSync(destination, file.mode);
    }
  }
}

function renderGeneratedPrompt(origin, guidance = "This file is generated by DotAIOS. Re-run `npx dotaios interview` to refresh it.") {
  return [
    "# plan-today personalization",
    "",
    guidance,
    "Skills should prefer this compiled file over reading the individual context files.",
    "",
    "## Who you are",
    `Fixture owner — origin ${origin}`,
    "",
    "## What you're working on",
    "Preserve these exact personalized bytes.",
    "",
    "## What matters this week",
    "Safe official adoption.",
    "",
    "## Planning preferences",
    "- Plan style: focused",
    "- Priorities per day: 3",
    "- Time blocks: yes",
    "- Frog definition: overdue tasks",
    ""
  ].join("\n");
}
