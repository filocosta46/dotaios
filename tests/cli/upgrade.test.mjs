import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  bridgeContent,
  bridgeManagedBlock,
  bridgePath,
  loadAgentRegistry,
  previewManagedBridgeFile
} from "../../packages/core/src/bridges.mjs";
import {
  applyUpgrade,
  previewUpgrade
} from "../../packages/cli/src/commands/upgrade.mjs";
import { createManagedSkillStore } from "../../packages/core/src/managed-skill-store.mjs";
import {
  isRecognizedOfficialSkillOverlay,
  loadOfficialSkillPackage
} from "../../packages/core/src/official-skills.mjs";
import { snapshotTree } from "../helpers/managed-skills.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const candidateVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
).version;
const candidateInvocation = `npx dotaios@${candidateVersion}`;
const predecessorFixture = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "tests", "fixtures", "official-skills-predecessor.json"),
  "utf8"
));

test("upgrade remains a shallow sequencer with no migration writer, PATH runner, or new lock", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "packages", "cli", "src", "commands", "upgrade.mjs"),
    "utf8"
  );
  assert.doesNotMatch(source, /applyMigration|originVersion|origin_version/);
  assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b/);
  assert.doesNotMatch(source, /acquireOperationLock|releaseOperationLock|upgrade journal|backup store|compensation/i);
  assert.doesNotMatch(source, /npx -y|dotaios migrate --apply/);
});

