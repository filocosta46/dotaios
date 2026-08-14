import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeGeminiBridge } from "../../packages/cli/src/adapters/gemini.mjs";

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
    assert.match(result.stdout, /configured; invocation is not yet verified/i);
    assert.doesNotMatch(result.stdout, /Gemini CLI connected\./i);
    const after = fs.readFileSync(bridge, "utf8");
    assert.match(after, /<!-- dotaios-managed:start -->/);
    assert.match(after, /<!-- dotaios-managed:end -->/);
    // The block connect writes is the one activate writes: it names the folder
    // and carries the rule for when to open it. Asserting connect's own older
    // wording here is what let the two bodies drift apart in the first place.
    assert.match(after, new RegExp(`personal context in a folder at ${aios.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(after, /Choose memory access for this session before opening AIOS/i);
    assert.match(after, /Leave the AIOS folder closed for Off/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini dry-run lists every artifact it would write", () => {
  const { base, aios } = sandbox();
  try {
    const result = spawnSync(process.execPath, [cli, "connect", "gemini", "--dry-run", "--path", aios], {
      encoding: "utf8",
      env: { ...process.env, HOME: base }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /GEMINI\.md/);
    assert.match(result.stdout, /settings\.json/);
    assert.match(result.stdout, /dotaios-context-hook\.sh/);
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

test("connect gemini refuses malformed managed markers without changing the file", () => {
  const { base, aios, bridge } = sandbox();
  const malformed = "# Mine\n\n<!-- dotaios-managed:start -->\nunfinished DotAIOS block\n";
  fs.writeFileSync(bridge, malformed);
  try {
    const result = connectGemini(base, aios);

    assert.equal(result.status, 1, "ambiguous ownership must stop the connection");
    assert.match(result.stderr, /managed markers are malformed/i);
    assert.equal(fs.readFileSync(bridge, "utf8"), malformed);
    assert.equal(fs.existsSync(path.join(base, ".gemini", "settings.json")), false);
    assert.equal(fs.existsSync(path.join(base, ".gemini", "dotaios-context-hook.sh")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini preserves every user-authored byte before an appended block", () => {
  const { base, aios, bridge } = sandbox();
  const authored = Buffer.from("# Mine\r\nkeep two spaces  \r\n\r\n\r\n", "utf8");
  fs.writeFileSync(bridge, authored);
  try {
    const result = connectGemini(base, aios);
    assert.equal(result.status, 0, result.stderr);

    const after = fs.readFileSync(bridge);
    assert.deepEqual(after.subarray(0, authored.length), authored);
    assert.match(after.subarray(authored.length).toString("utf8"), /<!-- dotaios-managed:start -->/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini refuses a symlinked GEMINI.md without changing its target", () => {
  const { base, aios, bridge } = sandbox();
  const outside = path.join(base, "outside-gemini.md");
  const authored = "# Outside\n\nnever edit through a link\n";
  fs.writeFileSync(outside, authored);
  fs.symlinkSync(outside, bridge);
  try {
    const result = connectGemini(base, aios);

    assert.equal(result.status, 1, "unsafe bridge targets must stop the connection");
    assert.match(result.stderr, /not a regular file|unsafe|symbolic link/i);
    assert.equal(fs.readFileSync(outside, "utf8"), authored);
    assert.equal(fs.lstatSync(bridge).isSymbolicLink(), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("Gemini bridge leaves a concurrent user edit untouched", async () => {
  const { base, aios, bridge } = sandbox();
  const authored = "# Mine\n\nkeep the original\n";
  const concurrent = "# Mine\n\nI changed this while connect was running\n";
  fs.writeFileSync(bridge, authored);
  let reachedCommit = false;
  try {
    await assert.rejects(
      writeGeminiBridge(bridge, aios, {
        beforeCommit: async () => {
          reachedCommit = true;
          fs.writeFileSync(bridge, concurrent);
        }
      }),
      /changed during connect|conflict/i
    );

    assert.equal(reachedCommit, true, "the test must inject the edit after DotAIOS reads the file");
    assert.equal(fs.readFileSync(bridge, "utf8"), concurrent);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini refuses a symlinked .gemini directory before changing any artifact", () => {
  const { base, aios } = sandbox();
  const geminiDir = path.join(base, ".gemini");
  const outsideDir = path.join(base, "outside-gemini-dir");
  const outsideBridge = path.join(outsideDir, "GEMINI.md");
  const outsideSettings = path.join(outsideDir, "settings.json");
  const bridgeBefore = "# Outside instructions\n";
  const settingsBefore = '{"theme":"user-owned"}\n';
  fs.rmSync(geminiDir, { recursive: true, force: true });
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(outsideBridge, bridgeBefore);
  fs.writeFileSync(outsideSettings, settingsBefore);
  fs.symlinkSync(outsideDir, geminiDir);
  try {
    const result = connectGemini(base, aios);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe managed directory|unsafe/i);
    assert.equal(fs.readFileSync(outsideBridge, "utf8"), bridgeBefore);
    assert.equal(fs.readFileSync(outsideSettings, "utf8"), settingsBefore);
    assert.equal(fs.existsSync(path.join(outsideDir, "dotaios-context-hook.sh")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini refuses a symlinked settings.json before changing any artifact", () => {
  const { base, aios, bridge } = sandbox();
  const geminiDir = path.join(base, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");
  const outsideSettings = path.join(base, "outside-settings.json");
  const bridgeBefore = "# My Gemini instructions\n";
  const settingsBefore = '{"theme":"user-owned"}\n';
  fs.writeFileSync(bridge, bridgeBefore);
  fs.writeFileSync(outsideSettings, settingsBefore);
  fs.symlinkSync(outsideSettings, settingsPath);
  try {
    const result = connectGemini(base, aios);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe file destination|unsafe/i);
    assert.equal(fs.readFileSync(outsideSettings, "utf8"), settingsBefore);
    assert.equal(fs.readFileSync(bridge, "utf8"), bridgeBefore);
    assert.equal(fs.existsSync(path.join(geminiDir, "dotaios-context-hook.sh")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini preflights malformed settings before changing bridge or hook", () => {
  const { base, aios, bridge } = sandbox();
  const geminiDir = path.join(base, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");
  const bridgeBefore = "# My Gemini instructions\n";
  const settingsBefore = "{ malformed";
  fs.writeFileSync(bridge, bridgeBefore);
  fs.writeFileSync(settingsPath, settingsBefore);
  try {
    const result = connectGemini(base, aios);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not valid JSON/i);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsBefore);
    assert.equal(fs.readFileSync(bridge, "utf8"), bridgeBefore);
    assert.equal(fs.existsSync(path.join(geminiDir, "dotaios-context-hook.sh")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("connect gemini preflights a foreign hook before changing bridge or settings", () => {
  const { base, aios, bridge } = sandbox();
  const geminiDir = path.join(base, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");
  const hookPath = path.join(geminiDir, "dotaios-context-hook.sh");
  const bridgeBefore = "# My Gemini instructions\n";
  const settingsBefore = '{"theme":"mine"}\n';
  const hookBefore = "#!/bin/sh\necho user-owned\n";
  fs.writeFileSync(bridge, bridgeBefore);
  fs.writeFileSync(settingsPath, settingsBefore);
  fs.writeFileSync(hookPath, hookBefore, { mode: 0o700 });
  try {
    const result = connectGemini(base, aios);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a DotAIOS-managed hook|foreign script/i);
    assert.equal(fs.readFileSync(hookPath, "utf8"), hookBefore);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), settingsBefore);
    assert.equal(fs.readFileSync(bridge, "utf8"), bridgeBefore);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// `activate` and `connect gemini` both own the single managed block in
// ~/.gemini/GEMINI.md, and they used to write different bodies into it: the
// last command run silently replaced the other's, and connect's older body
// reinstated the always-on shape this release removed. doctor then called the
// result "a different AIOS folder" — false, the block names the folder — and
// offered `activate --overwrite`, which undid connect. Running one documented
// command after another must converge, not ping-pong.
test("activate and connect gemini agree on the managed block", () => {
  const { base, aios, bridge } = sandbox();
  try {
    const activate = runActivate(base, aios);
    assert.equal(activate.status, 0, activate.stderr);
    const afterActivate = findBlock(fs.readFileSync(bridge, "utf8"));

    const connect = connectGemini(base, aios);
    assert.equal(connect.status, 0, connect.stderr);
    const afterConnect = findBlock(fs.readFileSync(bridge, "utf8"));

    assert.equal(afterConnect, afterActivate, "connect must not rewrite the block activate owns");
    // The rule this release exists to add has to survive the second command.
    assert.match(afterConnect, /Choose memory access for this session before opening AIOS/i);
    assert.match(afterConnect, /Leave the AIOS folder closed for Off/i);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("doctor stays green after connect gemini", () => {
  const { base, aios } = sandbox();
  try {
    assert.equal(runActivate(base, aios).status, 0);
    assert.equal(connectGemini(base, aios).status, 0);

    const doctor = spawnSync(process.execPath, [cli, "doctor", "--path", aios, "--home", base], {
      encoding: "utf8",
      env: { ...process.env, HOME: base, DOTAIOS_NO_UPDATE_CHECK: "1" }
    });

    assert.match(doctor.stdout, /\[ok\] Gemini\n/);
    assert.doesNotMatch(doctor.stdout, /Connection points to a different AIOS folder/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// activate refuses to wire a temp AIOS folder into the *real* home, so its
// process HOME must differ from the --home it is asked to write. connect resolves
// the bridge from os.homedir() and needs HOME to be the sandbox itself.
function runActivate(base, aios) {
  const processHome = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-activate-home-"));
  try {
    return spawnSync(process.execPath, [cli, "activate", "--path", aios, "--home", base], {
      encoding: "utf8",
      env: { ...process.env, HOME: processHome }
    });
  } finally {
    fs.rmSync(processHome, { recursive: true, force: true });
  }
}

function findBlock(content) {
  const start = content.indexOf("<!-- dotaios-managed:start -->");
  const end = content.indexOf("<!-- dotaios-managed:end -->");
  assert.ok(start >= 0 && end > start, "expected one managed block");
  return content.slice(start, end + "<!-- dotaios-managed:end -->".length);
}
