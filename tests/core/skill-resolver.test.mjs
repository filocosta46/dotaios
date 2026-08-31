import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import assert from "node:assert/strict";
import {
  rankSkills,
  resolveIntent,
  renderBootContext,
  MIN_SCORE
} from "../../packages/core/src/skill-resolver.mjs";
import { renderResolver } from "../../packages/core/src/skills.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const exactCli = `npx dotaios@${packageVersion}`;

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

test("renderBootContext keeps a backslash before a pipe inside one markdown table cell", () => {
  const md = renderBootContext([
    skill("audit", "audit", "Weekly health check.", ["review \\| audit"])
  ], { skillsDir: "/aios/skills" });

  assert.ok(md.includes(`review ${"\\".repeat(3)}| audit`));
});

test("boot context and resolver keep adversarial dynamic values inside one table row", () => {
  const skills = [{
    name: "safe\n| forged-name | extra |",
    dir: "safe\r| forged-directory | extra |",
    description: "safe\n| forged-description | extra |",
    triggers: ["safe\r# forged-heading", "safe\n| forged-trigger | extra |"]
  }];

  const bootContext = renderBootContext(skills, { skillsDir: "/aios/skills" });
  const resolver = renderResolver(skills);

  for (const output of [bootContext, resolver]) {
    assert.equal(output.split("\n").filter((line) => line.startsWith("|")).length, 3);
    assert.doesNotMatch(output, /[\r\n]\| forged-/);
    assert.doesNotMatch(output, /\r/);
  }
});

test("renderBootContext handles a bounded whitespace-only trigger in linear time", () => {
  const whitespace = " ".repeat(32 * 1024);
  const startedAt = performance.now();

  const md = renderBootContext([
    skill("audit", "audit", "Weekly health check.", [whitespace])
  ], { skillsDir: "/aios/skills" });

  assert.ok(md.includes(whitespace));
  assert.ok(performance.now() - startedAt < 150, "table-cell normalization must stay linear");
});

test("renderBootContext handles an empty skill set", () => {
  const md = renderBootContext([], { skillsDir: "/aios/skills" });
  assert.match(md, /No skills installed/);
  assert.match(md, new RegExp(`${exactCli.replaceAll(".", "\\.")} skill add <local-folder>`));
  assert.doesNotMatch(md, /`dotaios\s+[a-z]|npx dotaios(?!@)/);
});

test("bundled plan-today skill resolves from its real frontmatter triggers", async () => {
  const { collectSkills } = await import("../../packages/core/src/skills.mjs");
  const skills = await collectSkills(repoRoot);
  const ranked = rankSkills("plan my day", skills);
  assert.ok(ranked.length > 0, "expected at least one match against bundled skills");
  assert.equal(ranked[0].name, "plan-today");
});

test("MIN_SCORE is a small positive number", () => {
  assert.ok(MIN_SCORE > 0 && MIN_SCORE < 1);
});

// --- ranking hardening (1.27.1) -------------------------------------------
// scoreOne used to ACCUMULATE across every trigger, so declaring more triggers
// raised a skill's score on intents it did not match. Measured against the real
// folder: "start my day" scored today 1.682 and closeday 1.095, and closeday's
// 1.095 came almost entirely from two of its five triggers each contributing on
// the shared low-information token "day".

const DAY_SKILLS = [
  {
    dir: "today",
    name: "today",
    description: "Build today's plan and save it as a daily note.",
    triggers: ["start my day", "open today's note", "today's plan", "build today"]
  },
  {
    dir: "closeday",
    name: "closeday",
    description: "Close out the day and carry tasks over.",
    triggers: ["close the day", "wrap up today", "end of day", "log what I shipped", "close out my daily note"]
  }
];

test("a shared low-information token cannot lift a skill above the real match", () => {
  const ranked = rankSkills("start my day", DAY_SKILLS);
  assert.equal(ranked[0].dir, "today");
  assert.ok(
    ranked[0].score > (ranked[1]?.score ?? 0),
    `today must outrank closeday, got ${JSON.stringify(ranked.map((r) => [r.dir, r.score]))}`
  );
});

test("adding more triggers cannot raise a skill's score on an unrelated intent", () => {
  const lean = [{ dir: "closeday", name: "closeday", description: "Close out the day.", triggers: ["close the day"] }];
  const padded = [{
    dir: "closeday",
    name: "closeday",
    description: "Close out the day.",
    triggers: ["close the day", "end of day", "finish the day", "wrap the day", "day done"]
  }];

  const leanScore = rankSkills("start my day", lean)[0]?.score ?? 0;
  const paddedScore = rankSkills("start my day", padded)[0]?.score ?? 0;
  assert.ok(
    paddedScore <= leanScore + 1e-9,
    `padding triggers must not inflate rank: lean ${leanScore} vs padded ${paddedScore}`
  );
});

test("confidence separates a clear winner from a near tie", () => {
  const clear = resolveIntent("start my day", DAY_SKILLS);
  assert.equal(clear.dir, "today");
  assert.equal(clear.ambiguous, false);

  const tie = resolveIntent("day", [
    { dir: "alpha", name: "alpha", description: "Day handling.", triggers: ["day"] },
    { dir: "beta", name: "beta", description: "Day handling.", triggers: ["day"] }
  ]);

  assert.ok(
    tie.confidence < clear.confidence,
    `a tie must report lower confidence than a clear win: tie ${tie.confidence} vs clear ${clear.confidence}`
  );
  assert.ok(tie.confidence <= 0.6, `a two-way tie should sit near 0.5, got ${tie.confidence}`);
  assert.equal(tie.ambiguous, true, "an exact tie must not be presented as a governing match");
});

test("an exact name match still reports full confidence", () => {
  const hit = resolveIntent("today", DAY_SKILLS);
  assert.equal(hit.dir, "today");
  assert.equal(hit.confidence, 1);
});

test("duplicate exact skill names remain ambiguous", () => {
  const hit = resolveIntent("duplicate", [
    skill("alpha", "duplicate", "First duplicate.", []),
    skill("beta", "duplicate", "Second duplicate.", [])
  ]);

  assert.equal(hit.confidence, 0.5);
  assert.equal(hit.ambiguous, true);
});

test("resolveIntent exposes the raw score alongside confidence", () => {
  const hit = resolveIntent("start my day", DAY_SKILLS);
  assert.equal(typeof hit.score, "number");
  assert.ok(hit.score > 0);
});
