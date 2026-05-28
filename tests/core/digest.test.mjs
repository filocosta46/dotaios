import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionDigest } from "../../packages/core/src/digest.mjs";
import { writeSession, readSessionIndex } from "../../packages/core/src/sessions.mjs";
import { generateSessionId } from "../../packages/core/src/sessions.mjs";

function tmpAios() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-digest-test-"));
  fs.writeFileSync(path.join(dir, "aios.json"), JSON.stringify({ version: "1" }));
  fs.mkdirSync(path.join(dir, "memory", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory", "daily"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory", "signals"), { recursive: true });
  return dir;
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

test("buildSessionDigest returns digest and sessionIds", async () => {
  const aiosPath = tmpAios();
  const { digest, sessionIds } = await buildSessionDigest(aiosPath);
  assert.equal(typeof digest, "string");
  assert.ok(Array.isArray(sessionIds));
});

test("buildSessionDigest empty state returns minimal digest", async () => {
  const aiosPath = tmpAios();
  const { digest, sessionIds } = await buildSessionDigest(aiosPath);
  assert.match(digest, /Active Context/);
  assert.equal(sessionIds.length, 0);
});

test("buildSessionDigest includes today's focus when daily note exists", async () => {
  const aiosPath = tmpAios();
  const date = today();
  fs.writeFileSync(
    path.join(aiosPath, "memory", "daily", `${date}.md`),
    `## Focus\nShipping cross-agent continuity\n\n## Plan\n- Write tests\n- Fix bugs\n`
  );
  const { digest } = await buildSessionDigest(aiosPath);
  assert.match(digest, /Shipping cross-agent continuity/);
});

test("buildSessionDigest includes recent sessions and returns their ids", async () => {
  const aiosPath = tmpAios();
  const session = {
    agent: "claude-code",
    session_id: generateSessionId(),
    captured_at: new Date().toISOString(),
    source_type: "hook",
    project: "dotaios",
    title: "Implement digest feature",
    turns: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
  };
  await writeSession(aiosPath, session);

  const { digest, sessionIds } = await buildSessionDigest(aiosPath);
  assert.match(digest, /Implement digest feature/);
  assert.ok(sessionIds.includes(session.session_id));
});

test("buildSessionDigest project filter scopes sessions", async () => {
  const aiosPath = tmpAios();
  const sessionA = {
    agent: "claude-code",
    session_id: generateSessionId(),
    captured_at: new Date().toISOString(),
    source_type: "hook",
    project: "project-a",
    title: "Work on A",
    turns: [],
  };
  const sessionB = {
    agent: "claude-code",
    session_id: generateSessionId(),
    captured_at: new Date().toISOString(),
    source_type: "hook",
    project: "project-b",
    title: "Work on B",
    turns: [],
  };
  await writeSession(aiosPath, sessionA);
  await writeSession(aiosPath, sessionB);

  const { digest, sessionIds } = await buildSessionDigest(aiosPath, { project: "project-a" });
  assert.match(digest, /Work on A/);
  assert.doesNotMatch(digest, /Work on B/);
  assert.ok(sessionIds.includes(sessionA.session_id));
  assert.ok(!sessionIds.includes(sessionB.session_id));
});

test("buildSessionDigest carry-over from yesterday note", async () => {
  const aiosPath = tmpAios();
  const d = new Date();
  const yesterday = new Date(d.getTime() - 86400000);
  const yy = yesterday.getFullYear();
  const ym = String(yesterday.getMonth() + 1).padStart(2, "0");
  const yd = String(yesterday.getDate()).padStart(2, "0");
  const yesterdayStr = `${yy}-${ym}-${yd}`;

  fs.writeFileSync(
    path.join(aiosPath, "memory", "daily", `${yesterdayStr}.md`),
    `## Close\n\n### Carry-over\n- Fix the CI pipeline\n- Review the PR\n`
  );

  const { digest } = await buildSessionDigest(aiosPath);
  assert.match(digest, /Fix the CI pipeline/);
});

test("buildSessionDigest sessionIds excludes entries without session_id", async () => {
  const aiosPath = tmpAios();
  const { sessionIds } = await buildSessionDigest(aiosPath);
  assert.ok(sessionIds.every((id) => typeof id === "string" && id.length > 0));
});
