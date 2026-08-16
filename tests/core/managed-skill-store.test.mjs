import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { createManagedSkillStore } from "../../packages/core/src/managed-skill-store.mjs";
import {
  createManagedSkillFixture,
  OPAQUE_ASSET_BYTES,
  OPAQUE_ASSET_SHA256,
  snapshotTree,
  writeSkill
} from "../helpers/managed-skills.mjs";

const EXECUTABLE_SCRIPT = Buffer.from("#!/bin/sh\necho should-not-run\n", "utf8");
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const mcpServerPath = path.join(repoRoot, "packages", "mcp", "src", "server.mjs");

test("inspect separates owned, unmanaged, and unsafe evidence without following shelf links", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "owned-skill"));

  const shelfNames = [
    "bill-cto-operating-loop",
    "brian-am-operating-loop",
    "fleet-context-pack",
    "jamie-cfo-operating-loop",
    "jeff-ceo-operating-loop"
  ];
  for (const name of shelfNames) {
    const shelfTarget = writeSkill(path.join(fixture.sourcesPath, name), {
      body: `# ${name}\nSHELF_TARGET_CONTENT_MUST_NOT_BE_READ_${name}\n`
    });
    fs.symlinkSync(shelfTarget, path.join(fixture.aiosPath, "skills", name), "dir");
  }

  writeSkill(path.join(fixture.homePath, ".agents", "skills", "native-skill"));
  const unsafeNative = writeSkill(path.join(fixture.homePath, ".agents", "skills", "unsafe-native"));
  const outside = path.join(fixture.sourcesPath, "outside-canary.txt");
  fs.writeFileSync(outside, "UNSAFE_LINK_TARGET_CONTENT_MUST_NOT_BE_READ\n");
  fs.symlinkSync(outside, path.join(unsafeNative, "linked-reference.txt"), "file");

  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const routedBeforeAdoption = await import("../../packages/core/src/skills.mjs")
    .then(({ collectSkills }) => collectSkills(fixture.aiosPath));
  const inventory = await store.inspect();

  assert.deepEqual(routedBeforeAdoption.map(({ name }) => name), ["owned-skill"]);
  assert.equal(inventory.format, "dotaios-managed-skill-inventory/v1");
  assert.deepEqual(inventory.owned.map((entry) => entry.name), ["owned-skill"]);
  assert.deepEqual(inventory.discovered_unmanaged.map((entry) => entry.name), [...shelfNames, "native-skill"]);
  assert.deepEqual(inventory.excluded_unsafe.map((entry) => entry.name), ["unsafe-native"]);
  assert.ok(inventory.discovered_unmanaged.slice(0, shelfNames.length)
    .every(({ source_kind: sourceKind }) => sourceKind === "discovered-canonical-link"));
  assert.equal(inventory.discovered_unmanaged.at(-1).source_kind, "discovered-native-directory");
  assert.match(inventory.excluded_unsafe[0].reason, /link/i);
  assert.equal(JSON.stringify(inventory).includes("SHELF_TARGET_CONTENT_MUST_NOT_BE_READ"), false);
  assert.equal(JSON.stringify(inventory).includes("UNSAFE_LINK_TARGET_CONTENT_MUST_NOT_BE_READ"), false);
  assert.deepEqual(snapshotTree(fixture.root), before);

  const coordinates = [...inventory.owned, ...inventory.discovered_unmanaged, ...inventory.excluded_unsafe]
    .map((entry) => `${entry.source_kind}:${entry.coordinate}`);
  assert.equal(new Set(coordinates).size, coordinates.length);
});

test("inventory excludes broken and outside native links from adoption candidates", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const nativeRoot = path.join(fixture.homePath, ".claude", "skills");
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.symlinkSync(path.join(fixture.root, "missing-native-target"), path.join(nativeRoot, "broken-native"), "dir");
  const outside = writeSkill(path.join(fixture.sourcesPath, "outside-native"));
  fs.symlinkSync(outside, path.join(nativeRoot, "outside-native"), "dir");

  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const inventory = await store.inspect();
  assert.equal(inventory.discovered_unmanaged.some(({ name }) => name === "broken-native"), false);
  assert.equal(inventory.discovered_unmanaged.some(({ name }) => name === "outside-native"), false);
  assert.deepEqual(
    inventory.excluded_unsafe.filter(({ name }) => ["broken-native", "outside-native"].includes(name)).map(({ name }) => name),
    ["broken-native", "outside-native"]
  );
});

test("preview is deterministic and zero-write while binding the complete opaque bundle and collisions", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "review"), {
    description: "Review a completed change.",
    files: {
      "assets/palette.bin": OPAQUE_ASSET_BYTES,
      "references/checklist.md": Buffer.from("# Checklist\n", "utf8"),
      "scripts/install.sh": EXECUTABLE_SCRIPT
    },
    executable: ["scripts/install.sh"]
  });
  writeSkill(path.join(fixture.aiosPath, "skills", "review"), {
    description: "Existing owned collision."
  });
  writeSkill(path.join(fixture.homePath, ".agents", "skills", "review"), {
    description: "Existing native collision."
  });

  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const first = await store.previewAdoption({
    sourcePath,
    sourceKind: "local-reviewed-directory"
  });
  const second = await store.previewAdoption({
    sourcePath,
    sourceKind: "local-reviewed-directory"
  });

  assert.deepEqual(second, first);
  assert.deepEqual(snapshotTree(fixture.root), before);
  assert.equal(first.format, "dotaios-managed-skill-adoption-proof/v1");
  assert.ok(typeof first.operation_id === "string" && first.operation_id.length > 0);
  assert.match(first.plan_fingerprint, /^(?:sha256:)?[a-f0-9]{64}$/);
  assert.equal(first.source.kind, "local-reviewed-directory");
  assert.ok(first.source.identity && typeof first.source.identity === "object");
  assert.equal(JSON.stringify(first.source.portable_provenance).includes(fixture.root), false);
  assert.equal(first.skill.name, "review");
  assert.equal(first.skill.description, "Review a completed change.");
  assert.match(first.skill.bundle_digest, /^(?:sha256:)?[a-f0-9]{64}$/);

  assert.deepEqual(first.skill.files.map((entry) => entry.path), [
    "SKILL.md",
    "assets/palette.bin",
    "references/checklist.md",
    "scripts/install.sh"
  ]);
  const binary = first.skill.files.find((entry) => entry.path === "assets/palette.bin");
  assert.deepEqual(binary, {
    path: "assets/palette.bin",
    bytes: 5,
    executable: false,
    classification: "opaque-asset",
    content_type: "application/octet-stream",
    sha256: OPAQUE_ASSET_SHA256
  });
  assert.deepEqual(first.skill.scripts, ["scripts/install.sh"]);
  assert.deepEqual(first.skill.executables, ["scripts/install.sh"]);
  assert.ok(first.collisions.some((entry) => entry.classification === "canonical-owned-different"));
  assert.ok(first.collisions.some((entry) => entry.classification === "real-unmanaged"));

  assert.deepEqual(
    first.projections.map((entry) => entry.relative_path).sort(),
    [
      ".agents/skills/review",
      ".claude/skills/review",
      ".gemini/config/skills/review"
    ]
  );
  const sharedProjection = first.projections.find((entry) => entry.relative_path === ".agents/skills/review");
  assert.deepEqual(sharedProjection.hosts, ["Codex", "Cursor", "Gemini", "Kimi Code CLI", "OpenCode"]);
  assert.ok(first.catalogs && typeof first.catalogs === "object");
  assert.ok(Array.isArray(first.effects));
});

