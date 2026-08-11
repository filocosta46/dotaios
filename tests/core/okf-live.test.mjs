import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_SCOPES, searchAios } from "../../packages/core/src/search.mjs";
import { appendEvent } from "../../packages/core/src/memory.mjs";
import { selectWorkingContext, renderWorkingContext } from "../../packages/core/src/working-context.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-okf-live-test-"));
}

function isoAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// --- L1-4a: live per-shelf / per-project index.md ---

test("updateDirectoryIndex writes a deterministic index.md and no-ops on regen", async () => {
  const live = await import("../../packages/core/src/okf-live.mjs");
  assert.equal(typeof live.updateDirectoryIndex, "function");

  const dir = path.join(tmpDir(), "projects", "acme");
  fs.mkdirSync(path.join(dir, "plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "---\ntype: Project\ndescription: Acme client record\n---\n# Acme\n");
  fs.writeFileSync(path.join(dir, "notes.md"), "---\ndescription: Call notes\n---\n# Notes\n");
  fs.writeFileSync(path.join(dir, "plans", "q3.md"), "# Q3\n");
  fs.writeFileSync(path.join(dir, "log.md"), "# Log\n");

  const first = await live.updateDirectoryIndex(dir, { label: "projects/acme" });
  assert.equal(first.changed, true);
  const content = fs.readFileSync(path.join(dir, "index.md"), "utf8");
  assert.match(content, /\[README\]/);
  assert.match(content, /Acme client record/);
  assert.match(content, /\(Project\)/);
  assert.match(content, /\[notes\]/);
  assert.match(content, /Call notes/);
  assert.match(content, /plans/);
  assert.ok(!content.includes("[index]"), "index.md must not list itself");
  assert.ok(!content.includes("[log]"), "reserved log.md must not be listed as a doc");

  const second = await live.updateDirectoryIndex(dir, { label: "projects/acme" });
  assert.equal(second.changed, false, "no-op regen must not rewrite the file");
  assert.equal(fs.readFileSync(path.join(dir, "index.md"), "utf8"), content, "regen must be byte-identical");
});

// --- L1-4b: per-project log.md projected from events ---

test("writeProjectLog projects a project's lifecycle events, newest first", async () => {
  const live = await import("../../packages/core/src/okf-live.mjs");
  assert.equal(typeof live.writeProjectLog, "function");

  const aios = tmpDir();
  fs.mkdirSync(path.join(aios, "memory"), { recursive: true });
  fs.mkdirSync(path.join(aios, "projects", "acme"), { recursive: true });
  const events = [
    { ts: isoAgo(3), type: "memory-promotion", project: "acme", operation: "add", summary: "promoted pricing decision" },
    { ts: isoAgo(2), type: "note", project: "acme", summary: "unrelated chatter" },
    { ts: isoAgo(2), type: "memory-promotion", project: "other", operation: "add", summary: "other project promo" },
    { ts: isoAgo(1), type: "memory-promotion", project: "acme", operation: "supersede", summary: "superseded pricing v1" }
  ];
  fs.writeFileSync(
    path.join(aios, "memory", "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );

  const result = await live.writeProjectLog(aios, "acme");
  assert.equal(result.changed, true);
  const log = fs.readFileSync(path.join(aios, "projects", "acme", "log.md"), "utf8");
  assert.match(log, /supersede/);
  assert.match(log, /promoted pricing decision/);
  assert.ok(!log.includes("other project promo"), "other projects' events must not leak in");
  assert.ok(
    log.indexOf("superseded pricing v1") < log.indexOf("promoted pricing decision"),
    "log must be newest-first"
  );

  const again = await live.writeProjectLog(aios, "acme");
  assert.equal(again.changed, false, "no-op regen must not rewrite");
});

test("appendEvent with a project refreshes that project's log.md", async () => {
  const aios = tmpDir();
  fs.mkdirSync(path.join(aios, "memory"), { recursive: true });
  fs.mkdirSync(path.join(aios, "projects", "acme"), { recursive: true });

  await appendEvent(path.join(aios, "memory", "events.jsonl"), {
    type: "memory-promotion",
    project: "acme",
    operation: "add",
    summary: "live hook promotion"
  });

  const logPath = path.join(aios, "projects", "acme", "log.md");
  assert.ok(fs.existsSync(logPath), "appendEvent must refresh the project log on write");
  assert.match(fs.readFileSync(logPath, "utf8"), /live hook promotion/);
});

// --- L1-6: decisions searchable ---

test("decisions scope exists and finds entries in decisions/log.md", async () => {
  assert.ok(SEARCH_SCOPES.includes("decisions"), "decisions must be a first-class search scope");

  const aios = tmpDir();
  fs.mkdirSync(path.join(aios, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(aios, "decisions", "log.md"),
    "# Decision Log\n\n## 2026-07-01 Chose flat-file storage\n\nNo database; plain JSONL wins for portability.\n"
  );

  const groups = await searchAios({ aiosPath: aios, query: "flat-file storage", scope: "decisions", limit: 5 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].scope, "decisions");
  assert.equal(groups[0].results.length, 1);
  assert.match(groups[0].results[0].source, /^decisions\//);

  const all = await searchAios({ aiosPath: aios, query: "flat-file storage", scope: "all", limit: 5 });
  const decisionsGroup = all.find((group) => group.scope === "decisions");
  assert.ok(decisionsGroup, "all-scope search must include decisions");
  assert.equal(decisionsGroup.results.length, 1);
});

test("working-context projection includes the most recent decisions, bounded", async () => {
  const aios = tmpDir();
  fs.writeFileSync(path.join(aios, "aios.json"), '{"schema_version":"1.2.0"}\n');
  fs.mkdirSync(path.join(aios, "context"), { recursive: true });
  fs.mkdirSync(path.join(aios, "memory"), { recursive: true });
  fs.mkdirSync(path.join(aios, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(aios, "context", "identity.md"), "# Identity\n\nSolo consultant.\n");
  fs.writeFileSync(path.join(aios, "context", "priorities.md"), "# Priorities\n\nShip the launch.\n");
  const blocks = [];
  for (let i = 1; i <= 5; i++) {
    blocks.push(`## 2026-07-0${i} Decision number ${i}\n\nDetail for decision ${i}.`);
  }
  fs.writeFileSync(path.join(aios, "decisions", "log.md"), "# Decision Log\n\n" + blocks.join("\n\n") + "\n");

  const context = await selectWorkingContext(aios, {});
  const rendered = renderWorkingContext(context);
  assert.match(rendered, /### Decisions/, "projection must carry a Decisions section");
  assert.match(rendered, /Decision number 5/, "most recent decision must be present");
  assert.match(rendered, /Decision number 3/, "bounded window should reach back a few decisions");
  assert.ok(!rendered.includes("Decision number 1"), "old decisions must stay out of the bounded projection");
});
