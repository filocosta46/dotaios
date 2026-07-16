import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

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
  assert.ok(context.sessions.every((item) => item.project === "project-a"));
  assert.ok(context.signals.every((item) => item.project === "project-a"));
  assert.ok(context.events.every((item) => item.project === "project-a"));
  assert.doesNotMatch(rendered, /Project B|Stale A/);
});

test("captured project catalog keeps README context and excludes runtime paths", async () => {
  const aiosPath = tmpAios();
  const readPaths = [];
  const filesystem = {
    async readFile(filePath, encoding) {
      readPaths.push(filePath);
      return fsp.readFile(filePath, encoding);
    },
    readdir: (...args) => fsp.readdir(...args),
  };
  const projectCatalog = [
    {
      id: "project-id-a",
      slug: "project-a",
      status: "active",
      domain: ["build"],
      repoUrl: "https://example.com/project-a.git",
      path: "/private/tmp/machine-only/projects/project-a/README.md",
      rootPath: "/private/tmp/machine-only/projects/project-a",
      projectPath: "/private/tmp/machine-only/projects/project-a",
      readmePath: "/private/tmp/machine-only/aios/projects/project-a/README.md",
      pathAvailable: true,
      readme: "---\nproject: project-a\nstatus: active\ndomain: [build]\n---\n# Project A\n\nDurable project context.\n",
    },
  ];
  const projection = createWorkingContextProjection({ filesystem, clock: fixedClock, projectCatalog });

  const { context, rendered } = await projection.build(aiosPath, { project: "project-a" });

  assert.equal(context.activeProject.name, "Project A");
  assert.equal(context.activeProject.id, "project-id-a");
  assert.equal(context.activeProject.repoUrl, "https://example.com/project-a.git");
  assert.equal(context.activeProject.readme.includes("Durable project context."), true);
  assert.equal(Object.hasOwn(context.activeProject, "path"), false);
  assert.equal(Object.hasOwn(context.activeProject, "rootPath"), false);
  assert.equal(Object.hasOwn(context.activeProject, "projectPath"), false);
  assert.equal(Object.hasOwn(context.activeProject, "readmePath"), false);
  assert.equal(Object.hasOwn(context.activeProject, "pathAvailable"), false);
  assert.doesNotMatch(rendered, /private\/tmp|machine-only/);
  assert.match(rendered, /Project A · active · build/);
  assert.equal(readPaths.some((filePath) => filePath.includes(`${path.sep}projects${path.sep}`)), false);
});

test("stable project id resolves to the canonical slug before filtering", async () => {
  const aiosPath = tmpAios();
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
    {
      project: "stable-project-id",
      projectCatalog: [{ id: "stable-project-id", slug: "project-a", name: "Project A" }],
    },
    { clock: fixedClock },
  );

  assert.equal(context.projectFilter, "project-a");
  assert.deepEqual(context.sessions.map((session) => session.session_id), ["matching-session"]);
  assert.equal(context.activeProject.slug, "project-a");
});

test("visible character budget bounds the canonical renderer and selected items", async () => {
  const aiosPath = tmpAios();
  writeJsonl(path.join(aiosPath, "memory", "signals", "2026-07-15.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", project: "project-a", summary: `First ${"x".repeat(80)}` },
    { ts: "2026-07-15T08:00:00.000Z", project: "project-a", summary: `Second ${"y".repeat(80)}` },
    { ts: "2026-07-15T07:00:00.000Z", project: "project-a", summary: `Third ${"z".repeat(80)}` },
  ]);
  const options = {
    project: "project-a",
    visibleCharacterBudget: 170,
    projectCatalog: [{ slug: "project-a", name: "Project A", status: "active" }],
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