test("upgrade preview is read-only and exact aggregate proof gates every write", async (t) => {
  const fixture = await createUpgradeFixture(t);
  const unmanaged = path.join(fixture.homePath, ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(unmanaged), { recursive: true });
  fs.writeFileSync(unmanaged, "# Personal Claude instructions\n");
  const before = snapshotTree(fixture.root);

  const preview = await previewUpgrade(fixture);
  assert.equal(preview.status, "ready");
  assert.match(preview.id, /^upgrade-[a-f0-9]{24}$/);
  assert.match(preview.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.ok(preview.targets.some(({ domain }) => domain === "official-skills"));
  assert.ok(preview.targets.some(({ domain }) => domain === "managed-schedules"));
  assert.ok(preview.targets.some(({ domain, path: target }) => (
    domain === "managed-bridges" && target === fixture.bridgePath
  )));
  assert.equal(Object.getOwnPropertyNames(preview).includes("_domains"), false);
  assert.equal(preview._domains, undefined);
  assert.doesNotMatch(JSON.stringify(preview), /# Installed Skills|# Skill Resolver|stale bridge sentinel/i);
  assert.deepEqual(snapshotTree(fixture.root), before);

  const refused = await applyUpgrade({
    ...fixture,
    id: preview.id,
    fingerprint: `${preview.fingerprint.slice(0, -1)}${preview.fingerprint.endsWith("0") ? "1" : "0"}`
  });
  assert.equal(refused.status, "blocked-conflict");
  assert.match(JSON.stringify(refused.conflicts), /proof|stale|fingerprint/i);
  assert.deepEqual(snapshotTree(fixture.root), before);

  const applied = await applyUpgrade({
    ...fixture,
    id: preview.id,
    fingerprint: preview.fingerprint
  });
  assert.equal(applied.status, "verified");
  assert.match(fs.readFileSync(fixture.schedulesPath, "utf8"), new RegExp(
    `command: "${escapeRegExp(candidateInvocation)} brief"`
  ));
  assert.match(fs.readFileSync(fixture.bridgePath, "utf8"), new RegExp(
    `${escapeRegExp(candidateInvocation)} brief --compact --memory shared`
  ));
  assert.equal(fs.readFileSync(unmanaged, "utf8"), "# Personal Claude instructions\n");

  const afterApplied = snapshotTree(fixture.root);
  const stale = await applyUpgrade({
    ...fixture,
    id: preview.id,
    fingerprint: preview.fingerprint
  });
  assert.equal(stale.status, "blocked-conflict");
  assert.deepEqual(snapshotTree(fixture.root), afterApplied);

  const currentPreview = await previewUpgrade(fixture);
  assert.equal(currentPreview.status, "current");
  const current = await applyUpgrade({
    ...fixture,
    id: currentPreview.id,
    fingerprint: currentPreview.fingerprint
  });
  assert.equal(current.status, "verified");
  assert.deepEqual(snapshotTree(fixture.root), afterApplied);
});

test("upgrade gates outdated schema and open migration recovery with zero writes", async (t) => {
  for (const scenario of [
    {
      name: "schema outdated",
      arrange({ aiosPath }) {
        writeAiosConfig(aiosPath, { schema_version: "1.1.0", skills_first: false });
      },
      guidance: /npx dotaios@[^\s]+ migrate(?: --path|$)/
    },
    {
      name: "open migration transaction",
      arrange({ aiosPath }) {
        const migrations = path.join(aiosPath, ".dotaios", "migrations");
        fs.mkdirSync(path.join(
          migrations,
          "transactions",
          "migrate-1_1_0-to-1_2_0-0123456789abcdef"
        ), { recursive: true });
        fs.writeFileSync(
          path.join(migrations, "owner.json"),
          `${JSON.stringify({ schema: "dotaios.migrations.v1" }, null, 2)}\n`
        );
      },
      guidance: /npx dotaios@[^\s]+ migrate --recover/
    }
  ]) {
    await t.test(scenario.name, async (t) => {
      const fixture = await createUpgradeFixture(t);
      scenario.arrange(fixture);
      const before = snapshotTree(fixture.root);

      const preview = await previewUpgrade(fixture);
      assert.equal(preview.status, "recovery-required");
      assert.equal(preview.id, null);
      assert.equal(preview.fingerprint, null);
      assert.match(preview.guidance.join("\n"), scenario.guidance);
      assert.doesNotMatch(preview.guidance.join("\n"), /npx -y|dotaios migrate --apply/);
      assert.deepEqual(snapshotTree(fixture.root), before);

      const applied = await applyUpgrade({
        ...fixture,
        id: "upgrade-000000000000000000000000",
        fingerprint: `sha256:${"0".repeat(64)}`
      });
      assert.equal(applied.status, "recovery-required");
      assert.deepEqual(snapshotTree(fixture.root), before);
    });
  }
});

test("official conflict suppresses skills-first bridges while independent repairs continue", async (t) => {
  const fixture = await createUpgradeFixture(t, { skillsFirst: true });
  const auditRoot = path.join(fixture.aiosPath, "skills", "audit");
  fs.mkdirSync(auditRoot, { recursive: true });
  const personalAudit = [
    "---",
    "name: personal-audit",
    "description: Personal same-name workflow.",
    "---",
    "# Personal audit",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(auditRoot, "SKILL.md"), personalAudit);
  const indexPath = path.join(fixture.aiosPath, "skills", "INDEX.md");
  const resolverPath = path.join(fixture.aiosPath, "skills", "RESOLVER.md");
  const beforeBridge = fs.readFileSync(fixture.bridgePath);
  const beforeIndex = fs.readFileSync(indexPath);
  const beforeResolver = fs.readFileSync(resolverPath);

  const preview = await previewUpgrade(fixture);
  assert.equal(preview.status, "blocked-conflict");
  assert.match(JSON.stringify(preview.conflicts), /personal-same-name|official|skills-first/i);
  assert.equal(preview.targets.some(({ domain }) => domain === "managed-bridges"), false);

  const applied = await applyUpgrade({
    ...fixture,
    id: preview.id,
    fingerprint: preview.fingerprint
  });
  assert.equal(applied.status, "blocked-conflict");
  assert.match(fs.readFileSync(fixture.schedulesPath, "utf8"), new RegExp(
    `command: "${escapeRegExp(candidateInvocation)} brief"`
  ));
  assert.deepEqual(fs.readFileSync(fixture.bridgePath), beforeBridge);
  assert.deepEqual(fs.readFileSync(indexPath), beforeIndex);
  assert.deepEqual(fs.readFileSync(resolverPath), beforeResolver);
  assert.equal(fs.readFileSync(path.join(auditRoot, "SKILL.md"), "utf8"), personalAudit);
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, "skills", "closeday", "SKILL.md")), true);
  assert.doesNotMatch(JSON.stringify(applied), /restart|all current/i);
});

