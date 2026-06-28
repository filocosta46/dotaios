import path from "node:path";

// Deterministic, local intent -> skill ranking. No embeddings, no network, no
// model calls. Shared by the CLI (`dotaios skills resolve`) and the MCP server
// (`resolve_skill`). Plain text scoring only, matching the no-eval philosophy in
// skills/skillify/SKILL.md.

export const MIN_SCORE = 0.05;

// Tiny stopword list so "what should I work on" does not rank on "what" or "I".
const STOPWORDS = new Set([
  "a", "an", "the", "my", "me", "i", "to", "for", "of", "and", "or", "on",
  "in", "is", "this", "that", "with", "it", "do", "how", "what", "should",
  "want", "wants", "please", "can", "you", "help", "get", "into", "out"
]);

const EXACT_NAME_BONUS = 100;

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token && !STOPWORDS.has(token));
}

function uniqueTokens(text) {
  return [...new Set(tokenize(text))];
}

// Jaccard-style overlap: 2 * shared / (a + b). Returns 0 when either side is
// empty so an empty description never scores on overlap alone.
function tokenOverlap(intentTokens, candidateTokens) {
  if (!intentTokens.length || !candidateTokens.length) return 0;
  const set = new Set(candidateTokens);
  let shared = 0;
  for (const token of intentTokens) if (set.has(token)) shared += 1;
  return (2 * shared) / (intentTokens.length + candidateTokens.length);
}

// Substring bonus: a trigger that appears whole inside the intent (or vice
// versa) is a strong signal even when tokenization is coarse.
function substringBonus(intentLower, candidateLower) {
  if (!intentLower || !candidateLower) return 0;
  if (intentLower === candidateLower) return 0.5;
  if (intentLower.includes(candidateLower) && candidateLower.length >= 4) return 0.4;
  if (candidateLower.includes(intentLower) && intentLower.length >= 4) return 0.4;
  return 0;
}

function scoreOne(skill, intent, intentTokens) {
  const nameLower = String(skill.name || "").toLowerCase();
  const dirLower = String(skill.dir || "").toLowerCase();
  const intentLower = intent.toLowerCase().trim();

  if (intentLower === nameLower || intentLower === dirLower) {
    return { score: EXACT_NAME_BONUS, reason: "exact name match" };
  }

  let score = 0;
  let reason = "";

  const triggerHits = [];
  for (const trigger of skill.triggers || []) {
    const triggerTokens = uniqueTokens(trigger);
    const overlap = tokenOverlap(intentTokens, triggerTokens);
    if (overlap > 0) triggerHits.push({ trigger, overlap });
    const sub = substringBonus(intentLower, trigger.toLowerCase());
    score += overlap + sub;
  }

  const descTokens = uniqueTokens(skill.description);
  const descOverlap = Math.min(tokenOverlap(intentTokens, descTokens), 0.5);
  score += descOverlap;

  if (triggerHits.length) {
    const best = triggerHits.reduce((a, b) => (b.overlap > a.overlap ? b : a));
    reason = `matched trigger "${best.trigger}"`;
  } else if (descOverlap > 0) {
    reason = "matched description";
  }

  return { score, reason };
}

// Rank every skill against the intent. Returns a sorted array (best first) of
// entries that clear MIN_SCORE. Each entry is self-describing for the CLI/MCP.
export function rankSkills(intent, skills, { skillsDir } = {}) {
  const intentTokens = uniqueTokens(intent);
  const scored = [];

  for (const skill of skills) {
    const { score, reason } = scoreOne(skill, intent, intentTokens);
    if (score <= 0) continue;
    const reasonText = reason || "weak overlap";
    if (score < MIN_SCORE) continue;
    scored.push({
      name: skill.name,
      dir: skill.dir,
      description: skill.description,
      triggers: skill.triggers || [],
      score,
      reason: reasonText,
      skillPath: skillsDir ? path.join(skillsDir, skill.dir, "SKILL.md") : path.join("skills", skill.dir, "SKILL.md")
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Specificity: a skill with more declared triggers wins.
    const at = a.triggers.length;
    const bt = b.triggers.length;
    if (bt !== at) return bt - at;
    return a.name.localeCompare(b.name);
  });

  return scored;
}

// Return the single best match, or null when nothing clears the bar. The
// confidence is the score normalized to a 0..1 display value (exact-name hits
// show as 1.0).
export function resolveIntent(intent, skills, options = {}) {
  const ranked = rankSkills(intent, skills, options);
  if (ranked.length === 0) return null;
  const best = ranked[0];
  return {
    ...best,
    confidence: best.score >= EXACT_NAME_BONUS ? 1 : Math.min(1, best.score)
  };
}

// Render a ready-to-source `## Skills first` block for fleet scripts and any
// non-IDE consumer. Replaces the hand-maintained block in dispatch-task.sh with
// a generated one that stays in sync with installed skills.
export function renderBootContext(skills, { skillsDir } = {}) {
  const lines = [
    "## Skills first",
    "",
    "Before hand-rolling work, match the user's intent to an installed skill and",
    "open that skill's SKILL.md. If a skill fits, run it. If nothing fits,",
    "hand-roll the work and (if the workflow repeats) offer to skillify it.",
    ""
  ];

  if (!skills.length) {
    lines.push("No skills installed yet. Run `dotaios activate` to refresh.", "");
    return lines.join("\n");
  }

  lines.push("| Skill | Triggers | Run |", "| --- | --- | --- |");
  for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
    const triggers = (skill.triggers && skill.triggers.length)
      ? skill.triggers.join(" · ")
      : (skill.description || skill.name);
    const skillPath = skillsDir
      ? path.join(skillsDir, skill.dir, "SKILL.md")
      : `skills/${skill.dir}/SKILL.md`;
    lines.push(`| ${skill.name} | ${escapeCell(triggers)} | \`${skillPath}\` |`);
  }
  lines.push("");
  return lines.join("\n");
}

function escapeCell(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}
