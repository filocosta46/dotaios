import { test } from "node:test";
import assert from "node:assert/strict";
import {
  symlinkTargets,
  retiredSymlinkTargets,
  hermesConfigTargets
} from "../../packages/core/src/skill-targets.mjs";

test("symlinkTargets includes Claude dir and the shared .agents/skills standard", () => {
  const dirs = symlinkTargets().map((t) => t.dir);
  assert.ok(dirs.includes(".claude/skills"));
  assert.ok(dirs.includes(".agents/skills"));
  assert.ok(dirs.includes(".gemini/antigravity/skills"));
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

test("bundled Hermes has no project target without a runtime selector contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const registryPath = fileURLToPath(new URL("../../packages/core/src/agents.json", import.meta.url));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const hermes = registry.agents.find((agent) => agent.name === "Hermes");
  assert.equal(hermes.skills.project, undefined);
});

test("shared user Agent Skills coverage names documented clients", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const registryPath = fileURLToPath(new URL("../../packages/core/src/agents.json", import.meta.url));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const standard = registry.wellKnownSkillDirs.find((entry) => entry.name === "Agent Skills standard");

  assert.ok(standard.serves.includes("Gemini"));
  assert.ok(standard.serves.includes("Kimi Code CLI"));
  assert.ok(standard.serves.includes("OpenCode"));
  assert.ok(!standard.serves.includes("Antigravity IDE"));
});

test("registry keeps Antigravity's stable identity while using current IDE paths", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const registryPath = fileURLToPath(new URL("../../packages/core/src/agents.json", import.meta.url));
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const byName = new Map(registry.agents.map((agent) => [agent.name, agent]));

  assert.equal(byName.get("Cursor").skills.dir, ".agents/skills");
  assert.equal(byName.get("Gemini").skills.dir, ".agents/skills");
  assert.equal(byName.get("Antigravity").skills.dir, ".gemini/antigravity/skills");
  assert.equal(byName.get("Antigravity").skills.project.dir, ".agents/skills");
  assert.equal(byName.has("Antigravity IDE"), false);
});

test("retired native targets are explicit migration surfaces", () => {
  assert.deepEqual(retiredSymlinkTargets().map((target) => target.dir), [
    ".cursor/skills",
    ".gemini/skills",
    ".gemini/config/skills"
  ]);
});