test("preview refuses invalid UTF-8 in SKILL.md without changing its bytes", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = path.join(fixture.sourcesPath, "invalid-metadata");
  fs.mkdirSync(sourcePath);
  const invalidMetadata = Buffer.from([
    0x2d, 0x2d, 0x2d, 0x0a,
    0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xff, 0x0a,
    0x2d, 0x2d, 0x2d, 0x0a
  ]);
  fs.writeFileSync(path.join(sourcePath, "SKILL.md"), invalidMetadata);
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.name === "ManagedSkillStoreError" && error?.code === "invalid_skill_metadata"
  );

  assert.deepEqual(fs.readFileSync(path.join(sourcePath, "SKILL.md")), invalidMetadata);
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("preview refuses a frontmatter name that does not match the bundle directory", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "review"), { name: "plan" });
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.name === "ManagedSkillStoreError" && error?.code === "invalid_skill_metadata"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("preview refuses nested links without reading their targets", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "linked-bundle"));
  const outsidePath = path.join(fixture.root, "outside-secret.txt");
  fs.writeFileSync(outsidePath, "NESTED_LINK_TARGET_MUST_NOT_BE_READ\n");
  fs.symlinkSync(outsidePath, path.join(sourcePath, "reference.txt"), "file");
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.name === "ManagedSkillStoreError" && error?.code === "unsafe_source"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("preview refuses multiply-linked regular files without changing either link", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "hardlinked-bundle"));
  const outsidePath = path.join(fixture.root, "outside-hardlink.txt");
  fs.writeFileSync(outsidePath, "HARDLINK_BYTES_MUST_STAY_UNCHANGED\n");
  fs.linkSync(outsidePath, path.join(sourcePath, "shared.txt"));
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.name === "ManagedSkillStoreError" && error?.code === "unsafe_source"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("preview refuses special files without blocking on their content", {
  skip: process.platform === "win32" ? "FIFO fixtures are unavailable on Windows" : false
}, async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "special-bundle"));
  const fifoPath = path.join(sourcePath, "input.pipe");
  const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  if (created.status !== 0) {
    t.skip(`FIFO fixture unsupported: ${created.stderr.trim() || "mkfifo failed"}`);
    return;
  }
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.name === "ManagedSkillStoreError" && error?.code === "unsafe_source"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("preview deterministically refuses derived Python junk instead of decoding or ignoring it", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "derived-junk"), {
    files: { "__pycache__/helper.cpython-313.pyc": OPAQUE_ASSET_BYTES }
  });
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.name === "ManagedSkillStoreError"
      && error?.code === "unsafe_source"
      && error?.reason === "derived_artifact_refused"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("preview refuses a nested Agent Skill bundle instead of treating it as an opaque asset", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "nested-bundle"));
  writeSkill(path.join(sourcePath, "skills", "child"), { name: "child" });
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  await assert.rejects(
    () => store.previewAdoption({ sourcePath }),
    (error) => error?.code === "unsafe_source" && error?.reason === "nested_skill_bundle_refused"
  );
});

test("strict adoption accepts specification-valid multiline optional metadata", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = path.join(fixture.sourcesPath, "multiline-metadata");
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(path.join(sourcePath, "SKILL.md"), `---
name: multiline-metadata
description: >-
  Performs reviewed work.
  Use when multiline YAML is clearer.
license: >-
  Proprietary terms are described in
  the bundled LICENSE.txt file.
compatibility: >-
  Requires a local runtime and
  reviewed filesystem access.
allowed-tools: >-
  Read
  Bash(git:*)
metadata:
  reviewer-note: >-
    String metadata may be folded
    across YAML source lines.
---
# Multiline metadata
`);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath });
  assert.equal(proof.skill.name, "multiline-metadata");
});

test("apply refuses a stale source proof before writing canonical or host state", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "stale-source"), {
    files: { "assets/data.bin": OPAQUE_ASSET_BYTES }
  });
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  fs.appendFileSync(path.join(sourcePath, "assets", "data.bin"), Buffer.from([0x42]));
  const aiosBefore = snapshotTree(fixture.aiosPath);
  const homeBefore = snapshotTree(fixture.homePath);
  const sourceAfterChange = snapshotTree(sourcePath);

  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.name === "ManagedSkillStoreError" && error?.code === "source_changed"
  );

  assert.deepEqual(snapshotTree(fixture.aiosPath), aiosBefore);
  assert.deepEqual(snapshotTree(fixture.homePath), homeBefore);
  assert.deepEqual(snapshotTree(sourcePath), sourceAfterChange);
});

test("portable inventory drift invalidates an adoption proof before mutation", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "registry-drift"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  fs.writeFileSync(
    path.join(fixture.aiosPath, "skills", "_registry.json"),
    `${JSON.stringify({ format: "dotaios-skill-install-inventory/v2", skills: [], managed: [], plugins: [] })}\n`
  );
  const before = snapshotTree(fixture.root);

  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.code === "source_changed"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("a new projection collision invalidates an earlier proof and preserves the foreign destination", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "destination-race"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  const collisionPath = writeSkill(path.join(fixture.homePath, ".agents", "skills", "destination-race"), {
    description: "Foreign bytes arriving after preview."
  });
  const aiosBefore = snapshotTree(fixture.aiosPath);
  const homeAfterCollision = snapshotTree(fixture.homePath);

  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.name === "ManagedSkillStoreError"
      && ["proof_mismatch", "destination_changed"].includes(error?.code)
  );

  assert.deepEqual(snapshotTree(fixture.aiosPath), aiosBefore);
  assert.deepEqual(snapshotTree(fixture.homePath), homeAfterCollision);
  assert.match(fs.readFileSync(path.join(collisionPath, "SKILL.md"), "utf8"), /Foreign bytes/);
});

test("preview binds a linked native parent as an unsafe collision and apply leaves its target unchanged", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "linked-parent"));
  const outside = path.join(fixture.root, "outside-native-parent");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(fixture.homePath, ".agents"), "dir");
  const outsideBefore = snapshotTree(outside);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });

  assert.ok(proof.collisions.some(({ classification }) => classification === "unsafe-parent"));
  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.code === "collision"
  );
  assert.deepEqual(snapshotTree(outside), outsideBefore);
});

test("portable provenance drops machine-absolute lockfile fields", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", "portable-lock"));
  fs.writeFileSync(
    path.join(fixture.homePath, ".agents", ".skill-lock.json"),
    `${JSON.stringify({
      skills: {
        "portable-lock": {
          source: "/Users/someone/private/skills",
          sourceType: "reviewed-cache",
          skillPath: "C:\\Users\\someone\\private\\SKILL.md",
          skillFolderHash: "abc123"
        }
      }
    })}\n`
  );
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "discovered-native-directory" });

  assert.deepEqual(proof.source.portable_provenance, {
    attribution: "native-lockfile",
    source_type: "reviewed-cache",
    revision: "abc123"
  });
  assert.equal(JSON.stringify(proof.source.portable_provenance).includes("someone"), false);
});

test("exact-proof adoption byte-preserves opaque assets and leaves an arbitrary local source untouched", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const executionCanary = path.join(fixture.root, "SCRIPT_MUST_NOT_EXECUTE");
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "binary-bundle"), {
    description: "Bundle carrying a reviewed opaque asset.",
    files: {
      "assets/model.bin": OPAQUE_ASSET_BYTES,
      "scripts/install.sh": Buffer.from(`#!/bin/sh\nprintf executed > ${JSON.stringify(executionCanary)}\n`, "utf8")
    },
    executable: ["scripts/install.sh"]
  });
  const sourceBefore = snapshotTree(sourcePath);
  fs.writeFileSync(
    path.join(fixture.aiosPath, "skills", "_registry.json"),
    `${JSON.stringify({
      skills: ["ghost"],
      managed: [{ name: "ghost", bundle_digest: "sha256:forged", provenance: { path: fixture.root } }],
      plugins: [{ name: "legacy", path: fixture.root }]
    }, null, 2)}\n`
  );
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });

  const result = await store.applyAdoption({
    sourcePath,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });

  assert.equal(result.status, "adopted");
  assert.deepEqual(snapshotTree(sourcePath), sourceBefore);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.aiosPath, "skills", "binary-bundle", "assets", "model.bin")),
    OPAQUE_ASSET_BYTES
  );
  assert.equal(fs.existsSync(executionCanary), false);

  for (const relativeRoot of [".agents/skills", ".claude/skills", ".gemini/config/skills"]) {
    const projection = path.join(fixture.homePath, relativeRoot, "binary-bundle");
    assert.equal(fs.lstatSync(projection).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(projection), path.join(fixture.aiosPath, "skills", "binary-bundle"));
  }

  const registryPath = path.join(fixture.aiosPath, "skills", "_registry.json");
  const registry = fs.readFileSync(registryPath, "utf8");
  assert.equal(registry.includes(fixture.root), false);
  const portableInventory = JSON.parse(registry);
  assert.deepEqual(portableInventory.skills, ["binary-bundle"]);
  assert.deepEqual(portableInventory.plugins, []);
  const portableRow = portableInventory.managed.find((entry) => entry.name === "binary-bundle");
  assert.equal(portableRow.source_kind, "local-reviewed-directory");
  assert.equal(portableRow.bundle_digest, proof.skill.bundle_digest);

  const receiptPath = path.join(
    fixture.homePath,
    ".dotaios",
    "managed-skills",
    "receipts",
    "binary-bundle.json"
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.source.path, sourcePath);
  assert.equal(receipt.bundle.files.find((entry) => entry.path === "assets/model.bin").sha256, OPAQUE_ASSET_SHA256);
});

