import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  rankSkills,
  resolveIntent,
  renderBootContext,
  MIN_SCORE
} from "../../packages/core/src/skill-resolver.mjs";

function skill(dir, name, description, triggers = []) {
  return { dir, name, description, triggers };
}

test("rankSkills returns the exact-name match first", () => {
  const skills = [
    skill("audit", "audit", "Weekly health check.", ["audit my aios", "health check"]),
    skill("plan", "plan-today", "Plan the day.", ["plan my day", "structure today"])
  ];
  const ranked = rankSkills("plan-today", skills);
  assert.equal(ranked[0].name, "plan-today");
  assert.ok(ranked[0].score >= 100, "exact-name hit scores at least 100");
});

test("rankSkills matches a trigger phrase by token overlap", () => {
  const skills = [
    skill("audit", "audit", "Weekly health check.", ["audit my aios", "review my setup"]),
    skill("plan", "plan-today", "Plan the day.", ["plan my day", "what should I work on"])
  ];
  const ranked = rankSkills("plan my day", skills);
  assert.equal(ranked[0].name, "plan-today");
  assert.ok(ranked[0].score > 0);
});

test("rankSkills matches on description overlap when no trigger hits", () => {
  const skills = [
    skill("audit", "audit", "Weekly health check of the local AIOS.", []),
    skill("plan", "plan-today", "Plan the day.", [])
  ];
  const ranked = rankSkills("health check of my aios", skills);
  assert.equal(ranked[0].name, "audit");
});

test("rankSkills is deterministic and sorted by score desc then specificity then name", () => {
  const skills = [
    skill("alpha", "alpha", "research the topic", ["research this", "deep research"]),
    skill("beta", "beta", "research the topic", ["research this"])
  ];
  const ranked = rankSkills("deep research", skills);
  assert.equal(ranked[0].name, "alpha");
});

test("rankSkills drops skills below MIN_SCORE", () => {
  const skills = [
    skill("audit", "audit", "Weekly health check.", ["audit my aios"]),
    skill("plan", "plan-today", "Plan the day.", ["plan my day"])
  ];
  const ranked = rankSkills("xyzzy quux", skills);
  assert.equal(ranked.length, 0);
});

test("resolveIntent returns top match and clears the no-match bar", () => {
  const skills = [
    skill("plan", "plan-today", "Plan the day.", ["plan my day", "structure today"])
  ];
  const match = resolveIntent("plan my day", skills);
  assert.equal(match.name, "plan-today");
  assert.ok(match.confidence > 0);
});

test("resolveIntent returns null when nothing matches", () => {
  const skills = [skill("plan", "plan-today", "Plan the day.", ["plan my day"])];
  assert.equal(resolveIntent("xyzzy quux", skills), null);
});

test("each ranked entry carries name, dir, triggers, description, score, skillPath, and reason", () => {
  const skills = [skill("plan", "plan-today", "Plan the day.", ["plan my day"])];
  const ranked = rankSkills("plan my day", skills, { skillsDir: "/aios/skills" });
  const entry = ranked[0];
  assert.equal(entry.name, "plan-today");
  assert.equal(entry.dir, "plan");
  assert.deepEqual(entry.triggers, ["plan my day"]);
  assert.equal(entry.description, "Plan the day.");
  assert.equal(entry.skillPath, path.join("/aios/skills", "plan", "SKILL.md"));
  assert.equal(typeof entry.score, "number");
  assert.equal(typeof entry.reason, "string");
  assert.ok(entry.reason.length > 0);
});

test("renderBootContext emits a Skills first block with the resolver rule and each skill", () => {
  const skills = [
    skill("plan", "plan-today", "Plan the day.", ["plan my day", "structure today"]),
    skill("audit", "audit", "Weekly health check.", ["audit my aios"])
  ];
  const md = renderBootContext(skills, { skillsDir: "/aios/skills" });
  assert.match(md, /## Skills first/);
  assert.match(md, /plan my day/);
  assert.match(md, /audit my aios/);
  assert.match(md, /skills\/plan\/SKILL\.md/);
  assert.match(md, /open that skill's SKILL\.md/i);
  assert.match(md, /hand-roll/i);
});

test("renderBootContext handles an empty skill set", () => {
  const md = renderBootContext([], { skillsDir: "/aios/skills" });
  assert.match(md, /No skills installed/);
});

test("bundled plan-today skill resolves from its real frontmatter triggers", async () => {
  const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
  const { collectSkills } = await import("../../packages/core/src/skills.mjs");
  const skills = await collectSkills(repoRoot);
  const ranked = rankSkills("plan my day", skills);
  assert.ok(ranked.length > 0, "expected at least one match against bundled skills");
  assert.equal(ranked[0].name, "plan-today");
});

test("MIN_SCORE is a small positive number", () => {
  assert.ok(MIN_SCORE > 0 && MIN_SCORE < 1);
});