test("skills-first upgrade binds the desired post-batch catalog bridge and applies those exact bytes", async (t) => {
  const fixture = await createUpgradeFixture(t, { skillsFirst: true });
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    officialCandidateVersion: candidateVersion
  });
  const composition = await store.previewOfficialBatchComposition();
  assert.ok(composition.skillsCatalog);
  const codex = (await loadAgentRegistry(fixture.aiosPath)).find(({ name }) => name === "Codex");
  const desiredBlock = await bridgeManagedBlock(fixture.aiosPath, {
    skillsFirst: true,
    skillsCatalog: composition.skillsCatalog,
    cli: candidateInvocation
  });
  const desiredBridge = await bridgeContent(codex, fixture.aiosPath, {
    managedBlock: desiredBlock
  });
  const expectedPlan = await previewManagedBridgeFile(fixture.bridgePath, desiredBridge, {
    refreshOnly: true,
    boundaryRoot: fixture.homePath
  });
  assert.equal(expectedPlan.status, "ready");

  const preview = await previewUpgrade(fixture);
  assert.equal(preview.status, "ready");
  const bridgeTarget = preview.targets.find(({ domain, path: target }) => (
    domain === "managed-bridges" && target === fixture.bridgePath
  ));
  assert.equal(bridgeTarget.fingerprint, expectedPlan.fingerprint);
  assert.doesNotMatch(JSON.stringify(preview), /stale index sentinel|stale resolver sentinel/i);

  const applied = await applyUpgrade({
    ...fixture,
    id: preview.id,
    fingerprint: preview.fingerprint
  });
  assert.equal(applied.status, "verified");
  assert.equal(fs.readFileSync(fixture.bridgePath, "utf8"), desiredBridge);
  assert.equal(
    fs.readFileSync(path.join(fixture.aiosPath, "skills", "INDEX.md"), "utf8"),
    composition.skillsCatalog.indexText
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.aiosPath, "skills", "RESOLVER.md"), "utf8"),
    composition.skillsCatalog.resolverText
  );
  const current = await previewManagedBridgeFile(fixture.bridgePath, desiredBridge, {
    refreshOnly: true,
    boundaryRoot: fixture.homePath
  });
  assert.equal(current.status, "current");
});

test("official lock contention is structured and still allows independent schedule repair", async (t) => {
  const fixture = await createUpgradeFixture(t, { skillsFirst: true });
  const preview = await previewUpgrade(fixture);
  const beforeBridge = fs.readFileSync(fixture.bridgePath);
  const indexPath = path.join(fixture.aiosPath, "skills", "INDEX.md");
  const resolverPath = path.join(fixture.aiosPath, "skills", "RESOLVER.md");
  const beforeIndex = fs.readFileSync(indexPath);
  const beforeResolver = fs.readFileSync(resolverPath);
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const ownerStore = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    officialCandidateVersion: candidateVersion,
    hooks: {
      async checkpoint(name) {
        if (name !== "official_prepared") return;
        enteredResolve();
        await release;
      }
    }
  });
  const ownerPreview = await ownerStore.previewOfficialBatch();
  const owningApply = ownerStore.applyOfficialBatch({
    operationId: ownerPreview.operation_id,
    planFingerprint: ownerPreview.plan_fingerprint
  });
  t.after(async () => {
    releaseResolve?.();
    await owningApply.catch(() => {});
  });
  await entered;

  const result = await applyUpgrade({
    ...fixture,
    id: preview.id,
    fingerprint: preview.fingerprint
  });

  assert.equal(result.status, "blocked-conflict");
  assert.match(JSON.stringify(result.conflicts), /official.*busy|managed.skill.store.busy/i);
  assert.match(fs.readFileSync(fixture.schedulesPath, "utf8"), new RegExp(
    `command: "${escapeRegExp(candidateInvocation)} brief"`
  ));
  assert.deepEqual(fs.readFileSync(fixture.bridgePath), beforeBridge);
  assert.deepEqual(fs.readFileSync(indexPath), beforeIndex);
  assert.deepEqual(fs.readFileSync(resolverPath), beforeResolver);
  releaseResolve();
  assert.equal((await owningApply).status, "verified");
});

