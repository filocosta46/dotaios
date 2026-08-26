import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// `dotaios mcp` was registered, worked, and was named in README's own
// instructions — but `dotaios --help` never listed it, so the only way to
// discover it was to read the source or stumble on that README line. A command
// the CLI will run is a command the CLI should admit to having.
test("every dispatchable command appears in --help", async () => {
  const source = await fs.readFile(cli, "utf8");

  const registered = [...source.matchAll(/^\s+"?([a-z][\w-]*)"?:\s*"\.\/commands\//gm)].map((m) => m[1]);
  assert.ok(registered.length > 20, `expected the command table, found ${registered.length} entries`);

  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);

  const missing = registered.filter((command) => !new RegExp(`^\\s+${command}\\b`, "m").test(help.stdout));
  assert.deepEqual(missing, [], `commands missing from --help: ${missing.join(", ")}`);
});

test("help distinguishes memory updates from managed scaffold upgrades", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^\s+update \[text\].*memory$/m);
  assert.match(help.stdout, /^\s+upgrade\s+.*managed scaffold.*no memory.*no sync$/mi);

  const upgrade = spawnSync(process.execPath, [cli, "upgrade", "--help"], { encoding: "utf8" });
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.match(upgrade.stdout, /preview is the default and writes nothing/i);
  assert.match(upgrade.stdout, /does not change user memory and does not sync/i);
  assert.match(upgrade.stdout, /different from `dotaios update \[text\]`/i);
});
