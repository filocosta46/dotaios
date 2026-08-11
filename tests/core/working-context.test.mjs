import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { isoDate } from "../../packages/core/src/memory.mjs";
import { deriveProjectionRows, renderSessionMarkdown } from "../../packages/core/src/session-codec.mjs";
import {
  buildWorkingContext,
  createWorkingContextProjection,
  renderWorkingContext,
  selectWorkingContext,
} from "../../packages/core/src/working-context.mjs";
import { createSessionStore } from "../../packages/core/src/session-store.mjs";

const FIXED_NOW = new Date("2026-07-15T10:00:00.000Z");

function tmpAios() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-working-context-test-"));
  fs.writeFileSync(path.join(directory, "aios.json"), '{"schema_version":"1.2.0"}\n');
  for (const relative of ["memory/daily", "memory/sessions", "memory/signals"]) {
    fs.mkdirSync(path.join(directory, relative), { recursive: true });
  }
  return directory;
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function writeSessionFixtures(aiosPath, rows) {
  const records = rows.map((row, index) => {
    const turnCount = Number.isInteger(row.turns) ? row.turns : 0;
    const session = {
      schema: 1,
      agent: row.agent || "manual",
      session_id: row.session_id,
      captured_at: row.captured_at,
      source_type: row.source_type || "manual",
      ...(row.source_path ? { source_path: row.source_path } : {}),
      ...(row.project ? { project: row.project } : {}),
      ...(row.project_id ? { project_id: row.project_id } : {}),
      turns: Array.from({ length: turnCount }, (_, turnIndex) => ({
        role: turnIndex % 2 === 0 ? "user" : "assistant",
        content: `fixture ${index + 1} turn ${turnIndex + 1}`,
      })),
      title: row.title ?? null,
    };
    const date = session.captured_at.slice(0, 10);
    const timestamp = session.captured_at.slice(0, 19).replaceAll(":", "-");
    const relativePath = `memory/sessions/${date}/${timestamp}_${session.agent}_${session.session_id}.md`;
    const absolutePath = path.join(aiosPath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, renderSessionMarkdown(session));
    return { session, relativePath };
  });
  writeJsonl(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    deriveProjectionRows(records),
  );
}

function fixedClock() {
  return new Date(FIXED_NOW.getTime());
}

test("working context refuses forged projection metadata instead of treating it as memory", async () => {
  const aiosPath = tmpAios();
  const store = createSessionStore({ aiosPath, clock: fixedClock });
  await store.capture({
    session: {
      agent: "codex",
      session_id: "canonical-session",
      captured_at: "2026-07-15T09:00:00.000Z",
      source_type: "manual",
      project: "project-a",
      title: "Canonical session title",
      turns: [{ role: "user", content: "Canonical session body" }],
    },
  });

  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const [row] = fs.readFileSync(indexPath, "utf8").trim().split("\n").map(JSON.parse);
  fs.writeFileSync(indexPath, `${JSON.stringify({ ...row, title: "FORGED_INDEX_TITLE" })}\n`);

  await assert.rejects(
    () => selectWorkingContext(aiosPath, { project: "project-a" }, { clock: fixedClock }),
    (error) => error?.code === "DOTAIOS_WORKING_CONTEXT_READ_FAILED"
      && error?.cause?.code === "DOTAIOS_SESSION_PROJECTION_DRIFT",
  );
});

test("working context omits conflicting canonical sessions and budgets the omission count", async () => {
  const aiosPath = tmpAios();
  writeSessionFixtures(aiosPath, [
    {
      session_id: "conflict-a",
      source_path: "/private/source/session.jsonl",
      captured_at: "2026-07-15T08:00:00.000Z",
      title: "CONFLICT_VERSION_A",
      turns: 1,
    },
    {
      session_id: "conflict-b",
      source_path: "/private/source/session.jsonl",
      captured_at: "2026-07-15T09:00:00.000Z",
      title: "CONFLICT_VERSION_B",
      turns: 2,
    },
  ]);

  const result = await buildWorkingContext(
    aiosPath,
    { visibleCharacterBudget: 256 },
    { clock: fixedClock },
  );

  assert.deepEqual(result.context.sessions, []);
  assert.equal(result.context.conflictsOmitted, 2);
  assert.match(result.rendered, /2 conflicting session records omitted/i);
  assert.doesNotMatch(result.rendered, /CONFLICT_VERSION_[AB]/);
  assert.ok(result.rendered.length <= 256);
  assert.equal(result.context.budget.used, result.rendered.length);
});