test("a proved canonical shelf link becomes owned and exact removal restores only that link", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "fleet-context-pack"), {
    files: { "assets/context.bin": OPAQUE_ASSET_BYTES }
  });
  const shelfPath = path.join(fixture.aiosPath, "skills", "fleet-context-pack");
  fs.symlinkSync(sourcePath, shelfPath, "dir");
  const sourceBefore = snapshotTree(sourcePath);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  const proof = await store.previewAdoption({
    sourcePath: shelfPath,
    sourceKind: "discovered-canonical-link"
  });
  assert.ok(proof.collisions.some(({ classification }) => classification === "selected-canonical-link"));
  await store.applyAdoption({
    sourcePath: shelfPath,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });

  assert.equal(fs.lstatSync(shelfPath).isDirectory(), true);
  assert.equal(fs.lstatSync(shelfPath).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(path.join(shelfPath, "assets", "context.bin")), OPAQUE_ASSET_BYTES);
  assert.deepEqual(snapshotTree(sourcePath), sourceBefore);

  const removal = await store.remove({ name: "fleet-context-pack" });
  const removed = await store.remove({
    name: "fleet-context-pack",
    apply: true,
    operationId: removal.operation_id,
    planFingerprint: removal.plan_fingerprint
  });
  assert.equal(removed.status, "removed");
  assert.equal(fs.lstatSync(shelfPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(shelfPath), sourcePath);
  assert.deepEqual(snapshotTree(sourcePath), sourceBefore);
});

test("eight proved native directories adopt into AIOS while indirect Claude links keep working", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const names = ["architecture", "architecture-review", "design", "improve", "plan", "review", "task-to-pr", "test"];
  for (const name of names) {
    const nativePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", name), {
      description: `Blueprint ${name}.`
    });
    const claudePath = path.join(fixture.homePath, ".claude", "skills", name);
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(claudePath), nativePath), claudePath, "dir");
  }
  fs.writeFileSync(
    path.join(fixture.homePath, ".agents", ".skill-lock.json"),
    `${JSON.stringify({ skills: Object.fromEntries(names.map((name) => [name, { source: "blueprint" }])) })}\n`
  );
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  for (const name of names) {
    const nativePath = path.join(fixture.homePath, ".agents", "skills", name);
    const proof = await store.previewAdoption({
      sourcePath: nativePath,
      sourceKind: "discovered-native-directory"
    });
    assert.ok(proof.projections.some(({ relative_path, classification }) =>
      relative_path === `.agents/skills/${name}` && classification === "selected-native-source"));
    assert.ok(proof.projections.some(({ relative_path, classification }) =>
      relative_path === `.claude/skills/${name}` && classification === "indirect-selected-source"));
    assert.ok(proof.collisions.some(({ coordinate, classification }) =>
      coordinate === `.agents/skills/${name}` && classification === "selected-native-source"));
    assert.ok(proof.collisions.some(({ coordinate, classification }) =>
      coordinate === `.claude/skills/${name}` && classification === "indirect-selected-source"));
    assert.deepEqual(proof.source.portable_provenance, {
      attribution: "native-lockfile",
      source: "blueprint"
    });
    await store.applyAdoption({
      sourcePath: nativePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  }

  const routed = await import("../../packages/core/src/skills.mjs").then(({ collectSkills }) => collectSkills(fixture.aiosPath));
  assert.deepEqual(routed.map(({ name }) => name), names);
  const managedInventory = await store.inspect();
  assert.deepEqual(managedInventory.owned.map(({ name }) => name), names);
  assert.equal(
    managedInventory.excluded_unsafe.some(({ name }) => names.includes(name)),
    false,
    "preserved Claude -> native -> AIOS projections are managed evidence, not unsafe candidates"
  );
  for (const name of names) {
    const cliResult = spawnSync(
      process.execPath,
      [cliPath, "skills", "resolve", name, "--path", fixture.aiosPath, "--json"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.equal(JSON.parse(cliResult.stdout).matches[0].name, name);
  }
  fs.writeFileSync(path.join(fixture.aiosPath, "aios.json"), "{}\n");
  const mcpMessages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    },
    ...names.map((name, index) => ({
      jsonrpc: "2.0",
      id: index + 2,
      method: "tools/call",
      params: { name: "resolve_skill", arguments: { intent: name } }
    }))
  ];
  const mcpResult = spawnSync(process.execPath, [mcpServerPath, "--path", fixture.aiosPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: `${mcpMessages.map((message) => JSON.stringify(message)).join("\n")}\n`
  });
  assert.equal(mcpResult.status, 0, mcpResult.stderr);
  const mcpResponses = mcpResult.stdout.trim().split("\n").map((line) => JSON.parse(line));
  for (const [index, name] of names.entries()) {
    const response = mcpResponses.find(({ id }) => id === index + 2);
    assert.ok(response?.result?.content?.[0]?.text, JSON.stringify(response));
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.matches[0].name, name);
  }
  for (const name of names) {
    const canonical = path.join(fixture.aiosPath, "skills", name);
    const nativePath = path.join(fixture.homePath, ".agents", "skills", name);
    const claudePath = path.join(fixture.homePath, ".claude", "skills", name);
    assert.equal(fs.lstatSync(canonical).isDirectory(), true);
    assert.equal(fs.lstatSync(nativePath).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(nativePath), fs.realpathSync(canonical));
    assert.equal(fs.realpathSync(claudePath), fs.realpathSync(canonical));
  }

  const removal = await store.remove({ name: "review" });
  await store.remove({
    name: "review",
    apply: true,
    operationId: removal.operation_id,
    planFingerprint: removal.plan_fingerprint
  });
  const restoredNative = path.join(fixture.homePath, ".agents", "skills", "review");
  assert.equal(fs.lstatSync(restoredNative).isDirectory(), true);
  assert.equal(fs.lstatSync(restoredNative).isSymbolicLink(), false);
  assert.equal(
    fs.realpathSync(path.join(fixture.homePath, ".claude", "skills", "review")),
    fs.realpathSync(restoredNative)
  );
});

test("repeating an identical exact proof is idempotent", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "repeatable"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({ sourcePath, operationId: proof.operation_id, planFingerprint: proof.plan_fingerprint });
  const before = snapshotTree(fixture.root);

  const repeated = await store.applyAdoption({
    sourcePath,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });
  assert.equal(repeated.status, "already_adopted");
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("exact retry refuses an exact-byte replacement of its reviewed local source root", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "local-root-identity"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath });
  await store.applyAdoption({ sourcePath, operationId: proof.operation_id, planFingerprint: proof.plan_fingerprint });
  fs.renameSync(sourcePath, `${sourcePath}.displaced`);
  fs.cpSync(`${sourcePath}.displaced`, sourcePath, { recursive: true, preserveTimestamps: true });
  await assert.rejects(
    () => store.applyAdoption({ sourcePath, operationId: proof.operation_id, planFingerprint: proof.plan_fingerprint }),
    (error) => error?.code === "source_changed"
  );
});

