import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

// `connect gemini` resolves the bridge from os.homedir() rather than --home, so
// HOME must be overridden to keep the run inside the sandbox.
function connectGemini(sandbox, aiosPath) {
  return spawnSync(process.execPath, [cli, "connect", "gemini", "--path", aiosPath], {
    encoding: "utf8",
    env: { ...process.env, HOME: sandbox }
  });
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-connect-gemini-"));
  const aios = path.join(base, "aios");
  fs.mkdirSync(path.join(base, ".gemini"), { recursive: true });
  const init = spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios, "--home", base], {
    encoding: "utf8"
  });
  assert.equal(init.status, 0, init.stderr);
  return { base, aios, bridge: path.join(base, ".gemini", "GEMINI.md") };
}

// Anyone who has ever asked Gemini to remember a preference already has this
// file. Destroying it contradicts the product's central promise, stated in
// README.md, that it "preserves unmanaged files and stops before replacing
// existing configuration".
test("connect gemini preserves a user-authored GEMINI.md", () => {
  const { base, aios, bridge } = sandbox();
  const authored = "# My own Gemini instructions\n\nAlways answer in Italian.\nMy API notes: keep these.\n";
  fs.writeFileSync(bridge, authored);
  try {
    const result = connectGemini(base, aios);
    assert.equal(result.status, 0, result.stderr);

    const after = fs.readFileSync(bridge, "utf8");
    assert.match(after, /Always answer in Italian/, "user content must survive");
    assert.match(after, /My API notes: keep these/, "user content must survive");
    assert.match(after, /<!-- dotaios-managed:start -->/, "DotAIOS content belongs in a marked block");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini is idempotent and does not stack blocks", () => {
  const { base, aios, bridge } = sandbox();
  fs.writeFileSync(bridge, "# Mine\n\nkeep me\n");
  try {
    connectGemini(base, aios);
    const once = fs.readFileSync(bridge, "utf8");
    connectGemini(base, aios);
    const twice = fs.readFileSync(bridge, "utf8");

    assert.equal(twice, once, "a second connect must not change the file again");
    assert.equal((twice.match(/dotaios-managed:start/g) || []).length, 1);
    assert.equal((twice.match(/keep me/g) || []).length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini creates the bridge when none exists", () => {
  const { base, aios, bridge } = sandbox();
  try {
    const result = connectGemini(base, aios);
    assert.equal(result.status, 0, result.stderr);
    const after = fs.readFileSync(bridge, "utf8");
    assert.match(after, /<!-- dotaios-managed:start -->/);
    assert.match(after, /<!-- dotaios-managed:end -->/);
    assert.match(after, /Working memory/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A managed block must be updated in place rather than appended a second time,
// so a user who moves their AIOS folder gets one correct pointer, not two.
test("connect gemini updates an existing managed block in place", () => {
  const { base, aios, bridge } = sandbox();
  fs.writeFileSync(
    bridge,
    "# Mine\n\nkeep me\n\n<!-- dotaios-managed:start -->\nYour personal AI operating system is at `/somewhere/stale`.\n<!-- dotaios-managed:end -->\n"
  );
  try {
    connectGemini(base, aios);
    const after = fs.readFileSync(bridge, "utf8");
    assert.doesNotMatch(after, /\/somewhere\/stale/, "the stale pointer must be replaced");
    assert.match(after, /keep me/, "surrounding user content must survive");
    assert.equal((after.match(/dotaios-managed:start/g) || []).length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