test("project-scoped working context does not reveal another project's conflict count", async () => {
  const aiosPath = tmpAios();
  writeSessionFixtures(aiosPath, [
    {
      session_id: "private-conflict-a",
      source_path: "/private/source/other-project.jsonl",
      project: "project-b",
      captured_at: "2026-07-15T08:00:00.000Z",
      title: "PRIVATE_CONFLICT_VERSION_A",
      turns: 1,
    },
    {
      session_id: "private-conflict-b",
      source_path: "/private/source/other-project.jsonl",
      project: "project-b",
      captured_at: "2026-07-15T09:00:00.000Z",
      title: "PRIVATE_CONFLICT_VERSION_B",
      turns: 2,
    },
  ]);

  const result = await buildWorkingContext(
    aiosPath,
    { project: "project-a", visibleCharacterBudget: 256 },
    { clock: fixedClock },
  );

  assert.equal(result.context.conflictsOmitted, 0);
  assert.doesNotMatch(result.rendered, /conflict|PRIVATE_CONFLICT/);
  assert.ok(result.rendered.length <= 256);
});

test("project-scoped working context reports only the selected project's conflicts", async () => {
  const aiosPath = tmpAios();
  writeSessionFixtures(aiosPath, [
    {
      session_id: "selected-conflict-a",
      source_path: "/private/source/selected-project.jsonl",
      project: "project-a",
      captured_at: "2026-07-15T08:00:00.000Z",
      title: "SELECTED_CONFLICT_VERSION_A",
      turns: 1,
    },
    {
      session_id: "selected-conflict-b",
      source_path: "/private/source/selected-project.jsonl",
      project: "project-a",
      captured_at: "2026-07-15T09:00:00.000Z",
      title: "SELECTED_CONFLICT_VERSION_B",
      turns: 2,
    },
    {
      session_id: "other-conflict-a",
      source_path: "/private/source/other-project.jsonl",
      project: "project-b",
      captured_at: "2026-07-15T08:30:00.000Z",
      title: "OTHER_CONFLICT_VERSION_A",
      turns: 1,
    },
    {
      session_id: "other-conflict-b",
      source_path: "/private/source/other-project.jsonl",
      project: "project-b",
      captured_at: "2026-07-15T09:30:00.000Z",
      title: "OTHER_CONFLICT_VERSION_B",
      turns: 2,
    },
  ]);

  const result = await buildWorkingContext(
    aiosPath,
    { project: "project-a", visibleCharacterBudget: 256 },
    { clock: fixedClock },
  );

  assert.equal(result.context.conflictsOmitted, 2);
  assert.match(result.rendered, /2 conflicting session records omitted/i);
  assert.doesNotMatch(result.rendered, /SELECTED_CONFLICT|OTHER_CONFLICT/);
  assert.ok(result.rendered.length <= 256);
});

