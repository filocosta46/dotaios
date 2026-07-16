import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildDailyBrief } from "../../packages/cli/src/commands/brief.mjs";
import { isoDate } from "../../packages/core/src/memory.mjs";

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
  return isoDate(new Date());
}

function yesterday() {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return isoDate(date);
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

test("standard brief uses the canonical bounded timeline selection", async () => {
  const { aiosPath } = setupAios();
  const now = new Date(2026, 6, 15, 18, 0, 0);
  const date = isoDate(now);
  const staleDate = new Date(now.getTime());
  staleDate.setDate(staleDate.getDate() - 2);
  const events = [
    {
      ts: `${isoDate(staleDate)}T08:00:00.000Z`,
      summary: "TODO stale event must not reach the standard brief"
    },
    {
      ts: `${date}T09:00:00.000Z`,
      summary: "TODO ninth event must stay outside the canonical cap"
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      ts: `${date}T${String(index + 10).padStart(2, "0")}:00:00.000Z`,
      summary: `Routine observation ${index + 1}`
    }))
  ];
  fs.writeFileSync(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
  fs.writeFileSync(
    path.join(aiosPath, "memory", "signals", `mini-${date}.jsonl`),
    `${JSON.stringify({
      ts: `${date}T18:00:00.000Z`,
      summary: "Follow up from the selected signal"
    })}\n`
  );

  const brief = await buildDailyBrief(aiosPath, date, now);

  assert.match(brief, /Follow up from the selected signal/);
  assert.doesNotMatch(brief, /ninth event|stale event/);
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
