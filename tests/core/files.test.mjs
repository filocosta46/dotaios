import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSafe, writeFileSafe } from "../../packages/core/src/files.mjs";

test("writeFileSafe atomically overwrites an ordinary file and preserves its mode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-files-"));
  const destination = path.join(root, "generated.md");
  fs.writeFileSync(destination, "before\n", { mode: 0o640 });
  fs.chmodSync(destination, 0o640);

  const result = await writeFileSafe(destination, "after\n", "overwrite");

  assert.equal(result.action, "updated");
  assert.equal(fs.readFileSync(destination, "utf8"), "after\n");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(root), ["generated.md"]);
});

test("copyFileSafe atomically overwrites an ordinary file and preserves its mode", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode semantics");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-copy-mode-"));
  const source = path.join(root, "source.md");
  const destination = path.join(root, "generated.md");
  fs.writeFileSync(source, "after\n", { mode: 0o600 });
  fs.writeFileSync(destination, "before\n", { mode: 0o640 });
  fs.chmodSync(source, 0o600);
  fs.chmodSync(destination, 0o640);

  const result = await copyFileSafe(source, destination, "overwrite");

  assert.equal(result.action, "updated");
  assert.equal(fs.readFileSync(destination, "utf8"), "after\n");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(root).sort(), ["generated.md", "source.md"]);
});

test("writeFileSafe never follows an overwrite destination symlink", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-files-link-"));
  const outside = path.join(root, "outside.md");
  const destination = path.join(root, "generated.md");
  fs.writeFileSync(outside, "external bytes\n");
  fs.symlinkSync(outside, destination);

  await assert.rejects(
    writeFileSafe(destination, "replacement\n", "overwrite"),
    /unsafe file destination/i
  );

  assert.equal(fs.readFileSync(outside, "utf8"), "external bytes\n");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(root).sort(), ["generated.md", "outside.md"]);
});

test("writeFileSafe never accepts a preserve destination symlink", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-files-preserve-link-"));
  const outside = path.join(root, "outside.md");
  const destination = path.join(root, "generated.md");
  fs.writeFileSync(outside, "external bytes\n");
  fs.symlinkSync(outside, destination);

  await assert.rejects(
    writeFileSafe(destination, "replacement\n", "preserve"),
    /unsafe file destination/i
  );

  assert.equal(fs.readFileSync(outside, "utf8"), "external bytes\n");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});

test("copyFileSafe never follows an overwrite destination symlink", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-copy-link-"));
  const source = path.join(root, "source.md");
  const outside = path.join(root, "outside.md");
  const destination = path.join(root, "generated.md");
  fs.writeFileSync(source, "source bytes\n");
  fs.writeFileSync(outside, "external bytes\n");
  fs.symlinkSync(outside, destination);

  await assert.rejects(
    copyFileSafe(source, destination, "overwrite"),
    /unsafe file destination/i
  );

  assert.equal(fs.readFileSync(outside, "utf8"), "external bytes\n");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});

test("copyFileSafe never accepts a preserve destination symlink", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions are platform-specific");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-copy-preserve-link-"));
  const source = path.join(root, "source.md");
  const outside = path.join(root, "outside.md");
  const destination = path.join(root, "generated.md");
  fs.writeFileSync(source, "source bytes\n");
  fs.writeFileSync(outside, "external bytes\n");
  fs.symlinkSync(outside, destination);

  await assert.rejects(
    copyFileSafe(source, destination, "preserve"),
    /unsafe file destination/i
  );

  assert.equal(fs.readFileSync(outside, "utf8"), "external bytes\n");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});

test("writeFileSafe preserve publishes exactly one complete concurrent winner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-files-preserve-race-"));
  const destination = path.join(root, "generated.md");
  const contents = Array.from({ length: 32 }, (_, index) =>
    `writer-${index}:` + `${index}`.repeat(4096) + "\n"
  );

  const results = await Promise.all(
    contents.map((content) => writeFileSafe(destination, content, "preserve"))
  );

  assert.equal(results.filter((result) => result.action === "created").length, 1);
  assert.equal(results.filter((result) => result.action === "kept").length, contents.length - 1);
  assert.ok(contents.includes(fs.readFileSync(destination, "utf8")), "the winner must be one complete staged payload");
  assert.deepEqual(fs.readdirSync(root), ["generated.md"], "all private staging names must be removed");
});

test("copyFileSafe preserve publishes exactly one complete concurrent winner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-copy-preserve-race-"));
  const destination = path.join(root, "generated.md");
  const sources = Array.from({ length: 16 }, (_, index) => {
    const source = path.join(root, `source-${index}.md`);
    fs.writeFileSync(source, `source-${index}:` + `${index}`.repeat(4096) + "\n");
    return source;
  });

  const results = await Promise.all(
    sources.map((source) => copyFileSafe(source, destination, "preserve"))
  );

  assert.equal(results.filter((result) => result.action === "created").length, 1);
  assert.equal(results.filter((result) => result.action === "kept").length, sources.length - 1);
  const sourcePayloads = sources.map((source) => fs.readFileSync(source, "utf8"));
  assert.ok(sourcePayloads.includes(fs.readFileSync(destination, "utf8")), "the winner must be one complete staged source");
  assert.equal(
    fs.readdirSync(root).filter((entry) => entry.includes(".dotaios-")).length,
    0,
    "all private staging names must be removed"
  );
});

test("writeFileSafe preserve rejects an unsafe destination that wins publication", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-files-unsafe-race-"));
  const destination = path.join(root, "generated.md");

  const pending = writeFileSafe(destination, "generated bytes\n", "preserve");
  fs.mkdirSync(destination);

  await assert.rejects(pending, /unsafe file destination/i);
  assert.equal(fs.lstatSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(destination), []);
  assert.equal(
    fs.readdirSync(root).filter((entry) => entry.includes(".dotaios-")).length,
    0,
    "the rejected staged file must be removed"
  );
});
