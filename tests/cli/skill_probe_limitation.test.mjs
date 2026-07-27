import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// A failing client usually says exactly what is wrong. Reporting only "client
// exceeded 90000ms" throws that away and leaves the user with a receipt they
// cannot act on — the same swallowed-error pattern this release exists to fix.
test("a failing client's own error reaches the receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-probe-"));
  const aios = path.join(root, "aios");
  assert.equal(
    spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios], { encoding: "utf8" }).status,
    0
  );

  // Stand in for the real client, failing the way it actually failed here.
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fake = path.join(fakeBin, "claude");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude Code)"; exit 0; fi',
    'echo "API Error: Usage credits required for 1M context" >&2',
    "exit 1"
  ].join("\n") + "\n");
  fs.chmodSync(fake, 0o755);

  const result = spawnSync(
    process.execPath,
    [cli, "skills", "probe", "--client", "claude-code", "--run", "--json", "--path", aios],
    { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }
  );

  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.evidence.produced, "no", "a failed client is never a pass");
  assert.match(
    `${receipt.limitation || ""}`,
    /Usage credits required/,
    `the client said why it failed; the receipt must carry it:\n${JSON.stringify(receipt, null, 1)}`
  );
});
