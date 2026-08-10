import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { searchAios, searchMarkdownDir } from "../../packages/core/src/search.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-search-safety-"));
}

test("search rejects linked eligible files instead of following or silently omitting them", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  const outside = path.join(root, "outside.md");
  fs.mkdirSync(context);
  fs.writeFileSync(outside, "# Outside\n\nOUTSIDE_SEARCH_CANARY\n");
  fs.symlinkSync(outside, path.join(context, "linked.md"));

  await assert.rejects(
    () => searchAios({ aiosPath: root, query: "OUTSIDE_SEARCH_CANARY", scope: "context" }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_PATH_UNSAFE"
  );
});

test("search ignores an irrelevant linked asset while returning eligible Markdown", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  const outsideAsset = path.join(root, "asset.bin");
  fs.mkdirSync(context);
  fs.writeFileSync(path.join(context, "safe.md"), "# Safe\n\nSAFE_SEARCH_CANARY\n");
  fs.writeFileSync(outsideAsset, "IRRELEVANT_ASSET_CANARY\n");
  fs.symlinkSync(outsideAsset, path.join(context, "asset.png"));

  const [group] = await searchAios({
    aiosPath: root,
    query: "SAFE_SEARCH_CANARY",
    scope: "context"
  });

  assert.equal(group.results.length, 1);
  assert.equal(group.results[0].file, "safe.md");
});

test("search never traverses an ineligible linked directory", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  const outsideDirectory = path.join(root, "outside-directory");
  fs.mkdirSync(context);
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(context, "safe.md"), "# Safe\n\nSAFE_DIRECTORY_SEARCH_CANARY\n");
  fs.writeFileSync(path.join(outsideDirectory, "secret.md"), "OUTSIDE_DIRECTORY_CANARY\n");
  fs.symlinkSync(outsideDirectory, path.join(context, "linked-directory"));

  const [safeGroup] = await searchAios({
    aiosPath: root,
    query: "SAFE_DIRECTORY_SEARCH_CANARY",
    scope: "context"
  });
  const [outsideGroup] = await searchAios({
    aiosPath: root,
    query: "OUTSIDE_DIRECTORY_CANARY",
    scope: "context"
  });

  assert.equal(safeGroup.results.length, 1);
  assert.equal(outsideGroup.results.length, 0);
});

test("search treats a configured external vault as an explicit authorized root", async () => {
  const tempRoot = tmpDir();
  const aiosPath = path.join(tempRoot, "aios");
  const vaultPath = path.join(tempRoot, "external-vault");
  fs.mkdirSync(aiosPath);
  fs.mkdirSync(vaultPath);
  fs.writeFileSync(path.join(vaultPath, "note.md"), "# External\n\nAUTHORIZED_VAULT_CANARY\n");

  const [group] = await searchAios({
    aiosPath,
    vaultPath,
    query: "AUTHORIZED_VAULT_CANARY",
    scope: "vault"
  });

  assert.equal(group.scope, "vault");
  assert.equal(group.results[0].file, "note.md");
  assert.equal(group.results[0].source, "vault/note.md");
});

test("search rejects invalid UTF-8 without replacing bytes", async () => {
  const root = tmpDir();
  const filePath = path.join(root, "note.md");
  const bytes = Buffer.from([0x23, 0x20, 0x4e, 0x6f, 0x74, 0x65, 0x0a, 0xff, 0x0a]);
  fs.writeFileSync(filePath, bytes);

  await assert.rejects(
    () => searchMarkdownDir(root, "note"),
    (error) => error?.code === "DOTAIOS_EVIDENCE_INVALID_UTF8"
  );
  assert.deepEqual(fs.readFileSync(filePath), bytes);
});

test("search fails closed on the 513th opened source file", async () => {
  const root = tmpDir();
  const context = path.join(root, "context");
  fs.mkdirSync(context);
  for (let index = 0; index < 513; index += 1) {
    fs.writeFileSync(path.join(context, `${String(index).padStart(3, "0")}.md`), `# Note ${index}\n\nneedle\n`);
  }

  await assert.rejects(
    () => searchAios({ aiosPath: root, query: "needle", scope: "context" }),
    (error) => error?.code === "DOTAIOS_EVIDENCE_BUDGET_EXCEEDED"
  );
});

test("search rejects a special eligible file before opening it", {
  skip: process.platform === "win32" ? "mkfifo is unavailable on Windows" : false
}, async () => {
  const root = tmpDir();
  const fifoPath = path.join(root, "blocked.md");
  const { status } = fs.statSync("/bin/sh").isFile()
    ? await import("node:child_process").then(({ spawnSync }) => spawnSync("mkfifo", [fifoPath]))
    : { status: 1 };
  assert.equal(status, 0);

  await assert.rejects(
    () => searchMarkdownDir(root, "needle"),
    (error) => error?.code === "DOTAIOS_EVIDENCE_NOT_REGULAR_FILE"
  );
});
