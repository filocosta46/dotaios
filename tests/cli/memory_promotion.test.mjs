import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPromotion,
  planPromotion,
  PROMOTION_OPERATIONS
} from "../../packages/core/src/promotion.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const SESSION_ID = "a1b2c3d4";

function run(args, { succeeds = true } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (succeeds && result.status !== 0) {
    throw new Error(`Command failed: dotaios ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  if (!succeeds && result.status === 0) {
    throw new Error(`Command unexpectedly succeeded: dotaios ${args.join(" ")}\n${result.stdout}`);
  }
  return result;
}

function setupAios(t, { project = null } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-memory-promotion-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const aiosPath = path.join(tempRoot, "aios");
  const sessionRelativePath = path.join(
    "memory",
    "sessions",
    "2026-07-15",
    `2026-07-15T09-00-00_manual_${SESSION_ID.slice(0, 6)}.md`
  );
  const sessionPath = path.join(aiosPath, sessionRelativePath);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), "{}\n");
  fs.writeFileSync(sessionPath, [
    "---",
    "agent: manual",
    `session_id: ${SESSION_ID}`,
    "captured_at: 2026-07-15T09:00:00.000Z",
    "turns: 2",
    "---",
    "",
    "**user**",
    "",
    "We agreed on a concrete fact.",
    "",
    "**assistant**",
    "",
    "Captured as evidence first.",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(aiosPath, "memory", "sessions", "index.jsonl"), `${JSON.stringify({
    session_id: SESSION_ID,
    agent: "manual",
    captured_at: "2026-07-15T09:00:00.000Z",
    source_type: "manual",
    ...(project && { project }),
    turns: 2,
    title: "We agreed on a concrete fact.",
    path: sessionRelativePath,
    content_hash: "fixture"
  })}\n`);
  fs.writeFileSync(path.join(aiosPath, "memory", "events.jsonl"), "");

  return { aiosPath, sessionPath, sessionRelativePath, tempRoot };
}

function promoteArgs(aiosPath, destinationType, summary, extra = []) {
  return [
    "memory",
    "promote",
    SESSION_ID,
    "--path",
    aiosPath,
    "--to",
    destinationType,
    "--summary",
    summary,
    ...extra
  ];
}

function readEvents(aiosPath) {
  const content = fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("promotion receipts use the canonical operation vocabulary", () => {
  assert.deepEqual(PROMOTION_OPERATIONS, ["add", "replace", "remove", "supersede"]);
});

test("memory promote previews destination and diff without writing by default", (t) => {
  const { aiosPath } = setupAios(t);
  const contextPath = path.join(aiosPath, "context", "work.md");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, "Original context stays here.\n");

  const result = run(promoteArgs(
    aiosPath,
    "context",
    "Prefers written handoffs.",
    ["--destination", "context/work.md"]
  ));

  assert.match(result.stdout, /DotAIOS memory promotion preview/);
  assert.match(result.stdout, /Destination type: context/);
  assert.match(result.stdout, /Destination: context\/work\.md/);
  assert.match(result.stdout, /@@ add @@/);
  assert.match(result.stdout, /\+Prefers written handoffs\./);
  assert.match(result.stdout, /Preview only\. No files changed/);
  assert.equal(fs.readFileSync(contextPath, "utf8"), "Original context stays here.\n");
  assert.deepEqual(readEvents(aiosPath), []);
});

test("context promotion appends content and a structured receipt", (t) => {
  const { aiosPath, sessionRelativePath } = setupAios(t);
  const contextPath = path.join(aiosPath, "context", "work.md");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, "Original context stays here.\n");

  const result = run(promoteArgs(
    aiosPath,
    "context",
    "Prefers written handoffs.",
    ["--destination", "context/work.md", "--apply"]
  ));

  const context = fs.readFileSync(contextPath, "utf8");
  assert.match(result.stdout, /Change preview:/);
  assert.match(result.stdout, /Applied promotion to context\/work\.md/);
  assert.match(context, /^Original context stays here\./);
  assert.match(context, /## Promoted evidence/);
  assert.match(context, /Prefers written handoffs\./);
  assert.ok(context.includes("Source: `" + sessionRelativePath + "`"));

  const [receipt] = readEvents(aiosPath);
  assert.equal(receipt.type, "memory-promotion");
  assert.equal(receipt.source, sessionRelativePath);
  assert.equal(receipt.destination_type, "context");
  assert.equal(receipt.destination_path, path.join("context", "work.md"));
  assert.equal(receipt.operation, "add");
  assert.equal(receipt.summary, "Prefers written handoffs.");
});

test("apply refuses to write when the destination changed after preview", async (t) => {
  const { aiosPath } = setupAios(t);
  const contextPath = path.join(aiosPath, "context", "work.md");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, "Original context.\n");
  const plan = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "Previewed fact."
  });

  fs.appendFileSync(contextPath, "Concurrent user edit.\n");

  await assert.rejects(applyPromotion(plan), /destination changed after the preview/i);
  assert.equal(
    fs.readFileSync(contextPath, "utf8"),
    "Original context.\nConcurrent user edit.\n"
  );
  assert.deepEqual(readEvents(aiosPath), []);
});

test("receipt failure leaves an existing promotion destination byte-identical", async (t) => {
  const { aiosPath } = setupAios(t);
  const contextPath = path.join(aiosPath, "context", "work.md");
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, "Original context bytes.\n");
  const before = fs.readFileSync(contextPath);
  const plan = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "This write must roll back."
  });
  fs.rmSync(eventsPath);
  fs.mkdirSync(eventsPath);

  await assert.rejects(applyPromotion(plan));

  assert.deepEqual(fs.readFileSync(contextPath), before);
});

test("promotion uses the canonical local ISO date for signal and Markdown destinations", async (t) => {
  const { aiosPath } = setupAios(t);
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  try {
    const now = new Date("2026-01-01T10:30:00.000Z");
    const signalPlan = await planPromotion(aiosPath, {
      source: SESSION_ID,
      destinationType: "signal",
      summary: "Local calendar date.",
      now
    });
    const contextPlan = await planPromotion(aiosPath, {
      source: SESSION_ID,
      destinationType: "context",
      destinationPath: "context/work.md",
      summary: "Local calendar date.",
      now
    });

    assert.equal(signalPlan.destinationPath, path.join("memory", "signals", "2026-01-02.jsonl"));
    assert.match(contextPlan.addition, /Promoted evidence: 2026-01-02/);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("signal promotion appends a working signal and keeps a separate receipt", (t) => {
  const { aiosPath } = setupAios(t, { project: "atlas" });

  run(promoteArgs(aiosPath, "signal", "Waiting for design review.", ["--apply"]));

  const signalsDir = path.join(aiosPath, "memory", "signals");
  const signalFiles = fs.readdirSync(signalsDir).filter((file) => file.endsWith(".jsonl"));
  assert.equal(signalFiles.length, 1);
  const signal = JSON.parse(fs.readFileSync(path.join(signalsDir, signalFiles[0]), "utf8").trim());
  assert.equal(signal.type, "promoted-evidence");
  assert.equal(signal.project, "atlas");
  assert.equal(signal.summary, "Waiting for design review.");

  const [receipt] = readEvents(aiosPath);
  assert.equal(receipt.destination_type, "signal");
  assert.match(receipt.destination_path, /^memory\/signals\/\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.equal(receipt.project, "atlas");
});

test("project promotion uses the explicit project README and preserves it", (t) => {
  const { aiosPath } = setupAios(t);
  const projectPath = path.join(aiosPath, "projects", "atlas", "README.md");
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, "# Atlas\n\nExisting project truth.\n");

  run(promoteArgs(
    aiosPath,
    "project",
    "The beta ships Friday.",
    ["--project", "atlas", "--apply"]
  ));

  const project = fs.readFileSync(projectPath, "utf8");
  assert.match(project, /^# Atlas\n\nExisting project truth\./);
  assert.match(project, /The beta ships Friday\./);
  const [receipt] = readEvents(aiosPath);
  assert.equal(receipt.destination_type, "project");
  assert.equal(receipt.destination_path, path.join("projects", "atlas", "README.md"));
  assert.equal(receipt.project, "atlas");
});

test("vault promotion creates only the selected Markdown destination", (t) => {
  const { aiosPath } = setupAios(t);
  const vaultPath = path.join(aiosPath, "vault", "wiki", "release-fact.md");

  run(promoteArgs(
    aiosPath,
    "vault",
    "Release candidates require a clean focused test run.",
    ["--destination", "vault/wiki/release-fact.md", "--apply"]
  ));

  assert.match(fs.readFileSync(vaultPath, "utf8"), /Release candidates require a clean focused test run\./);
  const [receipt] = readEvents(aiosPath);
  assert.equal(receipt.destination_type, "vault");
  assert.equal(receipt.destination_path, path.join("vault", "wiki", "release-fact.md"));
});

test("skill promotion only appends to an existing SKILL.md", (t) => {
  const { aiosPath } = setupAios(t);
  const skillPath = path.join(aiosPath, "skills", "review", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, "# Review\n\nKeep this procedure.\n");

  run(promoteArgs(
    aiosPath,
    "skill",
    "Verify the destination after every write.",
    ["--destination", "skills/review/SKILL.md", "--apply"]
  ));

  const skill = fs.readFileSync(skillPath, "utf8");
  assert.match(skill, /^# Review\n\nKeep this procedure\./);
  assert.match(skill, /Verify the destination after every write\./);
  const [receipt] = readEvents(aiosPath);
  assert.equal(receipt.destination_type, "skill");
  assert.equal(receipt.destination_path, path.join("skills", "review", "SKILL.md"));
});

test("session-only records the disposition without creating durable knowledge", (t) => {
  const { aiosPath, sessionPath } = setupAios(t);
  const sourceBefore = fs.readFileSync(sessionPath, "utf8");

  const result = run(promoteArgs(
    aiosPath,
    "session-only",
    "No durable value beyond this session.",
    ["--apply"]
  ));

  assert.match(result.stdout, /No knowledge file will be written/);
  assert.match(result.stdout, /No durable knowledge file was created/);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), sourceBefore);
  assert.equal(fs.existsSync(path.join(aiosPath, "context")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "projects")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "vault")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills")), false);
  assert.equal(fs.existsSync(path.join(aiosPath, "memory", "signals")), false);

  const [receipt] = readEvents(aiosPath);
  assert.equal(receipt.destination_type, "session-only");
  assert.equal(receipt.destination_path, null);
  assert.equal(receipt.operation, "add");
});

test("promotion rejects destination path traversal", (t) => {
  const { aiosPath } = setupAios(t);
  const outsidePath = path.join(aiosPath, "outside.md");

  const result = run(promoteArgs(
    aiosPath,
    "context",
    "This must stay inside context.",
    ["--destination", "../outside.md", "--apply"]
  ), { succeeds: false });

  assert.match(result.stderr, /path traversal is not allowed/i);
  assert.equal(fs.existsSync(outsidePath), false);
  assert.deepEqual(readEvents(aiosPath), []);
});

test("promotion rejects a destination symlink that escapes its shelf", (t) => {
  const { aiosPath, tempRoot } = setupAios(t);
  const outsideDir = path.join(tempRoot, "outside");
  const contextDir = path.join(aiosPath, "context");
  fs.mkdirSync(outsideDir);
  fs.mkdirSync(contextDir);
  fs.symlinkSync(outsideDir, path.join(contextDir, "escape"), "dir");

  const result = run(promoteArgs(
    aiosPath,
    "context",
    "This must not escape through a symlink.",
    ["--destination", "context/escape/promoted.md", "--apply"]
  ), { succeeds: false });

  assert.match(result.stderr, /symlink points outside the allowed shelf/i);
  assert.equal(fs.existsSync(path.join(outsideDir, "promoted.md")), false);
  assert.deepEqual(readEvents(aiosPath), []);
});

test("promotion rejects a dangling symlink before creating its target", (t) => {
  const { aiosPath, tempRoot } = setupAios(t);
  const outsideTarget = path.join(tempRoot, "missing-outside");
  const contextDir = path.join(aiosPath, "context");
  fs.mkdirSync(contextDir);
  fs.symlinkSync(outsideTarget, path.join(contextDir, "escape"), "dir");

  const result = run(promoteArgs(
    aiosPath,
    "context",
    "A dangling link must not become a write path.",
    ["--destination", "context/escape/promoted.md", "--apply"]
  ), { succeeds: false });

  assert.match(result.stderr, /symlink points outside.*or cannot be resolved/i);
  assert.equal(fs.existsSync(outsideTarget), false);
  assert.deepEqual(readEvents(aiosPath), []);
});
