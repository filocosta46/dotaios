import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// `dotaios interview` threw on `!input.isTTY` at the top of the command, so it
// was unreachable from an assistant no matter what it was given. That made the
// product's own advertised follow-up a dead end for exactly the person an
// assistant had just installed for: setup printed it, FIRST_SESSION.md printed
// it, docs/getting-started.md printed it. Install worked without a terminal and
// every update after it needed one.
//
// spawnSync gives the child no TTY, so every test here runs on the surface that
// used to throw.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function installed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-interview-"));
  const target = path.join(root, "aios");
  const home = path.join(root, "home");
  const processHome = path.join(root, "process-home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(processHome, { recursive: true });
  const setup = spawnSync(
    process.execPath,
    [cli, "setup", "--path", target, "--home", home, "--skip-reveal", "--answers", "-"],
    {
      encoding: "utf8",
      cwd: repoRoot,
      input: JSON.stringify({
        name: "Ada Lovelace",
        role: "Analytical engine programmer",
        work: "Translating Menabrea's notes.",
        priorities: "Finish Note G.",
        ai_tools: "claude-code"
      }),
      // PATH is trimmed for the same reason setup_recovery.test.mjs trims it:
      // resolveLightpanda falls back to `which lightpanda`.
      env: { ...process.env, HOME: processHome, PATH: "/usr/bin:/bin" }
    }
  );
  assert.equal(setup.status, 0, setup.stderr);
  return { root, target, home };
}

function interview(target, input, extra = []) {
  return spawnSync(process.execPath, [cli, "interview", "--path", target, "--answers", "-", ...extra], {
    encoding: "utf8",
    input,
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
}

test("an assistant can update context through a pipe", () => {
  const { target } = installed();

  const result = interview(target, JSON.stringify({
    role: "Founder and maintainer",
    work: "Closing the last onboarding hole",
    priorities: "Ship 2.0.4",
    planStyle: "aggressive"
  }));

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(target, "context", "identity.md"), "utf8"), /- Role: Founder and maintainer/);
  assert.match(fs.readFileSync(path.join(target, "context", "work.md"), "utf8"), /Closing the last onboarding hole/);
  assert.match(fs.readFileSync(path.join(target, "context", "priorities.md"), "utf8"), /Ship 2\.0\.4/);
  assert.match(fs.readFileSync(path.join(target, "context", "preferences.md"), "utf8"), /- Plan style: aggressive/);
});

test("a field left out keeps what is already there", () => {
  const { target } = installed();

  // This is the flag's equivalent of pressing Enter at the prompt, which is how
  // the interactive form has always worked. Naming only one field must not
  // blank the other six.
  const result = interview(target, JSON.stringify({ priorities: "Ship 2.0.4" }));
  assert.equal(result.status, 0, result.stderr);

  const identity = fs.readFileSync(path.join(target, "context", "identity.md"), "utf8");
  assert.match(identity, /- Role: Analytical engine programmer/, "role must survive an update that did not mention it");
  assert.match(fs.readFileSync(path.join(target, "context", "work.md"), "utf8"), /Translating Menabrea's notes/);
});

test("running it twice with the same answers changes nothing", () => {
  const { target } = installed();
  const payload = JSON.stringify({ role: "Founder", priorities: "Ship" });

  assert.equal(interview(target, payload).status, 0);
  const second = interview(target, payload);

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Nothing changed/);
});

test("without --answers the error names the flag before the terminal", () => {
  const { target } = installed();

  const result = spawnSync(process.execPath, [cli, "interview", "--path", target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--answers/);
  // Telling an assistant to open Terminal is telling it to give up. It must
  // learn the path it can take before it learns the one it cannot.
  assert.ok(
    result.stderr.indexOf("--answers") < result.stderr.indexOf("Terminal window"),
    "the recoverable instruction must come before the dead end"
  );
});

test("the answers are held to the same rules init's are", () => {
  const { target } = installed();
  const before = fs.readFileSync(path.join(target, "context", "identity.md"), "utf8");

  const cases = [
    [{ work: "Shipping.\n\n## Active Projects\n\nforged" }, /contains a markdown heading/],
    [{ role: "Founder‮live" }, /contains the control character U\+202E/],
    [{ role: 123 }, /must be a string/],
    [{ rol: "typo" }, /unknown key "rol"/],
    [{}, /supplied no answers/]
  ];

  for (const [payload, pattern] of cases) {
    const result = interview(target, JSON.stringify(payload));
    assert.notEqual(result.status, 0, `${JSON.stringify(payload)} must be refused`);
    assert.match(result.stderr, pattern);
  }

  assert.equal(
    fs.readFileSync(path.join(target, "context", "identity.md"), "utf8"),
    before,
    "a refusal writes nothing"
  );
});

test("--review with DOTAIOS_AUTO_APPROVE=1 is reachable now that the throw moved", () => {
  const { target } = installed();

  // interview --help has always advertised this escape. It was dead code: the
  // TTY throw happened before confirmWrites was ever called, so no
  // non-interactive run could reach the branch that honours it.
  const result = spawnSync(
    process.execPath,
    [cli, "interview", "--path", target, "--review", "--answers", "-"],
    {
      encoding: "utf8",
      input: JSON.stringify({ priorities: "Ship 2.0.4 and write the launch post" }),
      env: { ...process.env, PATH: "/usr/bin:/bin", DOTAIOS_AUTO_APPROVE: "1" }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(target, "context", "priorities.md"), "utf8"), /write the launch post/);
});
