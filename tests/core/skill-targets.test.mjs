import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkTargets, hermesConfigTargets } from "../../packages/core/src/skill-targets.mjs";

test("symlinkTargets includes Claude dir and the shared .agents/skills standard", () => {
  const dirs = symlinkTargets().map((t) => t.dir);
  assert.ok(dirs.includes(".claude/skills"));
  assert.ok(dirs.includes(".agents/skills"));
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
