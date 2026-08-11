import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("CLI search leaves corrupt JSONL byte- and metadata-unchanged", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-search-safety-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);

  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    `{not-json}\n${JSON.stringify({
      ts: "2026-08-10T10:00:00.000Z",
      type: "note",
      summary: "CLI_CORRUPT_SEARCH_CANARY"
    })}\n`
  );
  const before = snapshotTree(aiosPath);

  const result = run([
    "search",
    "CLI_CORRUPT_SEARCH_CANARY",
    "--scope",
    "memory",
    "--path",
    aiosPath
  ]);

  assert.match(result.stdout, /CLI_CORRUPT_SEARCH_CANARY/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, escaped(aiosPath));
  assert.equal(fs.existsSync(`${eventsPath}.bad.jsonl`), false);
  assert.deepEqual(snapshotTree(aiosPath), before);
});

test("CLI search refuses a linked aios.json before authorizing an external vault", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-search-config-"));
  const aiosPath = path.join(tempRoot, "aios");
  const outside = path.join(tempRoot, "outside");
  const outsideConfig = path.join(tempRoot, "outside-config.json");
  run(["init", "--path", aiosPath, "--yes"]);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "# Outside\n\nOUTSIDE_VAULT_CANARY\n");
  fs.writeFileSync(outsideConfig, `${JSON.stringify({ vault_path: outside })}\n`);
  fs.unlinkSync(path.join(aiosPath, "aios.json"));
  fs.symlinkSync(outsideConfig, path.join(aiosPath, "aios.json"));

  const before = snapshotTree(tempRoot);
  const result = spawnSync(process.execPath, [
    cli,
    "search",
    "OUTSIDE_VAULT_CANARY",
    "--scope",
    "vault",
    "--path",
    aiosPath
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /OUTSIDE_VAULT_CANARY/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, escaped(outside));
  assert.deepEqual(snapshotTree(tempRoot), before);
});

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function snapshotTree(root) {
  const snapshot = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    const stats = fs.lstatSync(absolute);
    snapshot.push([entry.name, entry.isDirectory() ? "directory" : "file", stats.mtimeMs]);
    if (entry.isDirectory()) {
      for (const nested of snapshotTree(absolute)) {
        snapshot.push([path.posix.join(entry.name, nested[0]), ...nested.slice(1)]);
      }
    } else if (entry.isFile()) {
      snapshot.at(-1).push(fs.readFileSync(absolute).toString("base64"));
    } else if (entry.isSymbolicLink()) {
      snapshot.at(-1).push(fs.readlinkSync(absolute));
    }
  }
  return snapshot;
}

function escaped(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
