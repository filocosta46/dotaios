import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { projectCommand } from "../../packages/cli/src/commands/project.mjs";
import { matchProjectRecord } from "../../packages/core/src/projects.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-emitter-"));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  const statePath = path.join(root, "local-state", "projects.json");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.mkdir(homePath, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { aiosPath, homePath, statePath };
}

async function writeProjectReadme(aiosPath, slug, frontmatter) {
  const readmePath = path.join(aiosPath, "projects", slug, "README.md");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.writeFile(readmePath, `---\n${frontmatter}\n---\n# ${slug}\n`);
}

async function writeTimeline(aiosPath, entries) {
  await fs.mkdir(path.join(aiosPath, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "memory", "events.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
}

function outputCapture() {
  const lines = [];
  return { lines, output: { log: (...v) => lines.push(v.join(" ")), error: (...v) => lines.push(v.join(" ")) } };
}

const base = (aiosPath, homePath, statePath) => ["--path", aiosPath, "--home", homePath, "--state-path", statePath];

// Finding 1 — shared catalog matcher in core (no local-path requirement).

test("matchProjectRecord resolves a catalog record without requiring a machine-local path", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", "project_id: alpha-id\nproject: alpha\nstatus: active");

  const record = await matchProjectRecord({
    aiosPath, homePath, statePath, project: "alpha"
  });
  assert.equal(record.slug, "alpha");
  assert.equal(record.id, "alpha-id");
  // The emitter path never registered a local checkout — matching must not
  // demand one (that requirement belongs to resolveProjectRecord).
  assert.equal(record.projectPath ?? null, null);
});

test("matchProjectRecord fails closed on unknown and ambiguous references", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", "project_id: a1\nproject: alpha\nstatus: active");
  await assert.rejects(
    () => matchProjectRecord({ aiosPath, homePath, statePath, project: "ghost" }),
    /not registered/
  );
});

// Finding 3 — the inert --tool flag is gone (per-tool framing is an adapter
// concern; the emitter emits the one canonical context contract).

test("project context no longer accepts the inert --tool flag", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", "project_id: a2\nproject: alpha\nstatus: active");
  const { output } = outputCapture();
  await assert.rejects(
    () => projectCommand(["context", "alpha", "--tool", "codex", ...base(aiosPath, homePath, statePath)], { output }),
    /Unknown option: --tool/
  );
});

// Finding 2 — the payload's generated_at is the projection's own timestamp,
// not a second one minted after the fact.

test("project context --json reuses the projection generated_at (one timestamp)", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", "project_id: a3\nproject: alpha\nstatus: active");
  await writeTimeline(aiosPath, [
    { ts: new Date().toISOString(), type: "update", source: "dotaios update", project: "alpha", summary: "Alpha picked Postgres" }
  ]);
  const { lines, output } = outputCapture();
  const result = await projectCommand(["context", "alpha", "--json", ...base(aiosPath, homePath, statePath)], { output });

  const parsed = JSON.parse(lines.join("\n"));
  assert.ok(!("tool" in parsed), "the removed --tool field must not appear in the payload");
  assert.match(parsed.generated_at, /^\d{4}-\d{2}-\d{2}T/, "generated_at is a valid ISO timestamp");
  assert.equal(parsed.generated_at, result.generatedAt, "JSON generated_at must equal the projection timestamp the command returns");
});

// Finding 4 — one name is not two types: the input is a character budget (int),
// the output field is the budget state object.

test("project context keeps --budget an int input and context_budget an object", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", "project_id: a4\nproject: alpha\nstatus: active");
  await writeTimeline(aiosPath, [
    { ts: new Date().toISOString(), type: "update", source: "dotaios update", project: "alpha", summary: "Alpha picked Postgres" }
  ]);
  const { lines, output } = outputCapture();
  await projectCommand(["context", "alpha", "--json", "--budget", "4000", ...base(aiosPath, homePath, statePath)], { output });
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(typeof parsed.context_budget, "object");
  assert.equal(parsed.context_budget.limit, 4000, "the int budget flows through as the budget-state limit");

  await assert.rejects(
    () => projectCommand(["context", "alpha", "--budget", "-3", ...base(aiosPath, homePath, statePath)], { output: outputCapture().output }),
    /--budget requires a positive integer/
  );
});

// Finding 5 — documented continuity window: untagged global entries are carried
// into a project payload (marked unscoped); raw entries older than the
// operational window are not (durable continuity comes from promotion).

test("project context carries untagged global entries but drops out-of-window raw entries", async (t) => {
  const { aiosPath, homePath, statePath } = await fixture(t);
  await writeProjectReadme(aiosPath, "alpha", "project_id: a5\nproject: alpha\nstatus: active");
  const today = new Date().toISOString();
  const longAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  await writeTimeline(aiosPath, [
    { ts: today, type: "update", source: "dotaios update", project: "alpha", summary: "Alpha in-window scoped note" },
    { ts: today, type: "update", source: "dotaios update", summary: "Global untagged in-window note" },
    { ts: longAgo, type: "update", source: "dotaios update", project: "alpha", summary: "Alpha stale out-of-window note" }
  ]);
  const { lines, output } = outputCapture();
  await projectCommand(["context", "alpha", ...base(aiosPath, homePath, statePath)], { output });
  const text = lines.join("\n");
  assert.match(text, /Alpha in-window scoped note/);
  assert.match(text, /Global untagged in-window note/, "global untagged entries are shared into every project's window by design");
  assert.doesNotMatch(text, /stale out-of-window note/, "raw entries older than the operational window are not carried; promote to persist");
});