test("an exact retry recovers a receipt-published crash before reporting success", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "receipt-crash-retry"));
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "receipt_published") process.exit(82); } }
    });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: ${JSON.stringify(proof.operation_id)},
      planFingerprint: ${JSON.stringify(proof.plan_fingerprint)}
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 82, crashed.stderr);

  const result = await store.applyAdoption({
    sourcePath,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });
  assert.equal(result.status, "adopted");
  assert.equal(fs.existsSync(path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("an old adoption proof never hides projection drift, while a fresh proof repairs it", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "projection-drift"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const original = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: original.operation_id,
    planFingerprint: original.plan_fingerprint
  });
  const missing = path.join(fixture.homePath, ".claude", "skills", "projection-drift");
  fs.unlinkSync(missing);

  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: original.operation_id,
      planFingerprint: original.plan_fingerprint
    }),
    (error) => error?.code === "source_changed" || error?.code === "destination_changed"
  );
  const repair = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  const result = await store.applyAdoption({
    sourcePath,
    operationId: repair.operation_id,
    planFingerprint: repair.plan_fingerprint
  });
  assert.equal(result.status, "adopted");
  assert.equal(fs.lstatSync(missing).isSymbolicLink(), true);
});

test("two concurrent identical applies serialize without duplicate publication", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "concurrent-apply"));
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      async checkpoint(name) {
        if (name === "prepared") {
          enteredResolve();
          await release;
        }
      }
    }
  });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  const first = store.applyAdoption({
    sourcePath,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });
  await entered;
  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.code === "store_busy"
  );
  releaseResolve();
  assert.equal((await first).status, "adopted");
  const inventory = await store.inspect();
  assert.equal(inventory.owned.filter(({ name }) => name === "concurrent-apply").length, 1);
  assert.equal(fs.existsSync(path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json")), false);
});

test("competing fingerprints for the same canonical name cannot both publish", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const firstSource = writeSkill(path.join(fixture.sourcesPath, "one", "competing-name"), {
    description: "First reviewed generation."
  });
  const secondSource = writeSkill(path.join(fixture.sourcesPath, "two", "competing-name"), {
    description: "Second reviewed generation."
  });
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const first = await store.previewAdoption({ sourcePath: firstSource });
  const second = await store.previewAdoption({ sourcePath: secondSource });
  assert.notEqual(first.plan_fingerprint, second.plan_fingerprint);
  await store.applyAdoption({
    sourcePath: firstSource,
    operationId: first.operation_id,
    planFingerprint: first.plan_fingerprint
  });
  await assert.rejects(
    () => store.applyAdoption({
      sourcePath: secondSource,
      operationId: second.operation_id,
      planFingerprint: second.plan_fingerprint
    }),
    (error) => ["destination_changed", "source_changed"].includes(error?.code)
  );
  assert.match(
    fs.readFileSync(path.join(fixture.aiosPath, "skills", "competing-name", "SKILL.md"), "utf8"),
    /First reviewed generation/
  );
});

test("remove and reconcile serialize on the one managed-store lock", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "remove-versus-reconcile"));
  const normal = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await normal.previewAdoption({ sourcePath });
  await normal.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await normal.remove({ name: "remove-versus-reconcile" });
  const reconcile = await normal.reconcile();
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const removingStore = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      async checkpoint(name) {
        if (name === "remove_prepared") {
          enteredResolve();
          await release;
        }
      }
    }
  });
  const removing = removingStore.remove({
    name: "remove-versus-reconcile",
    apply: true,
    operationId: removal.operation_id,
    planFingerprint: removal.plan_fingerprint
  });
  await entered;
  await assert.rejects(
    () => normal.reconcile({
      apply: true,
      operationId: reconcile.operation_id,
      planFingerprint: reconcile.plan_fingerprint
    }),
    (error) => error?.code === "store_busy"
  );
  releaseResolve();
  assert.equal((await removing).status, "removed");
});

test("a failure after canonical publication rolls back every proved effect", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "rollback-skill"));
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (name === "canonical_published") throw new Error("injected crash boundary");
      }
    }
  });
  const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  const before = snapshotTree(fixture.root);

  await assert.rejects(
    () => store.applyAdoption({ sourcePath, operationId: proof.operation_id, planFingerprint: proof.plan_fingerprint }),
    /injected crash boundary/
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("rollback cleanup failure retains its recovery tree and transaction journal", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "rollback-cleanup-failure"));
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (name === "canonical_published") throw new Error("trigger rollback");
      },
      beforeRollbackCanonicalCleanup(recovery) {
        fs.writeFileSync(path.join(recovery, "unproved-race.txt"), "UNPROVED_RECOVERY_BYTES\n");
      }
    }
  });
  const proof = await store.previewAdoption({ sourcePath });

  await assert.rejects(
    () => store.applyAdoption({
      sourcePath,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    /trigger rollback/
  );
  const journalPath = path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.state, "needs_attention");
  const recovery = path.join(
    fixture.aiosPath,
    "skills",
    ".managed-skill-store",
    "recovery",
    `${proof.operation_id}-rollback`,
    "rollback-cleanup-failure"
  );
  assert.equal(fs.readFileSync(path.join(recovery, "unproved-race.txt"), "utf8"), "UNPROVED_RECOVERY_BYTES\n");
});

test("rollback retains attention instead of deleting an exact-byte staged-root replacement", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "staged-root-race"));
  let proof;
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (name !== "bundle_staged") return;
        const staged = path.join(
          fixture.aiosPath,
          "skills",
          ".managed-skill-store",
          "staging",
          proof.operation_id,
          "staged-root-race"
        );
        fs.renameSync(staged, path.join(fixture.root, "displaced-proved-stage"));
        fs.cpSync(sourcePath, staged, { recursive: true, preserveTimestamps: true });
        throw new Error("injected staged replacement");
      }
    }
  });
  proof = await store.previewAdoption({ sourcePath });
  await assert.rejects(
    () => store.applyAdoption({ sourcePath, operationId: proof.operation_id, planFingerprint: proof.plan_fingerprint }),
    /injected staged replacement/
  );
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
  assert.equal(fs.existsSync(path.join(
    fixture.aiosPath,
    "skills",
    ".managed-skill-store",
    "staging",
    proof.operation_id,
    "staged-root-race"
  )), true);
});

test("recovery retains a complete stage when its pre-copy root identity evidence is missing", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "stage-evidence-gap"));
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "bundle_staged") process.exit(87); } }
    });
    const proof = await store.previewAdoption({ sourcePath: ${JSON.stringify(sourcePath)} });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 87, crashed.stderr);
  const journalPath = path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.staged_root_identity = null;
  journal.canonical_publish_identity = null;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const stagedBundle = journal.staged_bundle;

  const recovery = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const plan = await recovery.reconcile();
  await assert.rejects(
    () => recovery.reconcile({ apply: true, operationId: plan.operation_id, planFingerprint: plan.plan_fingerprint }),
    (error) => error?.code === "recovery_required"
  );
  assert.equal(fs.lstatSync(stagedBundle).isDirectory(), true);
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).state, "needs_attention");
});

