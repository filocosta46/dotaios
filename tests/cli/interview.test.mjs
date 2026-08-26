import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, renderInterviewRecap } from "../../packages/cli/src/commands/interview.mjs";

test("renderInterviewRecap reflects name, role, work, priorities and hands off to the agent", () => {
  const recap = renderInterviewRecap({
    name: "Avery",
    role: "founder",
    work: "shipping DotAIOS 1.18",
    priorities: "launch the new website"
  });
  assert.match(recap, /Avery/);
  assert.match(recap, /founder/);
  assert.match(recap, /shipping DotAIOS 1\.18/);
  assert.match(recap, /launch the new website/);
  assert.match(recap, /what's the one thing to focus on today/i);
});

test("renderInterviewRecap degrades cleanly when name is missing (no leading comma)", () => {
  const recap = renderInterviewRecap({ name: "", role: "founder", work: "the site", priorities: "ship it" });
  assert.doesNotMatch(recap, /:\s*,/); // no "Here's what I've got: , founder"
  assert.match(recap, /founder/);
});

test("renderInterviewRecap returns null when there is nothing to reflect", () => {
  assert.equal(renderInterviewRecap({ name: "", role: "", work: "", priorities: "" }), null);
});

test("renderInterviewRecap uses only the first line of multi-line work and priorities", () => {
  const recap = renderInterviewRecap({
    name: "A",
    role: "x",
    work: "first work line\nsecond line should not appear",
    priorities: "first priority line\nsecond priority should not appear"
  });
  assert.match(recap, /first work line/);
  assert.doesNotMatch(recap, /second line should not appear/);
  assert.doesNotMatch(recap, /second priority should not appear/);
});

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

test("buildPlan ignores removed brief skills even if old folders exist", () => {
  const sources = makeSources({ withPreferences: true, installedSkills: ["plan-today", "morning-digest"] });
  const answers = { ...defaultAnswers(sources), planStyle: "balanced" };
  const plan = buildPlan("/aios", sources, answers);

  const prompts = plan.filter((item) => item.path.endsWith("prompt.md"));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].path.includes("plan-today"));
  assert.doesNotMatch(prompts[0].path, /morning-digest/);
});

test("generated interview guidance pins the exact candidate without changing bundled skill bytes", () => {
  const sources = makeSources({ withPreferences: true, installedSkills: ["plan-today"] });
  sources.preferences = [
    "# Preferences",
    "",
    "How you want AI agents to plan your day. Edit by hand or re-run `dotaios interview`.",
    "",
    "## Planning",
    "",
    "- Plan style: focused",
    "- Priorities per day: 3",
    "- Time blocks: yes",
    "- Frog definition: overdue tasks",
    ""
  ].join("\n");

  const plan = buildPlan("/aios", sources, defaultAnswers(sources), {
    cli: "npx dotaios@2.0.11"
  });
  const preferences = plan.find((item) => item.path === sources.preferencesPath);
  const prompt = plan.find((item) => item.path.endsWith("plan-today/prompt.md"));
  assert.match(preferences.content, /`npx dotaios@2\.0\.11 interview`/);
  assert.match(prompt.content, /`npx dotaios@2\.0\.11 interview`/);
  assert.doesNotMatch(preferences.content, /`(?:dotaios|npx dotaios) interview`/);
  assert.doesNotMatch(prompt.content, /`(?:dotaios|npx dotaios) interview`/);
});

test("generated interview guidance emits no runnable fallback without candidate identity", () => {
  const sources = makeSources({ installedSkills: ["plan-today"] });
  const plan = buildPlan("/aios", sources, defaultAnswers(sources), { cli: null });

  for (const item of plan.filter((entry) =>
    entry.path === sources.preferencesPath || entry.path.endsWith("prompt.md")
  )) {
    assert.doesNotMatch(item.content, /`(?:dotaios|npx\s+dotaios)[^`]*`/);
    assert.match(item.content, /candidate version was unavailable/i);
  }
});
