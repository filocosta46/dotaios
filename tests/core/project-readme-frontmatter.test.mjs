import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

import { registerProject } from "../../packages/core/src/projects.mjs";

async function registerApprovedProject(options) {
  const preview = await registerProject({ ...options, apply: false, yes: false });
  return registerProject({
    ...options,
    operationId: preview.operationId,
    planFingerprint: preview.planFingerprint,
    apply: true,
    yes: false
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-project-frontmatter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const statePath = path.join(root, "state", "projects.json");
  await fs.mkdir(path.join(aiosPath, "projects"), { recursive: true });
  await fs.writeFile(path.join(aiosPath, "aios.json"), `${JSON.stringify({ schema_version: "1.2.0" })}\n`);
  await fs.writeFile(path.join(aiosPath, ".gitignore"), "/workspaces/\n");
  return { aiosPath, statePath };
}

async function registerWidget(aiosPath, statePath) {
  const projectPath = path.join(aiosPath, "workspaces", "widget");
  await fs.mkdir(projectPath, { recursive: true });
  await registerApprovedProject({
    aiosPath,
    statePath,
    projectPath,
    slug: "widget",
    purpose: "Coordinate the widget launch",
    yes: true,
    createId: () => "widget-id",
    readRepoUrl: async () => "https://github.com/acme/widget.git"
  });
  return fs.readFile(path.join(aiosPath, "projects", "widget", "README.md"), "utf8");
}

function frontmatterOf(readme) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readme);
  assert.ok(match, "README must open with a YAML frontmatter block");
  return match[1];
}

test("a generated project README uses block frontmatter, one key per line", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const frontmatter = frontmatterOf(await registerWidget(aiosPath, statePath));

  assert.ok(
    !frontmatter.trimStart().startsWith("{"),
    `frontmatter must not be a YAML flow mapping, got:\n${frontmatter}`
  );
  assert.match(frontmatter, /^id: widget-id$/m);
  assert.match(frontmatter, /^project: widget$/m);
  assert.match(frontmatter, /^description: Coordinate the widget launch$/m);
});

test("a generated project README survives a caller that injects its own key", async (t) => {
  // This is what `dotaios export-okf` does: it prepends `type: Project` to the
  // frontmatter it read back. A flow mapping makes the result unparseable,
  // which is how the OKF export broke.
  const { aiosPath, statePath } = await fixture(t);
  const frontmatter = frontmatterOf(await registerWidget(aiosPath, statePath));

  const injected = parseDocument(`type: Project\n${frontmatter}\n`, { strict: true, uniqueKeys: true });
  assert.deepEqual(injected.errors, [], `injecting a key must keep the frontmatter parseable:\n${frontmatter}`);
  assert.equal(injected.toJS().type, "Project");
  assert.equal(injected.toJS().id, "widget-id");
});

test("a README with no frontmatter gains block frontmatter, not a flow mapping", async (t) => {
  const { aiosPath, statePath } = await fixture(t);
  const readmePath = path.join(aiosPath, "projects", "widget", "README.md");
  await fs.mkdir(path.dirname(readmePath), { recursive: true });
  await fs.writeFile(readmePath, "# widget\n\nNotes written by hand, no frontmatter yet.\n");

  const frontmatter = frontmatterOf(await registerWidget(aiosPath, statePath));
  assert.ok(
    !frontmatter.trimStart().startsWith("{"),
    `frontmatter must not be a YAML flow mapping, got:\n${frontmatter}`
  );
  assert.match(frontmatter, /^id: widget-id$/m);
});
