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

function registerProject(aiosPath, slug, id = `${slug}-id`) {
  const directory = path.join(aiosPath, "projects", slug);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "README.md"),
    `---\nid: ${id}\nproject: ${slug}\nstatus: active\n---\n# ${slug}\n`,
  );
}

function fixedClock() {
  return new Date(FIXED_NOW.getTime());
}

test("project filter scopes sessions, namespaced signals, and events with stable ordering", async () => {
  const aiosPath = tmpAios();
  registerProject(aiosPath, "project-a");
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

test("This project memory exposes only its README and explicitly attributed continuity", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "context"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "projects", "project-a"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "projects", "project-b"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "context", "identity.md"), "# Identity\n\nGLOBAL_IDENTITY_SECRET\n");
  fs.writeFileSync(path.join(aiosPath, "context", "priorities.md"), "# Priorities\n\nGLOBAL_PRIORITY_SECRET\n");
  fs.writeFileSync(path.join(aiosPath, "decisions", "log.md"), "## 2026-07-15 GLOBAL_DECISION_SECRET\n");
  fs.writeFileSync(path.join(aiosPath, "memory", "daily", "2026-07-15.md"), "## Focus\nGLOBAL_DAILY_SECRET\n");
  fs.writeFileSync(
    path.join(aiosPath, "projects", "project-a", "README.md"),
    "---\nid: project-a-id\nproject: project-a\nstatus: active\n---\n# Project A\n\nPROJECT_A_README\n",
  );
  fs.writeFileSync(
    path.join(aiosPath, "projects", "project-b", "README.md"),
    "---\nid: project-b-id\nproject: project-b\nstatus: active\n---\n# Project B\n\nPROJECT_B_README_SECRET\n",
  );
  writeJsonl(path.join(aiosPath, "memory", "sessions", "index.jsonl"), [
    { session_id: "a", project_id: "project-a-id", captured_at: "2026-07-15T09:00:00.000Z", title: "PROJECT_A_SESSION" },
    { session_id: "b", project_id: "project-b-id", captured_at: "2026-07-15T08:00:00.000Z", title: "PROJECT_B_SESSION_SECRET" },
    { session_id: "global", captured_at: "2026-07-15T07:00:00.000Z", title: "UNSCOPED_SESSION_SECRET" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "signals", "2026-07-15.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", project: "project-a", summary: "PROJECT_A_SIGNAL" },
    { ts: "2026-07-15T08:00:00.000Z", summary: "UNSCOPED_SIGNAL_SECRET" },
  ]);
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", project: "project-a", project_id: "project-a-id", summary: "PROJECT_A_EVENT" },
    { ts: "2026-07-15T08:00:00.000Z", project: "project-b", summary: "PROJECT_B_EVENT_SECRET" },
  ]);

  const { context, rendered } = await buildWorkingContext(
    aiosPath,
    { memory: "project", project: "project-a-id" },
    { clock: fixedClock },
  );

  assert.equal(context.memoryMode, "project");
  assert.match(rendered, /^Memory: This project\b/);
  assert.match(rendered, /PROJECT_A_README|PROJECT_A_SESSION|PROJECT_A_SIGNAL|PROJECT_A_EVENT/);
  assert.doesNotMatch(
    rendered,
    /GLOBAL_|UNSCOPED_|PROJECT_B_|### Identity|### Priorities|### Decisions|### Today|### Carry-overs/,
  );
});

test("Off returns its fixed receipt without consulting the AIOS folder or clock", async () => {
  let filesystemCalls = 0;
  const unreadableFilesystem = new Proxy({}, {
    get() {
      return async () => {
        filesystemCalls += 1;
        throw new Error("Off touched the filesystem");
      };
    },
  });

  const { context, rendered } = await buildWorkingContext(
    "/canonical/aios/must-not-be-opened",
    { memory: "off" },
    {
      filesystem: unreadableFilesystem,
      clock: () => { throw new Error("Off consulted the clock"); },
    },
  );

  assert.equal(filesystemCalls, 0);
  assert.equal(context.memoryMode, "off");
  assert.equal(
    rendered,
    "Memory: Off\n\nDotAIOS is off; your AI app may still keep its own conversation history. DotAIOS did not read, search, save, or capture this turn.",
  );
});