test("re-adoption rollback preserves a pre-existing identical canonical bundle and receipt", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "existing-identical"));
  const normal = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const first = await normal.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await normal.applyAdoption({
    sourcePath,
    operationId: first.operation_id,
    planFingerprint: first.plan_fingerprint
  });
  const fresh = await normal.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  const before = snapshotTree(fixture.root);
  const failing = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (name === "derived_published") throw new Error("injected identical re-adoption failure");
      }
    }
  });

  await assert.rejects(
    () => failing.applyAdoption({
      sourcePath,
      operationId: fresh.operation_id,
      planFingerprint: fresh.plan_fingerprint
    }),
    /injected identical re-adoption failure/
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("a new process recovers an actual process exit after canonical publication", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "process-crash"));
  const before = snapshotTree(fixture.root);
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "canonical_published") process.exit(77); } }
    });
    const proof = await store.previewAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      sourceKind: "local-reviewed-directory"
    });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 77, crashed.stderr);

  const recoveryStore = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const dirtyProof = await recoveryStore.reconcile();
  await assert.rejects(
    () => recoveryStore.reconcile({
      apply: true,
      operationId: dirtyProof.operation_id,
      planFingerprint: dirtyProof.plan_fingerprint
    }),
    (error) => error?.code === "proof_mismatch"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("adoption recovery retains attention when its published canonical root was replaced", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "adoption-root-race"));
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "canonical_published") process.exit(83); } }
    });
    const proof = await store.previewAdoption({ sourcePath: ${JSON.stringify(sourcePath)} });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 83, crashed.stderr);
  const canonical = path.join(fixture.aiosPath, "skills", "adoption-root-race");
  fs.renameSync(canonical, path.join(fixture.root, "displaced-adoption-root"));
  writeSkill(canonical, { description: "Uncooperative replacement root." });

  const recovery = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const plan = await recovery.reconcile();
  await assert.rejects(
    () => recovery.reconcile({
      apply: true,
      operationId: plan.operation_id,
      planFingerprint: plan.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
  );
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
  assert.match(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8"), /Uncooperative replacement root/);
});

test("a new process restores a proved native source moved before its journal completion", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", "source-move-crash"));
  const before = snapshotTree(fixture.root);
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "source_moved_uncommitted") process.exit(78); } }
    });
    const proof = await store.previewAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      sourceKind: "discovered-native-directory"
    });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 78, crashed.stderr);

  const recoveryStore = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const dirtyProof = await recoveryStore.reconcile();
  await assert.rejects(
    () => recoveryStore.reconcile({
      apply: true,
      operationId: dirtyProof.operation_id,
      planFingerprint: dirtyProof.plan_fingerprint
    }),
    (error) => error?.code === "proof_mismatch"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("native projection creation without recorded link evidence retains needs-attention", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", "native-link-crash"));
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "native_projection_created_uncommitted") process.exit(85); } }
    });
    const proof = await store.previewAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      sourceKind: "discovered-native-directory"
    });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 85, crashed.stderr);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const plan = await store.reconcile();
  await assert.rejects(
    () => store.reconcile({ apply: true, operationId: plan.operation_id, planFingerprint: plan.plan_fingerprint }),
    (error) => error?.code === "recovery_required"
  );
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
});

test("an unproved projection-create crash is retained as needs-attention instead of guessed away", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "projection-create-crash"));
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "projection_link_created_uncommitted") process.exit(79); } }
    });
    const proof = await store.previewAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      sourceKind: "local-reviewed-directory"
    });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 79, crashed.stderr);

  const recoveryStore = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const dirtyProof = await recoveryStore.reconcile();
  await assert.rejects(
    () => recoveryStore.reconcile({
      apply: true,
      operationId: dirtyProof.operation_id,
      planFingerprint: dirtyProof.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
  );
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
  assert.equal(fs.existsSync(sourcePath), true);
});

test("a poisoned journal without projection identity evidence cannot authorize unlink", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "poisoned-projection-evidence"));
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "projections_published") process.exit(88); } }
    });
    const proof = await store.previewAdoption({ sourcePath: ${JSON.stringify(sourcePath)} });
    await store.applyAdoption({
      sourcePath: ${JSON.stringify(sourcePath)},
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 88, crashed.stderr);
  const journalPath = path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const created = [...journal.created_projections];
  assert.ok(created.length > 0);
  journal.created_projection_evidence = {};
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

  const recovery = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const plan = await recovery.reconcile();
  await assert.rejects(
    () => recovery.reconcile({ apply: true, operationId: plan.operation_id, planFingerprint: plan.plan_fingerprint }),
    (error) => error?.code === "unsafe_state"
  );
  for (const projection of created) assert.equal(fs.lstatSync(projection).isSymbolicLink(), true);
  assert.equal(fs.existsSync(journalPath), true);
});

for (const checkpoint of ["projection_detached_uncommitted", "canonical_moved_uncommitted"]) {
  test(`a new process recovers removal after ${checkpoint}`, async (t) => {
    const fixture = createManagedSkillFixture(t);
    const sourcePath = writeSkill(path.join(fixture.sourcesPath, `remove-${checkpoint.replaceAll("_", "-")}`));
    const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
    const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
    await store.applyAdoption({
      sourcePath,
      operationId: adoption.operation_id,
      planFingerprint: adoption.plan_fingerprint
    });
    const removal = await store.remove({ name: path.basename(sourcePath) });
    const before = snapshotTree(fixture.root);
    const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
    const script = `
      const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
      const store = createManagedSkillStore({
        aiosPath: ${JSON.stringify(fixture.aiosPath)},
        homePath: ${JSON.stringify(fixture.homePath)},
        hooks: { checkpoint(name) { if (name === ${JSON.stringify(checkpoint)}) process.exit(80); } }
      });
      await store.remove({
        name: ${JSON.stringify(path.basename(sourcePath))},
        apply: true,
        operationId: ${JSON.stringify(removal.operation_id)},
        planFingerprint: ${JSON.stringify(removal.plan_fingerprint)}
      });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(crashed.status, 80, crashed.stderr);

    const recoveryStore = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
    const dirtyProof = await recoveryStore.reconcile();
    await assert.rejects(
      () => recoveryStore.reconcile({
        apply: true,
        operationId: dirtyProof.operation_id,
        planFingerprint: dirtyProof.plan_fingerprint
      }),
      (error) => error?.code === "proof_mismatch"
    );
    assert.deepEqual(snapshotTree(fixture.root), before);
  });
}

test("removal recovery retains attention when both proved canonical coordinates disappear", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "removal-missing-root"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await store.remove({ name: "removal-missing-root" });
  const moduleUrl = new URL("../../packages/core/src/managed-skill-store.mjs", import.meta.url).href;
  const script = `
    const { createManagedSkillStore } = await import(${JSON.stringify(moduleUrl)});
    const store = createManagedSkillStore({
      aiosPath: ${JSON.stringify(fixture.aiosPath)},
      homePath: ${JSON.stringify(fixture.homePath)},
      hooks: { checkpoint(name) { if (name === "canonical_moved_uncommitted") process.exit(84); } }
    });
    await store.remove({
      name: "removal-missing-root",
      apply: true,
      operationId: ${JSON.stringify(removal.operation_id)},
      planFingerprint: ${JSON.stringify(removal.plan_fingerprint)}
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(crashed.status, 84, crashed.stderr);
  const journalPath = path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  fs.renameSync(journal.archive, path.join(fixture.root, "uncooperative-displaced-archive"));

  const plan = await store.reconcile();
  await assert.rejects(
    () => store.reconcile({ apply: true, operationId: plan.operation_id, planFingerprint: plan.plan_fingerprint }),
    (error) => error?.code === "recovery_required"
  );
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).state, "needs_attention");
  assert.equal(fs.existsSync(path.join(fixture.root, "uncooperative-displaced-archive")), true);
});

test("removal retains a verified recovery tree and refuses commit when the live path is recreated", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "removal-race"));
  const normalStore = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await normalStore.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await normalStore.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await normalStore.remove({ name: "removal-race" });
  const canonicalPath = path.join(fixture.aiosPath, "skills", "removal-race");
  const racedStore = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (name === "canonical_archived") writeSkill(canonicalPath, { description: "Uncooperative new generation." });
      }
    }
  });

  await assert.rejects(
    () => racedStore.remove({
      name: "removal-race",
      apply: true,
      operationId: removal.operation_id,
      planFingerprint: removal.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
  );
  assert.match(fs.readFileSync(path.join(canonicalPath, "SKILL.md"), "utf8"), /Uncooperative new generation/);
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
  assert.equal(fs.existsSync(journal.archive), true);
});

test("removal preserves a late archive collision instead of overwriting it", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "archive-collision"));
  let collide = false;
  let collisionPath;
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name, journal) {
        if (!collide || name !== "projections_detached") return;
        collisionPath = journal.archive;
        fs.mkdirSync(collisionPath);
        fs.writeFileSync(path.join(collisionPath, "foreign.txt"), "preserve collision\n");
      }
    }
  });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await store.remove({ name: "archive-collision" });
  collide = true;

  await assert.rejects(
    () => store.remove({
      name: "archive-collision",
      apply: true,
      operationId: removal.operation_id,
      planFingerprint: removal.plan_fingerprint
    }),
    (error) => ["destination_changed", "recovery_required"].includes(error?.code)
  );
  assert.equal(fs.readFileSync(path.join(collisionPath, "foreign.txt"), "utf8"), "preserve collision\n");
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, "skills", "archive-collision", "SKILL.md")), true);
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
});

