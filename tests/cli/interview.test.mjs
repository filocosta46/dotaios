import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../../packages/cli/src/commands/interview.mjs";

function makeSources({ withPreferences = false, installedSkills = [] } = {}) {
  const sources = {
    target: "/aios",
    identityPath: "/aios/context/identity.md",
    workPath: "/aios/context/work.md",
    prioritiesPath: "/aios/context/priorities.md",
    preferencesPath: "/aios/context/preferences.md",
    identity: "# Identity\n\n## Basics\n\n- Name: A\n- Role: old role\n\n## More\n",
    work: "# Work\n\n## Current Work\n\nold work\n\n## Next\n\nkeep\n",
    priorities: "# Priorities\n\n## Current Bets\n\nold bets\n\n## Anti\n",
    preferences: withPreferences
      ? "# Preferences\n\n## Planning\n\n- Plan style: focused\n- Priorities per day: 3\n- Time blocks: yes\n- Frog definition: overdue tasks\n"
      : "",
    currentName: "A",
    currentRole: "old role",
    currentWork: "old work",
    currentPriorities: "old bets",
    currentPlanStyle: withPreferences ? "focused" : "",
    currentPrioritiesPerDay: withPreferences ? "3" : "",
    currentTimeBlocks: withPreferences ? "yes" : "",
    currentFrogDefinition: withPreferences ? "overdue tasks" : "",
    installedSkills: new Set(installedSkills),
    currentPrompts: {}
  };
  return sources;
}

function defaultAnswers(sources) {
  return {
    role: sources.currentRole,
    work: sources.currentWork,
    priorities: sources.currentPriorities,
    planStyle: sources.currentPlanStyle || "focused",
    prioritiesPerDay: sources.currentPrioritiesPerDay || "3",
    timeBlocks: sources.currentTimeBlocks || "yes",
    frogDefinition: sources.currentFrogDefinition || "overdue tasks"
  };
}

test("buildPlan returns empty when no answers changed and prefs file exists", () => {
  const sources = makeSources({ withPreferences: true });
  const plan = buildPlan("/aios", sources, defaultAnswers(sources));
  assert.deepEqual(plan, []);
});

test("buildPlan emits only files whose answer changed", () => {
  const sources = makeSources({ withPreferences: true });
  const answers = defaultAnswers(sources);
  answers.work = "new work";
  const plan = buildPlan("/aios", sources, answers);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, sources.workPath);
  assert.match(plan[0].content, /## Current Work\n\nnew work\n\n## Next/);
});

test("buildPlan updates identity bullet without touching unrelated content", () => {
  const sources = makeSources({ withPreferences: true });
  const answers = defaultAnswers(sources);
  answers.role = "new role";
  const plan = buildPlan("/aios", sources, answers);

  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, sources.identityPath);
  assert.match(plan[0].content, /- Role: new role/);
  assert.match(plan[0].content, /- Name: A/);
});

test("buildPlan handles all three context changes at once", () => {
  const sources = makeSources({ withPreferences: true });
  const answers = { ...defaultAnswers(sources), role: "r2", work: "w2", priorities: "p2" };
  const plan = buildPlan("/aios", sources, answers);

  assert.equal(plan.length, 3);
  const paths = plan.map((item) => item.path).sort();
  assert.deepEqual(paths, [
    sources.identityPath,
    sources.prioritiesPath,
    sources.workPath
  ].sort());
});

test("buildPlan skips entries when section missing in file", () => {
  const sources = makeSources({ withPreferences: true });
  sources.work = "# Work\n\nno section here\n";
  const answers = { ...defaultAnswers(sources), work: "new work" };
  const plan = buildPlan("/aios", sources, answers);
  assert.deepEqual(plan, []);
});

test("buildPlan creates preferences.md when missing", () => {
  const sources = makeSources();
  const answers = defaultAnswers(sources);
  const plan = buildPlan("/aios", sources, answers);

  const pref = plan.find((item) => item.path === sources.preferencesPath);
  assert.ok(pref, "expected preferences entry");
  assert.match(pref.content, /# Preferences/);
  assert.match(pref.content, /- Plan style: focused/);
  assert.match(pref.content, /- Priorities per day: 3/);
});

test("buildPlan updates existing preferences.md by bullet", () => {
  const sources = makeSources({ withPreferences: true });
  const answers = { ...defaultAnswers(sources), planStyle: "aggressive" };
  const plan = buildPlan("/aios", sources, answers);

  const pref = plan.find((item) => item.path === sources.preferencesPath);
  assert.ok(pref, "expected preferences entry");
  assert.match(pref.content, /- Plan style: aggressive/);
  assert.match(pref.content, /- Priorities per day: 3/);
});

test("buildPlan emits compiled prompt for installed skills only", () => {
  const sources = makeSources({ withPreferences: true, installedSkills: ["plan-today"] });
  const answers = { ...defaultAnswers(sources), planStyle: "balanced" };
  const plan = buildPlan("/aios", sources, answers);

  const prompts = plan.filter((item) => item.path.endsWith("prompt.md"));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].path.includes("plan-today"));
  assert.match(prompts[0].content, /Plan style: balanced/);
});

test("buildPlan skips compiled prompt when content matches existing", () => {
  const sources = makeSources({ withPreferences: true, installedSkills: ["plan-today"] });
  const answers = defaultAnswers(sources);
  const firstPlan = buildPlan("/aios", sources, answers);
  const initialPrompt = firstPlan.find((item) => item.path.endsWith("plan-today/prompt.md"));
  assert.ok(initialPrompt);

  sources.currentPrompts["plan-today"] = initialPrompt.content;
  const secondPlan = buildPlan("/aios", sources, answers);
  const prompts = secondPlan.filter((item) => item.path.endsWith("prompt.md"));
  assert.deepEqual(prompts, []);
});

test("buildPlan emits both compiled prompts when both skills are installed", () => {
  const sources = makeSources({ withPreferences: true, installedSkills: ["plan-today", "morning-digest"] });
  const answers = { ...defaultAnswers(sources), planStyle: "balanced" };
  const plan = buildPlan("/aios", sources, answers);

  const prompts = plan.filter((item) => item.path.endsWith("prompt.md"));
  assert.equal(prompts.length, 2);
  assert.ok(prompts.some((item) => item.path.includes("plan-today")));
  assert.ok(prompts.some((item) => item.path.includes("morning-digest")));
  for (const p of prompts) assert.match(p.content, /Plan style: balanced/);
});

test("buildPlan deduplicates morning-digest prompt on re-run", () => {
  const sources = makeSources({ withPreferences: true, installedSkills: ["morning-digest"] });
  const answers = defaultAnswers(sources);
  const firstPlan = buildPlan("/aios", sources, answers);
  const initialPrompt = firstPlan.find((item) => item.path.endsWith("morning-digest/prompt.md"));
  assert.ok(initialPrompt);

  sources.currentPrompts["morning-digest"] = initialPrompt.content;
  const secondPlan = buildPlan("/aios", sources, answers);
  const prompts = secondPlan.filter((item) => item.path.endsWith("prompt.md"));
  assert.deepEqual(prompts, []);
});
