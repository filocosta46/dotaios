import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function setupAios() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-brief-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);
  return { aiosPath, tempRoot };
}

function today() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function yesterday() {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("brief writes a ## Brief section into today's daily note", () => {
  const { aiosPath } = setupAios();
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), [
    "# Priorities",
    "",
    "## Current Bets",
    "",
    "- Ship Output Loop v1",
    "- Keep the ICP path simple",
    ""
  ].join("\n"));
  fs.appendFileSync(path.join(aiosPath, "memory", "events.jsonl"), `${JSON.stringify({
    ts: new Date().toISOString(),
    type: "test",
    summary: "Follow up on the output loop blocker",
    source: "test"
  })}\n`);

  run(["brief", "--path", aiosPath]);

  const note = fs.readFileSync(path.join(aiosPath, "memory", "daily", `${today()}.md`), "utf8");
  assert.match(note, /## Brief/);
  assert.match(note, /Ship Output Loop v1/);
  assert.match(note, /Follow up on the output loop blocker/);
  assert.match(note, /## Focus/);
  assert.match(note, /## Plan/);
  assert.match(note, /## Close/);
});

test("brief replaces only the ## Brief section in an existing daily note", () => {
  const { aiosPath } = setupAios();
  const dailyDir = path.join(aiosPath, "memory", "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, `${today()}.md`), [
    "---",
    `date: ${today()}`,
    "source: test",
    "---",
    "",
    `# ${today()}`,
    "",
    "## Brief",
    "",
    "Old brief",
    "",
    "## Focus",
    "Keep this focus.",
    "",
    "## Plan",
    "Keep this plan.",
    "",
    "## Close",
    "Keep this close.",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), "# Priorities\n\n## Current Bets\n\n- New priority\n");

  run(["brief", "--path", aiosPath]);

  const note = fs.readFileSync(path.join(dailyDir, `${today()}.md`), "utf8");
  assert.doesNotMatch(note, /Old brief/);
  assert.match(note, /New priority/);
  assert.match(note, /Keep this focus/);
  assert.match(note, /Keep this plan/);
  assert.match(note, /Keep this close/);
});

test("brief carries over yesterday's closeout items", () => {
  const { aiosPath } = setupAios();
  const dailyDir = path.join(aiosPath, "memory", "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, `${yesterday()}.md`), [
    `# ${yesterday()}`,
    "",
    "## Close",
    "",
    "### Done",
    "Something finished",
    "",
    "### Carry-over",
    "- Send the beta note",
    "",
    "### Reflection",
    "Ship earlier",
    ""
  ].join("\n"));

  run(["brief", "--path", aiosPath]);

  const note = fs.readFileSync(path.join(dailyDir, `${today()}.md`), "utf8");
  assert.match(note, /Send the beta note/);
});

test("brief --dry-run does not write today's note", () => {
  const { aiosPath } = setupAios();
  const result = run(["brief", "--path", aiosPath, "--dry-run"]);

  assert.match(result.stdout, /dry run/);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "daily", `${today()}.md`)), false);
});

test("init ships the daily brief schedule disabled by default", () => {
  const { aiosPath } = setupAios();
  const schedules = fs.readFileSync(path.join(aiosPath, "schedules.yml"), "utf8");

  assert.match(schedules, /name: daily-brief/);
  assert.match(schedules, /cadence: daily/);
  assert.match(schedules, /command: "dotaios brief"/);
  assert.match(schedules, /enabled: false/);

  const list = run(["schedule", "list", "--path", aiosPath]);
  assert.match(list.stdout, /daily-brief/);
  assert.match(list.stdout, /dotaios brief/);
});
