import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkTargets, retiredSymlinkTargets, hermesConfigTargets } from "../../packages/core/src/skill-targets.mjs";

test("symlinkTargets includes Claude dir and the shared .agents/skills standard", () => {
  const dirs = symlinkTargets().map((t) => t.dir);
  assert.ok(dirs.includes(".claude/skills"));
  assert.ok(dirs.includes(".agents/skills"));
  assert.ok(dirs.includes(".gemini/config/skills"));
  assert.ok(!dirs.includes(".cursor/skills"));
  assert.ok(!dirs.includes(".gemini/skills"));
});

test("symlinkTargets dedups .agents/skills (Codex + wellKnown)", () => {
  const dirs = symlinkTargets().map((t) => t.dir);
  assert.equal(dirs.filter((d) => d === ".agents/skills").length, 1);
});

test("hermesConfigTargets returns the Hermes external-dir target", () => {
  const t = hermesConfigTargets();
  assert.equal(t.length, 1);
  assert.equal(t[0].configFile, ".hermes/config.yaml");
  assert.equal(t[0].key, "skills.external_dirs");
});

test("shared Agent Skills coverage names Antigravity explicitly", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const registryPath = fileURLToPath(new URL("../../packages/core/src/agents.json", import.meta.url));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const standard = registry.wellKnownSkillDirs.find((entry) => entry.name === "Agent Skills standard");

  assert.ok(standard.serves.includes("Gemini"));
  assert.ok(!standard.serves.includes("Antigravity"));
});

test("registry records native paths for Cursor, Gemini, and Antigravity", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const registryPath = fileURLToPath(new URL("../../packages/core/src/agents.json", import.meta.url));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const byName = new Map(registry.agents.map((agent) => [agent.name, agent]));

  assert.equal(byName.get("Cursor").skills.dir, ".agents/skills");
  assert.equal(byName.get("Gemini").skills.dir, ".agents/skills");
  assert.equal(byName.get("Antigravity").skills.dir, ".gemini/config/skills");
});

test("retired native targets are explicit migration surfaces", () => {
  assert.deepEqual(retiredSymlinkTargets().map((target) => target.dir), [".cursor/skills", ".gemini/skills"]);
});
