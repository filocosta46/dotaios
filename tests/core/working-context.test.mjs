import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { isoDate } from "../../packages/core/src/memory.mjs";
import {
  buildWorkingContext,
  createWorkingContextProjection,
  renderWorkingContext,
  selectWorkingContext,
} from "../../packages/core/src/working-context.mjs";

const FIXED_NOW = new Date("2026-07-15T10:00:00.000Z");

function tmpAios() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-working-context-test-"));
  for (const relative of ["memory/daily", "memory/sessions", "memory/signals"]) {
    fs.mkdirSync(path.join(directory, relative), { recursive: true });
  }
  return directory;
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function fixedClock() {
  return new Date(FIXED_NOW.getTime());
}

test("project filter scopes sessions, namespaced signals, and events with stable ordering", async () => {
  const aiosPath = tmpAios();
  writeJsonl(path.join(aiosPath, "memory", "sessions", "index.jsonl"), [
    {
      session_id: "project-b",
      project: "project-b",
      captured_at: "2026-07-15T09:30:00.000Z",
      agent: "codex",
      title: "Project B session",
      turns: 2,
    },
    {
      session_id: "a-newer",
      project: "project-a",
      captured_at: "2026-07-15T09:00:00.000Z",
      agent: "codex",
      title: "Newer A session",
      turns: 4,
    },
    {
      session_id: "a-older",
      project: "project-a",
      captured_at: "2026-07-14T09:00:00.000Z",
      agent: "claude-code",
      title: "Older A session",
      turns: 3,
    },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "signals", "mini-2026-07-15.jsonl"), [
    { ts: "2026-07-15T09:45:00.000Z", project: "project-b", summary: "Project B signal" },
    { ts: "2026-07-15T09:15:00.000Z", project: "project-a", summary: "Newer A signal" },
    { ts: "2026-07-15T08:15:00.000Z", project: "project-a", summary: "Older A signal" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "signals", "laptop-2026-07-13.jsonl"), [
    { ts: "2026-07-13T12:00:00.000Z", project: "project-a", summary: "Stale A signal" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), [
    { ts: "2026-07-15T09:50:00.000Z", project: "project-b", summary: "Project B event" },
    { ts: "2026-07-14T16:00:00.000Z", project: "project-a", summary: "Newer A event" },
    { ts: "2026-07-14T08:00:00.000Z", project: "project-a", summary: "Older A event" },
    { ts: "2026-07-13T08:00:00.000Z", project: "project-a", summary: "Stale A event" },
  ]);

  const context = await selectWorkingContext(
    aiosPath,
    { project: "project-a" },
    { clock: fixedClock },
  );
  const rendered = renderWorkingContext(context);

  assert.deepEqual(context.sessions.map((session) => session.session_id), ["a-newer", "a-older"]);
  assert.deepEqual(context.signals.map((signal) => signal.summary), ["Newer A signal", "Older A signal"]);
  assert.deepEqual(context.events.map((event) => event.summary), ["Newer A event", "Older A event"]);
  assert.deepEqual(context.signals.map(({ sourcePath, sourceLine }) => [sourcePath, sourceLine]), [
    ["memory/signals/mini-2026-07-15.jsonl", 2],
    ["memory/signals/mini-2026-07-15.jsonl", 3],
  ]);
  assert.deepEqual(context.events.map(({ sourcePath, sourceLine }) => [sourcePath, sourceLine]), [
    ["memory/events.jsonl", 2],
    ["memory/events.jsonl", 3],
  ]);
  assert.equal(context.today, isoDate(FIXED_NOW));
  assert.ok(context.sessions.every((item) => item.project === "project-a"));
  assert.ok(context.signals.every((item) => item.project === "project-a"));
  assert.ok(context.events.every((item) => item.project === "project-a"));
  assert.doesNotMatch(rendered, /Project B|Stale A/);
});

test("scoped views retain unattributed evidence without leaking another project", async () => {
  const aiosPath = tmpAios();
  writeJsonl(path.join(aiosPath, "memory", "sessions", "index.jsonl"), [
    { session_id: "a", project: "project-a", captured_at: "2026-07-15T09:00:00.000Z", title: "A fact" },
    { session_id: "b", project: "project-b", captured_at: "2026-07-15T08:00:00.000Z", title: "B fact" },
    { session_id: "unscoped", captured_at: "2026-07-15T07:00:00.000Z", title: "Unscoped fact" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "signals", "2026-07-15.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", type: "update", source: "dotaios update", project: "project-a", summary: "A update" },
    { ts: "2026-07-15T08:00:00.000Z", type: "update", source: "dotaios update", project: "project-b", summary: "B update" },
    { ts: "2026-07-15T07:00:00.000Z", type: "update", source: "dotaios update", summary: "Unscoped update" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", type: "update", source: "dotaios update", project: "project-a", summary: "A update" },
    { ts: "2026-07-15T08:00:00.000Z", type: "update", source: "dotaios update", project: "project-b", summary: "B update" },
    { ts: "2026-07-15T07:00:00.000Z", type: "update", source: "dotaios update", summary: "Unscoped update" },
  ]);

  const scopedA = await buildWorkingContext(aiosPath, { project: "project-a" }, { clock: fixedClock });
  const scopedB = await buildWorkingContext(aiosPath, { project: "project-b" }, { clock: fixedClock });
  const unscoped = await buildWorkingContext(aiosPath, {}, { clock: fixedClock });

  assert.match(scopedA.rendered, /A fact|A update/);
  assert.doesNotMatch(scopedA.rendered, /B fact|B update/);
  assert.match(scopedA.rendered, /Unscoped fact|Unscoped update/);
  assert.match(scopedA.rendered, /unscoped/);
  assert.match(scopedB.rendered, /B fact|B update/);
  assert.doesNotMatch(scopedB.rendered, /A fact|A update/);
  assert.equal((unscoped.rendered.match(/Unscoped update/g) || []).length, 1);
});

test("scoped views dedupe update channels like unscoped views", async () => {
  const aiosPath = tmpAios();
  writeJsonl(path.join(aiosPath, "memory", "signals", "2026-07-15.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", type: "update", source: "dotaios update", project: "project-a", summary: "A update" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", type: "update", source: "dotaios update", project: "project-a", summary: "A update" },
  ]);

  const scopedA = await buildWorkingContext(aiosPath, { project: "project-a" }, { clock: fixedClock });

  assert.equal((scopedA.rendered.match(/A update/g) || []).length, 1);
});

test("compact projection answers identity and priorities within the same budget", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "context"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "context", "identity.md"), "# Identity\n\nI am the launch owner.\n");
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), "# Priorities\n\nShip the hardening release this week.\n");

  const result = await buildWorkingContext(aiosPath, { visibleCharacterBudget: 220 }, { clock: fixedClock });
  assert.match(result.rendered, /### Identity[\s\S]*launch owner/);
  assert.match(result.rendered, /### Priorities[\s\S]*hardening release/);
  assert.ok(result.rendered.length <= 220);
  assert.equal(result.context.budget.used, result.rendered.length);
});

