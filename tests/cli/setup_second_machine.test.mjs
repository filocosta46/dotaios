import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// INSTALL.md tells an assistant: "do not run setup after `[would stop]`". The
// preview reported `[would stop]` for any non-empty target, which includes a
// perfectly healthy DotAIOS folder — so on a second machine, the exact case
// sync exists to serve, a compliant assistant halted an install that would
// have been a clean no-op. The real re-run reconnects the clients and prints
// "DotAIOS is already set up".
//
// The protection itself is real and stays: an arbitrary non-empty directory is
// someone else's data.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function sandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-second-${label}-`));
  const target = path.join(root, "aios");
  const home = path.join(root, "home");
  const processHome = path.join(root, "process-home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(processHome, { recursive: true });
  return { root, target, home, processHome };
}

function runSetup(box, extra) {
  return spawnSync(process.execPath, [cli, "setup", "--path", box.target, "--home", box.home, "--skip-reveal", ...extra], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: box.processHome, PATH: "/usr/bin:/bin" }
  });
}

function install(box) {
  const result = spawnSync(
    process.execPath,
    [cli, "setup", "--path", box.target, "--home", box.home, "--skip-reveal", "--answers", "-"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify({ name: "Ada", role: "Programmer", work: "Note G.", priorities: "Bernoulli.", ai_tools: "claude-code" }),
      env: { ...process.env, HOME: box.processHome, PATH: "/usr/bin:/bin" }
    }
  );
  assert.equal(result.status, 0, result.stderr);
}

test("the preview does not halt an assistant on a machine that already has a healthy folder", () => {
  const box = sandbox("healthy");
  install(box);

  const preview = runSetup(box, ["--dry-run"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /\[would keep\]/);
  assert.doesNotMatch(preview.stdout, /\[would stop\]/, "a healthy folder is not a reason to stop");
  assert.doesNotMatch(preview.stdout, /\[would skip\] activation/, "activation is the point of the second machine");

  // And the preview must be telling the truth about the run that follows it:
  // `[would keep]` is only honest if the real re-run actually succeeds.
  install(box);
});

test("a non-empty directory that is not ours still stops the run", () => {
  const box = sandbox("notours");
  fs.mkdirSync(box.target, { recursive: true });
  fs.writeFileSync(path.join(box.target, "important.txt"), "someone else's data\n");

  const preview = runSetup(box, ["--dry-run"]);
  assert.match(preview.stdout, /\[would stop\]/);
  assert.match(preview.stdout, /not a DotAIOS folder/);
});

test("an unfinished setup still stops, because init refuses it", () => {
  const box = sandbox("unfinished");
  install(box);
  fs.writeFileSync(path.join(box.target, ".dotaios-setup-transaction.json"), "{}\n");

  const preview = runSetup(box, ["--dry-run"]);
  assert.match(preview.stdout, /\[would stop\]/);
  assert.match(preview.stdout, /unfinished setup/);
});
