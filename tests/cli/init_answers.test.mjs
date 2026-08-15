import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

// The advertised install path is "ask your assistant to install DotAIOS". An
// assistant runs commands through a pipe, never a TTY, so the interview at
// init.mjs promptAnswers() threw before a single file was created, and the only
// escape was --yes, which installs an empty identity. A product whose promise
// is "stop starting from zero" was starting its most-advertised user at zero.
//
// --answers is the third mode: the assistant asks the same questions in the
// conversation, where they are easier to answer than at a shell prompt, and
// passes the person's own words through. spawnSync gives the child no TTY, so
// every test here runs on exactly the surface that used to fail.

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

const ANSWERS = {
  name: "Ada Lovelace",
  role: "Analytical engine programmer",
  work: "Translating Menabrea's notes and appending Note G.",
  priorities: "Finish the Bernoulli number program.",
  ai_tools: ["claude-code", "codex"]
};

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-answers-"));
  return { root, target: path.join(root, "aios") };
}

function writeAnswers(root, value) {
  const file = path.join(root, "answers.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function runInit(args, options = {}) {
  return spawnSync(process.execPath, [cli, "init", ...args], { encoding: "utf8", ...options });
}

test("--answers installs the person's real context without a terminal", () => {
  const { root, target } = workspace();
  const result = runInit(["--path", target, "--answers", writeAnswers(root, ANSWERS)]);

  assert.equal(result.status, 0, result.stderr);

  const identity = fs.readFileSync(path.join(target, "context", "identity.md"), "utf8");
  assert.match(identity, /- Name: Ada Lovelace/);
  assert.match(identity, /- Role: Analytical engine programmer/);

  const work = fs.readFileSync(path.join(target, "context", "work.md"), "utf8");
  assert.match(work, /Translating Menabrea's notes/);

  const priorities = fs.readFileSync(path.join(target, "context", "priorities.md"), "utf8");
  assert.match(priorities, /Bernoulli number program/);

  // The placeholder is an HTML comment, so a half-installed folder renders
  // blank rather than obviously unfinished. Assert it never reaches the fields
  // the caller actually answered.
  assert.doesNotMatch(identity, /Your Name|Your Role/);

  const config = JSON.parse(fs.readFileSync(path.join(target, "aios.json"), "utf8"));
  assert.deepEqual(config.ai_tools, ["claude-code", "codex"]);
});

test("--answers - reads the same JSON from stdin", () => {
  const { target } = workspace();
  const result = runInit(["--path", target, "--answers", "-"], { input: JSON.stringify(ANSWERS) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(target, "context", "identity.md"), "utf8"), /- Name: Ada Lovelace/);
});

test("a misspelled key stops the install instead of quietly writing placeholders", () => {
  const { root, target } = workspace();
  const result = runInit(["--path", target, "--answers", writeAnswers(root, { nmae: "Ada" })]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown key "nmae"/);
  assert.equal(fs.existsSync(target), false, "nothing may be created when the answers cannot be trusted");
});

test("empty answers are refused, because --yes already exists for placeholders", () => {
  const { root, target } = workspace();
  const result = runInit(["--path", target, "--answers", writeAnswers(root, {})]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supplied no context/);
  assert.match(result.stderr, /--yes/);
  assert.equal(fs.existsSync(target), false);
});

test("malformed JSON names the problem instead of failing somewhere later", () => {
  const { root, target } = workspace();
  const result = runInit(["--path", target, "--answers", writeAnswers(root, "{not json")]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not valid JSON/);
  assert.equal(fs.existsSync(target), false);
});

test("a missing --answers file is reported by path", () => {
  const { root, target } = workspace();
  const result = runInit(["--path", target, "--answers", path.join(root, "absent.json")]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--answers file not found/);
});

test("--answers and --yes cannot be combined", () => {
  const { root, target } = workspace();
  const result = runInit(["--path", target, "--answers", writeAnswers(root, ANSWERS), "--yes"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contradict each other/);
  assert.equal(fs.existsSync(target), false);
});

test("the no-TTY error points an assistant at --answers, not just at Terminal", () => {
  const { target } = workspace();
  const result = runInit(["--path", target]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--answers/);
  // Telling an assistant to open Terminal is telling it to give up. It must
  // learn about the path it can actually take before it learns about that one.
  assert.ok(
    result.stderr.indexOf("--answers") < result.stderr.indexOf("cmd+space"),
    "the recoverable instruction must come before the dead end"
  );
});

test("setup accepts --answers and passes it through to init", () => {
  const { root, target } = workspace();
  const result = spawnSync(
    process.execPath,
    [cli, "setup", "--dry-run", "--path", target, "--answers", writeAnswers(root, ANSWERS)],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});
