import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args, { allowNonZero = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (!allowNonZero && result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-lean-plan-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

test("brief --lean prints identity, priorities, north-star, today's note, and active project README", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "context", "identity.md"), "# Identity\n\nI am a test user.\n");
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), "# Priorities\n\nShip the resolver.\n");
  fs.writeFileSync(path.join(aiosPath, "context", "north-star.md"), "# North star\n\nOne platform.\n");
  fs.mkdirSync(path.join(aiosPath, "memory", "daily"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "memory", "daily", `${today()}.md`), `# ${today()}\n\nFocus: the resolver.\n`);
  fs.mkdirSync(path.join(aiosPath, "projects", "demo"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "projects", "demo", "README.md"), "---\nproject: demo\nstatus: active\n---\n# Demo\n\nA demo project.\n");

  const result = run(["brief", "--lean", "--path", aiosPath]);
  assert.match(result.stdout, /# Lean brief/);
  assert.match(result.stdout, /I am a test user/);
  assert.match(result.stdout, /Ship the resolver/);
  assert.match(result.stdout, /One platform/);
  assert.match(result.stdout, /Focus: the resolver/);
  assert.match(result.stdout, /A demo project/);
});

test("brief --lean does not write a file", () => {
  const { aiosPath } = setupAios();
  run(["brief", "--lean", "--path", aiosPath]);
  // lean mode never writes; the daily note should not exist just from --lean.
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "brief.md")), false);
});

test("plan writes a plan artifact under memory/plans and logs an event", () => {
  const { aiosPath } = setupAios();
  const result = run(["plan", "ship the resolver", "--steps", "write tests,implement,ship", "--path", aiosPath]);
  assert.match(result.stdout, /Plan saved at/);
  assert.match(result.stdout, /memory\/plans\//);

  const plansDir = path.join(aiosPath, "memory", "plans");
  const files = fs.readdirSync(plansDir);
  assert.equal(files.length, 1);
  const body = fs.readFileSync(path.join(plansDir, files[0]), "utf8");
  assert.match(body, /^---\n/m);
  assert.match(body, /# ship the resolver/);
  assert.match(body, /- \[ \] write tests/);
  assert.match(body, /- \[ \] implement/);
  assert.match(body, /## Goal/);
  assert.match(body, /## Status/);
  assert.match(body, /in-progress/);

  const events = fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8").trim().split("\n");
  const last = JSON.parse(events[events.length - 1]);
  assert.equal(last.type, "plan");
  assert.match(last.summary, /ship the resolver/);
});

test("plan --print writes no file and prints the body", () => {
  const { aiosPath } = setupAios();
  const result = run(["plan", "draft the design", "--print", "--path", aiosPath]);
  assert.match(result.stdout, /# draft the design/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "plans")), false);
});

test("plan with no title exits 2", () => {
  const { aiosPath } = setupAios();
  const result = run(["plan", "--path", aiosPath], { allowNonZero: true });
  assert.equal(result.status, 2);
});

test("plan --project tags the artifact and the event", () => {
  const { aiosPath } = setupAios();
  run(["plan", "ship it", "--project", "demo", "--path", aiosPath]);
  const plansDir = path.join(aiosPath, "memory", "plans");
  const body = fs.readFileSync(path.join(plansDir, fs.readdirSync(plansDir)[0]), "utf8");
  assert.match(body, /project: demo/);
});