test("projection reads durable project metadata from the local README", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "projects", "project-a"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "projects", "project-a", "README.md"), [
    "---",
    "id: project-id-a",
    "project: project-a",
    "status: active",
    "domain: [build]",
    "repo_url: https://example.com/project-a.git",
    "runtime_path: /private/tmp/machine-only/project-a",
    "---",
    "# Project A",
    "",
    "Durable project context.",
    "",
  ].join("\n"));
  const readPaths = [];
  const filesystem = {
    async readFile(filePath, encoding) {
      readPaths.push(filePath);
      return fs.promises.readFile(filePath, encoding);
    },
    readdir: (...args) => fs.promises.readdir(...args),
    lstat: (...args) => fs.promises.lstat(...args),
    realpath: (...args) => fs.promises.realpath(...args),
  };
  const projection = createWorkingContextProjection({ filesystem, clock: fixedClock });

  const { context, rendered } = await projection.build(aiosPath, { project: "project-a" });

  assert.equal(context.activeProject.name, "Project A");
  assert.equal(context.activeProject.id, "project-id-a");
  assert.equal(context.activeProject.repoUrl, "https://example.com/project-a.git");
  assert.equal(context.activeProject.readme.includes("Durable project context."), true);
  assert.equal(Object.hasOwn(context.activeProject, "runtime_path"), false);
  assert.doesNotMatch(rendered, /private\/tmp|machine-only/);
  assert.match(rendered, /Project A · active · build/);
  assert.equal(readPaths.some((filePath) => filePath.includes(`${path.sep}projects${path.sep}`)), true);
});

test("stable project id resolves to the canonical slug before filtering", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "projects", "project-a"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "project-a", "README.md"),
    "---\nid: stable-project-id\nproject: project-a\n---\n# Project A\n",
  );
  writeJsonl(path.join(aiosPath, "memory", "sessions", "index.jsonl"), [
    {
      session_id: "matching-session",
      project: "project-a",
      captured_at: "2026-07-15T09:00:00.000Z",
      title: "Canonical project session",
    },
    {
      session_id: "other-session",
      project: "project-b",
      captured_at: "2026-07-15T09:30:00.000Z",
      title: "Other project session",
    },
  ]);

  const context = await selectWorkingContext(
    aiosPath,
    { project: "stable-project-id" },
    { clock: fixedClock },
  );

  assert.equal(context.projectFilter, "project-a");
  assert.deepEqual(context.sessions.map((session) => session.session_id), ["matching-session"]);
  assert.equal(context.activeProject.slug, "project-a");
});

test("visible character budget bounds the canonical renderer and selected items", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "projects", "project-a"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "project-a", "README.md"),
    "---\nproject: project-a\nstatus: active\n---\n# Project A\n",
  );
  writeJsonl(path.join(aiosPath, "memory", "signals", "2026-07-15.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", project: "project-a", summary: `First ${"x".repeat(80)}` },
    { ts: "2026-07-15T08:00:00.000Z", project: "project-a", summary: `Second ${"y".repeat(80)}` },
    { ts: "2026-07-15T07:00:00.000Z", project: "project-a", summary: `Third ${"z".repeat(80)}` },
  ]);
  const options = {
    project: "project-a",
    visibleCharacterBudget: 170,
  };

  const first = await buildWorkingContext(aiosPath, options, { clock: fixedClock });
  const second = await buildWorkingContext(aiosPath, options, { clock: fixedClock });

  assert.equal(first.rendered, second.rendered);
  assert.equal(first.rendered, renderWorkingContext(first.context));
  assert.ok(first.rendered.length <= options.visibleCharacterBudget);
  assert.equal(first.context.budget.used, first.rendered.length);
  assert.equal(first.context.budget.truncated, true);
  assert.match(first.rendered, /\[context budget reached\]$/);
  assert.match(first.rendered, /Project A/);
  assert.ok(first.context.signals.length < 3);
});