test("This project memory rejects an unregistered selector instead of trusting matching row text", async () => {
  const aiosPath = tmpAios();
  writeJsonl(path.join(aiosPath, "memory", "events.jsonl"), [
    { ts: "2026-07-15T09:00:00.000Z", project: "ghost", summary: "UNREGISTERED_PROJECT_CANARY" },
  ]);
  await assert.rejects(
    () => selectWorkingContext(aiosPath, { memory: "project", project: "ghost" }, { clock: fixedClock }),
    (error) => error?.code === "DOTAIOS_PROJECT_SELECTOR_UNKNOWN"
  );
});

test("This project views exclude unattributed evidence and other projects", async () => {
  const aiosPath = tmpAios();
  registerProject(aiosPath, "project-a");
  registerProject(aiosPath, "project-b");
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
  assert.doesNotMatch(scopedA.rendered, /Unscoped fact|Unscoped update|unscoped/);
  assert.match(scopedB.rendered, /B fact|B update/);
  assert.doesNotMatch(scopedB.rendered, /A fact|A update/);
  assert.doesNotMatch(scopedB.rendered, /Unscoped fact|Unscoped update|unscoped/);
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

  writeJsonl(path.join(aiosPath, "memory", "sessions", "index.jsonl"), scopedRows.map((row, index) => ({
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

    for (const label of ["GLOBAL_ROW", "BETA_ID_ONLY_SECRET", "CONFLICTING_SECRET", "MALFORMED_EMPTY_SECRET"]) {
      assert.equal(visible.includes(label), false, `${selector} must exclude ${label}`);
    }
    for (const label of ["ALPHA_BOTH", "ALPHA_ID_ONLY", "ALPHA_LEGACY_ID_IN_PROJECT"]) {
      assert.ok(visible.includes(label), `${selector} must include ${label}`);
    }
    assert.equal(context.sessions.find((entry) => entry.title === "GLOBAL_ROW"), undefined);
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
  registerProject(aiosPath, "project-a");
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

test("compact projection strips identity frontmatter without changing source files", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "context"), { recursive: true });
  const identityPath = path.join(aiosPath, "context", "identity.md");
  const prioritiesPath = path.join(aiosPath, "context", "priorities.md");
  fs.writeFileSync(identityPath, "---\nsource: private-import\nkind: context\n---\n# Identity\n\nI lead the launch.\n");
  fs.writeFileSync(prioritiesPath, "---\nupdated_at: 2026-08-13\n---\n# Priorities\n\nShip the trust release.\n");
  const before = [fs.readFileSync(identityPath), fs.readFileSync(prioritiesPath)];

  const result = await buildWorkingContext(aiosPath, {}, { clock: fixedClock });

  assert.match(result.rendered, /I lead the launch/);
  assert.match(result.rendered, /Ship the trust release/);
  assert.doesNotMatch(result.rendered, /private-import|updated_at|kind: context|^---$/m);
  assert.deepEqual([fs.readFileSync(identityPath), fs.readFileSync(prioritiesPath)], before);
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

test("existing stable project id characters remain valid selectors", async () => {
  const aiosPath = tmpAios();
  fs.mkdirSync(path.join(aiosPath, "projects", "project-a"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "projects", "project-a", "README.md"),
    "---\nid: café:client/01\nproject: project-a\n---\n# Project A\n",
  );
  writeJsonl(path.join(aiosPath, "memory", "sessions", "index.jsonl"), [{
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
  registerProject(aiosPath, "maximum-selector", maximum);

  const accepted = await selectWorkingContext(
    aiosPath,
    { project: maximum },
    { clock: fixedClock }
  );
  assert.equal(accepted.projectFilter, "maximum-selector");
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