test("removal never commits a canonical recreation at the receipt tombstone boundary", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "tombstone-race"));
  const canonicalPath = path.join(fixture.aiosPath, "skills", "tombstone-race");
  let race = false;
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (!race || name !== "receipt_tombstoned") return;
        writeSkill(canonicalPath, {
          description: "Uncooperative post-tombstone generation.",
          files: { "foreign.txt": "preserve post-tombstone bytes\n" }
        });
      }
    }
  });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await store.remove({ name: "tombstone-race" });
  race = true;

  await assert.rejects(
    () => store.remove({
      name: "tombstone-race",
      apply: true,
      operationId: removal.operation_id,
      planFingerprint: removal.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
  );
  assert.equal(fs.readFileSync(path.join(canonicalPath, "foreign.txt"), "utf8"), "preserve post-tombstone bytes\n");
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
  assert.equal(journal.receipt.name, "tombstone-race");
});

test("removal does not publish recovery after a valid archive mutation at cleanup_started", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "cleanup-archive-race"));
  let race = false;
  let archivePath;
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name, journal) {
        if (!race || name !== "cleanup_started") return;
        archivePath = journal.archive;
        fs.writeFileSync(
          path.join(archivePath, "SKILL.md"),
          "---\nname: cleanup-archive-race\ndescription: Raced but valid bundle.\n---\n# foreign archive generation\n"
        );
      }
    }
  });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await store.remove({ name: "cleanup-archive-race" });
  race = true;

  await assert.rejects(
    () => store.remove({
      name: "cleanup-archive-race",
      apply: true,
      operationId: removal.operation_id,
      planFingerprint: removal.plan_fingerprint
    }),
    (error) => error?.code === "recovery_required"
  );
  const journal = JSON.parse(fs.readFileSync(
    path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json"),
    "utf8"
  ));
  assert.equal(journal.state, "needs_attention");
  assert.match(fs.readFileSync(path.join(archivePath, "SKILL.md"), "utf8"), /foreign archive generation/);
  assert.equal(fs.existsSync(path.join(
    fixture.homePath,
    ".dotaios",
    "managed-skills",
    "recovery",
    `${removal.operation_id}.json`
  )), false);
});

test("removal refuses a drifted canonical bundle and preserves every extra byte", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "drifted-remove"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const canonicalPath = path.join(fixture.aiosPath, "skills", "drifted-remove");
  fs.writeFileSync(path.join(canonicalPath, "user-extra.txt"), "UNPROVED_BYTES_MUST_SURVIVE\n");
  const before = snapshotTree(fixture.root);

  await assert.rejects(
    () => store.remove({ name: "drifted-remove" }),
    (error) => error?.code === "unproved_removal"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("removal refuses an exact-byte canonical root replacement with a stale receipt identity", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "stale-root"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const canonicalPath = path.join(fixture.aiosPath, "skills", "stale-root");
  const displacedPath = path.join(fixture.aiosPath, "skills", ".stale-root-user-moved");
  fs.renameSync(canonicalPath, displacedPath);
  fs.cpSync(sourcePath, canonicalPath, { recursive: true, preserveTimestamps: true });
  const before = snapshotTree(fixture.root);

  await assert.rejects(
    () => store.remove({ name: "stale-root" }),
    (error) => error?.code === "unproved_removal" && error?.reason === "canonical_identity_changed"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("a removal publication failure restores a proved native source transaction exactly", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const nativePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", "remove-rollback"));
  let failRemoval = false;
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (failRemoval && name === "portable_inventory_published") {
          throw new Error("injected removal publication failure");
        }
      }
    }
  });
  const adoption = await store.previewAdoption({
    sourcePath: nativePath,
    sourceKind: "discovered-native-directory"
  });
  await store.applyAdoption({
    sourcePath: nativePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const before = snapshotTree(fixture.root);
  const removal = await store.remove({ name: "remove-rollback" });
  failRemoval = true;

  await assert.rejects(
    () => store.remove({
      name: "remove-rollback",
      apply: true,
      operationId: removal.operation_id,
      planFingerprint: removal.plan_fingerprint
    }),
    /injected removal publication failure/
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

for (const checkpoint of [
  "projections_detached",
  "canonical_archived",
  "archive_verified",
  "source_restored",
  "receipt_tombstoned",
  "remove_committed"
]) {
  test(`removal rolls back an injected ${checkpoint} failure exactly`, async (t) => {
    const fixture = createManagedSkillFixture(t);
    const skillName = `remove-${checkpoint.replaceAll("_", "-")}`;
    const nativePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", skillName));
    let failRemoval = false;
    const store = createManagedSkillStore({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      hooks: {
        checkpoint(name) {
          if (failRemoval && name === checkpoint) throw new Error(`injected:${checkpoint}`);
        }
      }
    });
    const adoption = await store.previewAdoption({
      sourcePath: nativePath,
      sourceKind: "discovered-native-directory"
    });
    await store.applyAdoption({
      sourcePath: nativePath,
      operationId: adoption.operation_id,
      planFingerprint: adoption.plan_fingerprint
    });
    const before = snapshotTree(fixture.root);
    const removal = await store.remove({ name: skillName });
    failRemoval = true;

    await assert.rejects(
      () => store.remove({
        name: skillName,
        apply: true,
        operationId: removal.operation_id,
        planFingerprint: removal.plan_fingerprint
      }),
      new RegExp(`injected:${checkpoint}`)
    );
    assert.deepEqual(snapshotTree(fixture.root), before);
  });
}

test("recovery forward-completes a removal that durably reached cleanup_completed", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "cleanup-completed"));
  let failCleanup = false;
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (failCleanup && name === "cleanup_completed") throw new Error("injected:cleanup_completed");
      }
    }
  });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await store.remove({ name: "cleanup-completed" });
  failCleanup = true;
  await assert.rejects(
    () => store.remove({
      name: "cleanup-completed",
      apply: true,
      operationId: removal.operation_id,
      planFingerprint: removal.plan_fingerprint
    }),
    /injected:cleanup_completed/
  );
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, "skills", "cleanup-completed")), false);
  assert.equal(fs.existsSync(path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json")), true);

  failCleanup = false;
  const reconcile = await store.reconcile();
  await store.reconcile({
    apply: true,
    operationId: reconcile.operation_id,
    planFingerprint: reconcile.plan_fingerprint
  });
  assert.equal(fs.existsSync(path.join(fixture.homePath, ".dotaios", "managed-skills", "transaction.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, "skills", "cleanup-completed")), false);
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, ".dotaios", "managed-skills", "receipts", "cleanup-completed.json")), false);
});

test("a forged registry row cannot authorize removal without a strict local receipt", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "foreign-owned"));
  fs.writeFileSync(
    path.join(fixture.aiosPath, "skills", "_registry.json"),
    `${JSON.stringify({
      format: "dotaios-skill-install-inventory/v2",
      skills: ["foreign-owned"],
      managed: [{ name: "foreign-owned", bundle_digest: "sha256:forged" }],
      plugins: []
    })}\n`
  );
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  await assert.rejects(
    () => store.remove({ name: "foreign-owned" }),
    (error) => error?.code === "unproved_removal"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);

  const reconcile = await store.reconcile();
  await store.reconcile({
    apply: true,
    operationId: reconcile.operation_id,
    planFingerprint: reconcile.plan_fingerprint
  });
  const normalized = JSON.parse(fs.readFileSync(
    path.join(fixture.aiosPath, "skills", "_registry.json"),
    "utf8"
  ));
  assert.deepEqual(normalized.managed, []);
});

test("recovery rejects forged journal coordinates before unlinking any path", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "journal-guard"));
  const victim = path.join(fixture.root, "outside-victim-link");
  fs.symlinkSync(path.join(fixture.aiosPath, "skills", "journal-guard"), victim, "dir");
  const stateRoot = path.join(fixture.homePath, ".dotaios", "managed-skills");
  fs.mkdirSync(path.join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateRoot, "transaction.json"),
    `${JSON.stringify({
      format: "dotaios-managed-skill-transaction/v1",
      kind: "reconcile",
      state: "reconcile_prepared",
      operation_id: "skill-reconcile-0123456789abcdef01234567",
      plan_fingerprint: `sha256:${"0".repeat(64)}`,
      old_artifacts: {},
      created_projections: [victim],
      created_projection_evidence: {},
      created_directories: []
    })}\n`,
    { mode: 0o600 }
  );
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.reconcile();

  await assert.rejects(
    () => store.reconcile({
      apply: true,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.code === "unsafe_state"
  );
  assert.equal(fs.lstatSync(victim).isSymbolicLink(), true);
});