test("public upgrade preserves a bounded npx-only predecessor fixture through conflict-safe apply", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-upgrade-e2e-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const binPath = path.join(root, "bin");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  fs.mkdirSync(binPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAiosConfig(aiosPath, { schema_version: "1.2.0", skills_first: false });
  writePredecessorSkills(aiosPath);
  fs.writeFileSync(schedulesPath, [
    "schedules:",
    "  - name: daily-brief",
    "    cadence: daily",
    "    command: \"npx dotaios@2.0.9 brief\"",
    "    enabled: true",
    ""
  ].join("\n"));

  const promptPath = path.join(aiosPath, "skills", "plan-today", "prompt.md");
  const promptBytes = Buffer.from(renderGeneratedPrompt(
    "2.0.10",
    "This file is generated by DotAIOS. Re-run `npx dotaios@2.0.10 interview` to refresh it."
  ));
  fs.writeFileSync(promptPath, promptBytes, { mode: 0o644 });
  assert.equal(isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", promptBytes), true);
  const promptMode = fs.statSync(promptPath).mode & 0o7777;

  const auditRoot = path.join(aiosPath, "skills", "audit");
  fs.rmSync(auditRoot, { recursive: true });
  fs.mkdirSync(auditRoot);
  const personalAudit = Buffer.from([
    "---",
    "name: audit",
    "description: My personal audit workflow.",
    "---",
    "# Personal audit",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(auditRoot, "SKILL.md"), personalAudit);

  const npxMarker = path.join(root, "npx-executed");
  const dotaiosMarker = path.join(root, "dotaios-executed");
  writePathTripwire(path.join(binPath, tripwireName("npx")), npxMarker);
  writePathTripwire(path.join(binPath, tripwireName("dotaios")), dotaiosMarker);
  const env = {
    ...process.env,
    HOME: homePath,
    USERPROFILE: homePath,
    PATH: binPath,
    ...(process.platform === "win32" ? { PATHEXT: ".CMD;.EXE;.BAT" } : {})
  };
  delete env.CLAUDE_CONFIG_DIR;
  const before = snapshotTree(root);

  const preview = spawnSync(process.execPath, [
    cli,
    "upgrade",
    "--dry-run",
    "--path",
    aiosPath
  ], { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(preview.status, 1, preview.stderr);
  assert.match(preview.stderr, /same_name_directory_unowned|personal-same-name/i);
  assert.match(preview.stdout, new RegExp(escapeRegExp(candidateInvocation)));
  assert.doesNotMatch(`${preview.stdout}\n${preview.stderr}`, /npx -y|restart|all current/i);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(npxMarker), false);
  assert.equal(fs.existsSync(dotaiosMarker), false);
  const id = /^Preview ID: (upgrade-[a-f0-9]{24})$/m.exec(preview.stdout)?.[1];
  const fingerprint = /^Fingerprint: (sha256:[a-f0-9]{64})$/m.exec(preview.stdout)?.[1];
  assert.ok(id, preview.stdout);
  assert.ok(fingerprint, preview.stdout);

  const applied = spawnSync(process.execPath, [
    cli,
    "upgrade",
    "--apply",
    "--id",
    id,
    "--fingerprint",
    fingerprint,
    "--path",
    aiosPath
  ], { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(applied.status, 1, applied.stderr);
  assert.match(applied.stderr, /preserved one or more conflicts/i);
  assert.doesNotMatch(`${applied.stdout}\n${applied.stderr}`, /restart|all current/i);
  assert.deepEqual(fs.readFileSync(path.join(auditRoot, "SKILL.md")), personalAudit);
  assert.deepEqual(fs.readFileSync(promptPath), promptBytes);
  assert.equal(fs.statSync(promptPath).mode & 0o7777, promptMode);
  assert.match(fs.readFileSync(schedulesPath, "utf8"), new RegExp(
    `command: "${escapeRegExp(candidateInvocation)} brief"`
  ));
  const official = await loadOfficialSkillPackage({ candidateVersion });
  const exportOkf = official.skills.find(({ name }) => name === "export-okf");
  for (const file of exportOkf.files) {
    assert.deepEqual(
      fs.readFileSync(path.join(aiosPath, "skills", "export-okf", file.path)),
      file.installed_bytes
    );
  }
  for (const catalog of ["_registry.json", "INDEX.md", "RESOLVER.md"]) {
    assert.equal(fs.existsSync(path.join(aiosPath, "skills", catalog)), false, catalog);
  }
  assert.equal(fs.existsSync(npxMarker), false);
  assert.equal(fs.existsSync(dotaiosMarker), false);
});

async function createUpgradeFixture(t, { skillsFirst = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-upgrade-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  fs.mkdirSync(path.join(aiosPath, "skills"), { recursive: true });
  fs.mkdirSync(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAiosConfig(aiosPath, { schema_version: "1.2.0", skills_first: skillsFirst });
  fs.writeFileSync(schedulesPath, [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx dotaios@2.0.9 brief\"",
    "    enabled: false",
    ""
  ].join("\n"));

  if (skillsFirst) {
    fs.writeFileSync(path.join(aiosPath, "skills", "INDEX.md"), "# stale index sentinel\n");
    fs.writeFileSync(path.join(aiosPath, "skills", "RESOLVER.md"), "# stale resolver sentinel\n");
  }
  const codex = (await loadAgentRegistry(aiosPath)).find(({ name }) => name === "Codex");
  const managedBridgePath = bridgePath(homePath, codex);
  fs.mkdirSync(path.dirname(managedBridgePath), { recursive: true });
  fs.writeFileSync(
    managedBridgePath,
    await bridgeContent(codex, aiosPath, {
      skillsFirst,
      cli: "npx dotaios@2.0.9"
    })
  );
  return {
    root,
    aiosPath,
    homePath,
    schedulesPath,
    bridgePath: managedBridgePath,
    candidateVersion
  };
}

function writeAiosConfig(aiosPath, value) {
  fs.writeFileSync(path.join(aiosPath, "aios.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function writePredecessorSkills(aiosPath) {
  assert.equal(predecessorFixture.format, "dotaios-official-skill-predecessor-fixture/v1");
  for (const file of predecessorFixture.files) {
    const destination = path.join(aiosPath, "skills", ...file.path.split("/"));
    const bytes = Buffer.from(predecessorFixture.blobs[file.sha256], "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, bytes, { mode: file.mode });
    fs.chmodSync(destination, file.mode);
  }
}

function renderGeneratedPrompt(origin, guidance) {
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

function writePathTripwire(destination, marker) {
  if (process.platform === "win32") {
    fs.writeFileSync(destination, [
      "@echo off",
      `> "${marker.replaceAll("%", "%%")}" echo executed`,
      "exit /b 97",
      ""
    ].join("\r\n"));
    return;
  }
  fs.writeFileSync(destination, [
    "#!/bin/sh",
    `printf executed > ${shellQuote(marker)}`,
    "exit 97",
    ""
  ].join("\n"), { mode: 0o755 });
}

function tripwireName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