test("project filter scopes sessions, namespaced signals, and events with stable ordering", async () => {
  const aiosPath = tmpAios();
  writeSessionFixtures(aiosPath, [
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
  writeSessionFixtures(aiosPath, [
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

test("scoped views authorize project and project_id attribution consistently", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "projects", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "projects", "beta"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "alpha", "README.md"),
    "---\nid: alpha-id\nproject: alpha\n---\n# Alpha\n",
  );
  fs.writeFileSync(
    path.join(aiosPath, "projects", "beta", "README.md"),
    "---\nid: beta-id\nproject: beta\n---\n# Beta\n",
  );

  const scopedRows = [
    { project: "alpha", project_id: "alpha-id", label: "ALPHA_BOTH" },
    { project_id: "alpha-id", label: "ALPHA_ID_ONLY" },
    { project: "alpha-id", label: "ALPHA_LEGACY_ID_IN_PROJECT" },
    { label: "GLOBAL_ROW" },
    { project_id: "beta-id", label: "BETA_ID_ONLY_SECRET" },
    { project: "alpha", project_id: "beta-id", label: "CONFLICTING_SECRET" },
    { project_id: "", label: "MALFORMED_EMPTY_SECRET" },
  ];

  // An empty project_id cannot be represented by strict canonical session
  // Markdown. Keep that malformed-attribution case on the signal/event
  // channels while the session fixture contains only valid canonical records.
  writeSessionFixtures(aiosPath, scopedRows.filter((row) => row.project_id !== "").map((row, index) => ({
    ...row,
    session_id: `session-${index}`,
    captured_at: `2026-07-15T0${index}:00:00.000Z`,
    title: row.label,
  })));
  writeJsonl(path.join(aiosPath, "memory", "signals", "2026-07-15.jsonl"), scopedRows.map((row, index) => ({
    ...row,
    ts: `2026-07-15T0${index}:00:00.000Z`,
    summary: row.label,
  })));
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), scopedRows.map((row, index) => ({
    ...row,
    ts: `2026-07-15T0${index}:00:00.000Z`,
    summary: row.label,
  })));

  for (const selector of ["alpha", "alpha-id"]) {
    const context = await selectWorkingContext(aiosPath, { project: selector }, { clock: fixedClock });
    const visible = [
      ...context.sessions.map((entry) => entry.title),
      ...context.signals.map((entry) => entry.summary),
      ...context.events.map((entry) => entry.summary),
    ];

    for (const label of ["BETA_ID_ONLY_SECRET", "CONFLICTING_SECRET", "MALFORMED_EMPTY_SECRET"]) {
      assert.equal(visible.includes(label), false, `${selector} must exclude ${label}`);
    }
    for (const label of ["ALPHA_BOTH", "ALPHA_ID_ONLY", "ALPHA_LEGACY_ID_IN_PROJECT", "GLOBAL_ROW"]) {
      assert.ok(visible.includes(label), `${selector} must include ${label}`);
    }
    assert.ok(context.sessions.find((entry) => entry.title === "GLOBAL_ROW")?.unscoped);
    assert.equal(context.sessions.find((entry) => entry.title === "ALPHA_ID_ONLY")?.unscoped, undefined);
  }
});

test("an ambiguous project alias requires a matching unique project_id", async () => {
  const aiosPath = tmpAios();
  for (const [slug, id] of [["alpha", "alpha-id"], ["beta", "beta-id"]]) {
    fs.mkdirSync(path.join(aiosPath, "projects", slug), { recursive: true });
    fs.writeFileSync(
      path.join(aiosPath, "projects", slug, "README.md"),
      `---\nid: ${id}\nproject: shared\n---\n# ${slug}\n`,
    );
  }
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), [
    {
      ts: "2026-07-15T09:00:00.000Z",
      project: "shared",
      summary: "AMBIGUOUS_ALIAS_SECRET",
    },
    {
      ts: "2026-07-15T08:00:00.000Z",
      project: "shared",
      project_id: "alpha-id",
      summary: "QUALIFIED_ALPHA_ALIAS",
    },
    {
      ts: "2026-07-15T07:00:00.000Z",
      project: "alpha",
      summary: "UNIQUE_ALPHA_SLUG",
    },
  ]);

  const context = await selectWorkingContext(aiosPath, { project: "alpha-id" }, { clock: fixedClock });

  assert.deepEqual(
    context.events.map((entry) => entry.summary),
    ["QUALIFIED_ALPHA_ALIAS", "UNIQUE_ALPHA_SLUG"],
  );
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
    async open(filePath, flags) {
      readPaths.push(filePath);
      return fs.promises.open(filePath, flags);
    },
    opendir: (...args) => fs.promises.opendir(...args),
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
  writeSessionFixtures(aiosPath, [
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

test("existing stable project id characters remain valid selectors", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "projects", "project-a"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "project-a", "README.md"),
    "---\nid: café:client/01\nproject: project-a\n---\n# Project A\n",
  );
  writeSessionFixtures(aiosPath, [{
    session_id: "matching-session",
    project: "project-a",
    captured_at: "2026-07-15T09:00:00.000Z",
    title: "Canonical project session",
  }]);

  const context = await selectWorkingContext(
    aiosPath,
    { project: "café:client/01" },
    { clock: fixedClock },
  );

  assert.equal(context.projectFilter, "project-a");
  assert.deepEqual(context.sessions.map((session) => session.session_id), ["matching-session"]);
});

test("supplied project selectors reject blank, non-string, oversized, and control input", async () => {
  const aiosPath = tmpAios();
  const invalid = [42, "   ", "x".repeat(201), "alpha\n", "alpha\u007f", "alpha\u0085"];

  for (const project of invalid) {
    await assert.rejects(
      selectWorkingContext(aiosPath, { project }, { clock: fixedClock }),
      TypeError,
      `expected selector ${JSON.stringify(project)} to fail`
    );
  }

  const unscoped = await selectWorkingContext(aiosPath, {}, { clock: fixedClock });
  assert.equal(unscoped.projectFilter, null);
});

test("project selector character limits count Unicode code points", async () => {
  const aiosPath = tmpAios();
  const maximum = "🚀".repeat(200);

  const accepted = await selectWorkingContext(
    aiosPath,
    { project: maximum },
    { clock: fixedClock }
  );
  assert.equal(accepted.projectFilter, maximum);
  await assert.rejects(
    selectWorkingContext(aiosPath, { project: `${maximum}🚀` }, { clock: fixedClock }),
    TypeError
  );
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