test("removal rejects a forged receipt projection traversal before touching its victim", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "receipt-guard"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const canonical = path.join(fixture.aiosPath, "skills", "receipt-guard");
  const victim = path.join(fixture.root, "outside-receipt-victim");
  fs.symlinkSync(canonical, victim, "dir");
  const receiptPath = path.join(
    fixture.homePath,
    ".dotaios",
    "managed-skills",
    "receipts",
    "receipt-guard.json"
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.projections[0] = {
    ...receipt.projections[0],
    relative_path: "../outside-receipt-victim",
    identity: null,
    link_target: canonical
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    () => store.remove({ name: "receipt-guard" }),
    (error) => error?.code === "unsafe_state"
  );
  assert.equal(fs.lstatSync(victim).isSymbolicLink(), true);
});

test("removal rejects receipt source kind that no longer binds its saved native directory", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const nativePath = writeSkill(path.join(fixture.homePath, ".agents", "skills", "receipt-source-guard"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({
    sourcePath: nativePath,
    sourceKind: "discovered-native-directory"
  });
  await store.applyAdoption({
    sourcePath: nativePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const receiptPath = path.join(
    fixture.homePath,
    ".dotaios",
    "managed-skills",
    "receipts",
    "receipt-source-guard.json"
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const savedNative = receipt.replaced_source.backup;
  receipt.source.kind = "unsupported-source-kind";
  receipt.replaced_source = null;
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    () => store.remove({ name: "receipt-source-guard" }),
    (error) => error?.code === "unsafe_state"
  );
  assert.equal(fs.lstatSync(savedNative).isDirectory(), true);
});

test("preview bounds portable inventory reads before decoding or allocating untrusted state", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "bounded-registry"));
  fs.writeFileSync(
    path.join(fixture.aiosPath, "skills", "_registry.json"),
    Buffer.alloc(257, 0x20)
  );
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: { maxRegistryBytes: 256 }
  });

  await assert.rejects(
    () => store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.code === "bundle_bound_exceeded"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("store operations refuse a linked or oversized agents.json before projection planning", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "bounded-agents"));
  const outside = path.join(fixture.sourcesPath, "agents.json");
  fs.writeFileSync(outside, `${JSON.stringify({ agents: [] })}\n`);
  const agentsPath = path.join(fixture.aiosPath, "agents.json");
  fs.symlinkSync(outside, agentsPath);
  const beforeLink = snapshotTree(fixture.root);
  const linkedStore = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });

  await assert.rejects(
    () => linkedStore.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.code === "unsafe_state"
  );
  assert.deepEqual(snapshotTree(fixture.root), beforeLink);

  fs.unlinkSync(agentsPath);
  fs.writeFileSync(agentsPath, Buffer.alloc(257, 0x20));
  const beforeLarge = snapshotTree(fixture.root);
  const boundedStore = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: { maxAgentRegistryBytes: 256 }
  });
  await assert.rejects(
    () => boundedStore.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.code === "bundle_bound_exceeded"
  );
  assert.deepEqual(snapshotTree(fixture.root), beforeLarge);
});

test("agents.json field and skills-by-target projection facts are bounded before expansion", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "bounded-agent-fields"));
  fs.writeFileSync(path.join(fixture.aiosPath, "agents.json"), `${JSON.stringify({
    agents: [{
      name: "x".repeat(65),
      detect: ".custom",
      bridge: null,
      skills: { mode: "symlink", dir: ".custom/skills" }
    }]
  })}\n`);
  const fieldStore = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: { maxAgentFieldBytes: 64 }
  });
  await assert.rejects(
    () => fieldStore.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" }),
    (error) => error?.code === "bundle_bound_exceeded"
  );

  fs.unlinkSync(path.join(fixture.aiosPath, "agents.json"));
  writeSkill(path.join(fixture.aiosPath, "skills", "projection-one"));
  writeSkill(path.join(fixture.aiosPath, "skills", "projection-two"));
  const factStore = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: { maxProjectionFacts: 1 }
  });
  await assert.rejects(
    () => factStore.reconcile(),
    (error) => error?.code === "bundle_bound_exceeded"
      && error?.reason === "projection_fact_bound_exceeded"
  );
});

test("removal bounds owned receipts before parsing them as authority", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "bounded-receipt"));
  const receipts = path.join(fixture.homePath, ".dotaios", "managed-skills", "receipts");
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(receipts, "bounded-receipt.json");
  fs.writeFileSync(receiptPath, Buffer.alloc(257, 0x20), { mode: 0o600 });
  const before = snapshotTree(fixture.root);
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: { maxReceiptBytes: 256 }
  });

  await assert.rejects(
    () => store.remove({ name: "bounded-receipt" }),
    (error) => error?.code === "bundle_bound_exceeded"
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

test("recovery bounds the owned transaction journal before parsing it", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "bounded-journal"));
  const stateRoot = path.join(fixture.homePath, ".dotaios", "managed-skills");
  fs.mkdirSync(path.join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
  const journalPath = path.join(stateRoot, "transaction.json");
  fs.writeFileSync(journalPath, Buffer.alloc(257, 0x20), { mode: 0o600 });
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: { maxJournalBytes: 256 }
  });
  const proof = await store.reconcile();

  await assert.rejects(
    () => store.reconcile({
      apply: true,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    (error) => error?.code === "bundle_bound_exceeded"
  );
  assert.deepEqual(fs.readFileSync(journalPath), Buffer.alloc(257, 0x20));
});

test("preview refuses file, total, entry, depth, and path bound excess without writes", async (t) => {
  const scenarios = [
    {
      name: "file-bound",
      files: { "asset.bin": Buffer.alloc(513, 0xa1) },
      limits: { maxFileBytes: 512, maxTotalBytes: 2048 }
    },
    {
      name: "total-bound",
      files: { "a.bin": Buffer.alloc(160, 0xa2), "b.bin": Buffer.alloc(160, 0xa3) },
      limits: { maxFileBytes: 512, maxTotalBytes: 350 }
    },
    {
      name: "entry-bound",
      files: { "a.txt": Buffer.from("a"), "b.txt": Buffer.from("b") },
      limits: { maxEntries: 2 }
    },
    {
      name: "depth-bound",
      files: { "a/b/c.txt": Buffer.from("deep") },
      limits: { maxDepth: 1 }
    },
    {
      name: "path-bound",
      files: { "this-relative-path-is-too-long.bin": Buffer.from("long") },
      limits: { maxRelativePathBytes: 20 }
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const fixture = createManagedSkillFixture(subtest);
      const sourcePath = writeSkill(path.join(fixture.sourcesPath, scenario.name), {
        files: scenario.files
      });
      const before = snapshotTree(fixture.root);
      const store = createManagedSkillStore({
        aiosPath: fixture.aiosPath,
        homePath: fixture.homePath,
        limits: scenario.limits
      });
      await assert.rejects(
        () => store.previewAdoption({ sourcePath }),
        (error) => error?.code === "bundle_bound_exceeded"
      );
      assert.deepEqual(snapshotTree(fixture.root), before);
    });
  }
});

test("configured bundle limits remain authoritative through adoption and exact removal", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "raised-limit"), {
    files: { "assets/large.bin": Buffer.alloc(1024 * 1024 + 1, 0xa5) }
  });
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    limits: {
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 3 * 1024 * 1024
    }
  });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const removal = await store.remove({ name: "raised-limit" });
  const result = await store.remove({
    name: "raised-limit",
    apply: true,
    operationId: removal.operation_id,
    planFingerprint: removal.plan_fingerprint
  });

  assert.equal(result.status, "removed");
  assert.equal(fs.existsSync(path.join(fixture.aiosPath, "skills", "raised-limit")), false);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(result.recovery_record), true);
  const inventory = await store.inspect();
  assert.deepEqual(inventory.retained_recovery.map(({ name }) => name), ["raised-limit"]);
  fs.renameSync(inventory.retained_recovery[0].archive, path.join(fixture.root, "moved-retained-archive"));
  await assert.rejects(
    () => store.inspect(),
    (error) => error?.code === "unsafe_state" && error?.reason === "stale_recovery_record"
  );
});

test("reconcile repairs only absent projections and reports a foreign collision unchanged", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "owned-one"));
  const foreign = writeSkill(path.join(fixture.homePath, ".agents", "skills", "owned-one"), {
    description: "Foreign collision must survive."
  });
  const beforeForeign = snapshotTree(foreign);
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const proof = await store.reconcile();
  assert.ok(proof.unresolved.some(({ relative_path }) => relative_path === ".agents/skills/owned-one"));
  assert.ok(proof.repairs.some(({ relative_path }) => relative_path === ".claude/skills/owned-one"));

  const result = await store.reconcile({
    apply: true,
    operationId: proof.operation_id,
    planFingerprint: proof.plan_fingerprint
  });
  assert.equal(result.status, "reconciled");
  assert.deepEqual(snapshotTree(foreign), beforeForeign);
  assert.equal(fs.lstatSync(path.join(fixture.homePath, ".claude", "skills", "owned-one")).isSymbolicLink(), true);
});

test("reconcile rebuilds portable provenance only from an exact receipt and canonical pair", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "receipt-backed-registry"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const registryPath = path.join(fixture.aiosPath, "skills", "_registry.json");
  fs.writeFileSync(registryPath, `${JSON.stringify({
    format: "dotaios-skill-install-inventory/v2",
    skills: ["receipt-backed-registry"],
    managed: [],
    plugins: []
  }, null, 2)}\n`);

  const rebuild = await store.reconcile();
  await store.reconcile({
    apply: true,
    operationId: rebuild.operation_id,
    planFingerprint: rebuild.plan_fingerprint
  });
  let registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.deepEqual(registry.managed.map(({ name }) => name), ["receipt-backed-registry"]);

  fs.writeFileSync(
    path.join(fixture.aiosPath, "skills", "receipt-backed-registry", "unproved.txt"),
    "CANONICAL_DRIFT\n"
  );
  const drift = await store.reconcile();
  await store.reconcile({
    apply: true,
    operationId: drift.operation_id,
    planFingerprint: drift.plan_fingerprint
  });
  registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.deepEqual(registry.managed, []);
});

test("a newly configured custom projection can reconcile and participate in exact removal", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "custom-target-lifecycle"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  fs.writeFileSync(path.join(fixture.aiosPath, "agents.json"), `${JSON.stringify({
    agents: [{
      name: "Custom Runner",
      detect: ".custom-runner",
      bridge: null,
      skills: { mode: "symlink", dir: ".custom/skills" }
    }]
  }, null, 2)}\n`);

  const reconcile = await store.reconcile();
  await store.reconcile({
    apply: true,
    operationId: reconcile.operation_id,
    planFingerprint: reconcile.plan_fingerprint
  });
  const custom = path.join(fixture.homePath, ".custom", "skills", "custom-target-lifecycle");
  assert.equal(fs.lstatSync(custom).isSymbolicLink(), true);

  const removal = await store.remove({ name: "custom-target-lifecycle" });
  await store.remove({
    name: "custom-target-lifecycle",
    apply: true,
    operationId: removal.operation_id,
    planFingerprint: removal.plan_fingerprint
  });
  assert.throws(() => fs.lstatSync(custom), { code: "ENOENT" });
});

test("a reconciled target removed from configuration requires a future retirement proof", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "retired-custom-target"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const agentsPath = path.join(fixture.aiosPath, "agents.json");
  fs.writeFileSync(agentsPath, `${JSON.stringify({
    agents: [{
      name: "Custom Runner",
      detect: ".custom-runner",
      bridge: null,
      skills: { mode: "symlink", dir: ".custom/skills" }
    }]
  }, null, 2)}\n`);
  const reconcile = await store.reconcile();
  await store.reconcile({
    apply: true,
    operationId: reconcile.operation_id,
    planFingerprint: reconcile.plan_fingerprint
  });
  const custom = path.join(fixture.homePath, ".custom", "skills", "retired-custom-target");
  assert.equal(fs.lstatSync(custom).isSymbolicLink(), true);
  fs.unlinkSync(agentsPath);

  await assert.rejects(
    () => store.remove({ name: "retired-custom-target" }),
    (error) => error?.code === "unproved_removal"
      && error?.reason === "retired_projection_target_requires_explicit_proof"
  );
  assert.equal(fs.lstatSync(custom).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(fixture.aiosPath, "skills", "retired-custom-target")).isDirectory(), true);
});

test("reconcile records an already-exact newly configured target for conservative retirement", async (t) => {
  const fixture = createManagedSkillFixture(t);
  const sourcePath = writeSkill(path.join(fixture.sourcesPath, "preexisting-custom-target"));
  const store = createManagedSkillStore({ aiosPath: fixture.aiosPath, homePath: fixture.homePath });
  const adoption = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
  await store.applyAdoption({
    sourcePath,
    operationId: adoption.operation_id,
    planFingerprint: adoption.plan_fingerprint
  });
  const agentsPath = path.join(fixture.aiosPath, "agents.json");
  fs.writeFileSync(agentsPath, `${JSON.stringify({
    agents: [{
      name: "Custom Runner",
      detect: ".custom-runner",
      bridge: null,
      skills: { mode: "symlink", dir: ".custom/skills" }
    }]
  }, null, 2)}\n`);
  const custom = path.join(fixture.homePath, ".custom", "skills", "preexisting-custom-target");
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.symlinkSync(path.join(fixture.aiosPath, "skills", "preexisting-custom-target"), custom);

  const reconcile = await store.reconcile();
  assert.equal(reconcile.repairs.some(({ kind }) => kind === "projection"), false);
  await store.reconcile({
    apply: true,
    operationId: reconcile.operation_id,
    planFingerprint: reconcile.plan_fingerprint
  });
  fs.unlinkSync(agentsPath);

  await assert.rejects(
    () => store.remove({ name: "preexisting-custom-target" }),
    (error) => error?.code === "unproved_removal"
      && error?.reason === "retired_projection_target_requires_explicit_proof"
  );
  assert.equal(fs.lstatSync(custom).isSymbolicLink(), true);
});

test("reconcile rolls back catalogs and operation-owned projections on publication failure", async (t) => {
  const fixture = createManagedSkillFixture(t);
  writeSkill(path.join(fixture.aiosPath, "skills", "reconcile-rollback"));
  const store = createManagedSkillStore({
    aiosPath: fixture.aiosPath,
    homePath: fixture.homePath,
    hooks: {
      checkpoint(name) {
        if (name === "reconcile_projection_published") throw new Error("injected reconcile failure");
      }
    }
  });
  const proof = await store.reconcile();
  const before = snapshotTree(fixture.root);

  await assert.rejects(
    () => store.reconcile({
      apply: true,
      operationId: proof.operation_id,
      planFingerprint: proof.plan_fingerprint
    }),
    /injected reconcile failure/
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
});

for (const checkpoint of [
  "prepared",
  "bundle_durable",
  "bundle_staged",
  "canonical_published",
  "projections_published",
  "portable_inventory_published",
  "index_catalog_published",
  "resolver_catalog_published",
  "derived_published",
  "receipt_published"
]) {
  test(`adoption rolls back an injected ${checkpoint} failure`, async (t) => {
    const fixture = createManagedSkillFixture(t);
    const sourcePath = writeSkill(path.join(fixture.sourcesPath, `crash-${checkpoint.replaceAll("_", "-")}`));
    const store = createManagedSkillStore({
      aiosPath: fixture.aiosPath,
      homePath: fixture.homePath,
      hooks: {
        checkpoint(name) {
          if (name === checkpoint) throw new Error(`injected:${checkpoint}`);
        }
      }
    });
    const proof = await store.previewAdoption({ sourcePath, sourceKind: "local-reviewed-directory" });
    const before = snapshotTree(fixture.root);
    await assert.rejects(
      () => store.applyAdoption({ sourcePath, operationId: proof.operation_id, planFingerprint: proof.plan_fingerprint }),
      new RegExp(`injected:${checkpoint}`)
    );
    assert.deepEqual(snapshotTree(fixture.root), before);
  });
}
