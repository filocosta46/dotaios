import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applySkillPatchCandidates, auditMemory, renderMemoryAudit, renderSkillPatchQueue } from "../../packages/core/src/memory-audit.mjs";
import { isoDate } from "../../packages/core/src/memory.mjs";
import { selectWorkingContext } from "../../packages/core/src/working-context.mjs";

const FIXED_NOW = new Date("2026-06-30T18:00:00.000Z");

function fixedClock() {
  return new Date(FIXED_NOW.getTime());
}

function auditHot(aiosPath, options = {}) {
  return auditMemory(aiosPath, { clock: fixedClock, ...options });
}

async function tmpAios() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-memory-audit-"));
  const aios = path.join(root, "aios");
  await fs.mkdir(path.join(aios, "memory", "signals"), { recursive: true });
  await fs.mkdir(path.join(aios, "context"), { recursive: true });
  await fs.mkdir(path.join(aios, "skills"), { recursive: true });
  await fs.writeFile(path.join(aios, "aios.json"), "{}\n");
  return aios;
}

test("auditMemory flags hot files over the line budget", async () => {
  const aios = await tmpAios();
  const content = Array.from({ length: 205 }, (_, index) => `line ${index + 1}`).join("\n");
  await fs.writeFile(path.join(aios, "AGENTS.md"), content);

  const report = await auditHot(aios, { lineBudget: 200 });

  assert.equal(report.summary.hotFileCount, 1);
  assert.equal(report.hotFiles[0].path, "AGENTS.md");
  assert.equal(report.hotFiles[0].lines, 205);
  assert.equal(report.findings[0].code, "hot-file-over-budget");
});

test("auditMemory queues skill-tied memory entries as skill patch candidates", async () => {
  const aios = await tmpAios();
  const entry = {
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    skill: "ingest",
    memory_decision: "skill-patch",
    summary: "The ingest skill needs to remind agents that --to wiki requires --apply in non-interactive runs."
  };
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify(entry)}\n`);

  const report = await auditHot(aios);

  assert.equal(report.skillPatchCandidates.length, 1);
  assert.equal(report.skillPatchCandidates[0].skill, "ingest");
  assert.equal(report.skillPatchCandidates[0].source, "memory/events.jsonl#1");
  assert.match(renderMemoryAudit(report), /Top skill patch candidates/);
});

test("renderSkillPatchQueue makes a reviewable queue and preserves existing sources", async () => {
  const aios = await tmpAios();
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    summary: "Patch the research skill to require citations before writing the final report.",
    disposition: "skill patch"
  })}\n`);

  const report = await auditHot(aios);
  const queue = renderSkillPatchQueue(report, { generatedAt: new Date("2026-07-06T12:00:00.000Z") });
  const preserved = renderSkillPatchQueue(report, { generatedAt: new Date("2026-07-06T12:00:00.000Z"), previousContent: queue });

  assert.match(queue, /# Skill Patch Queue/);
  assert.match(queue, /research/);
  assert.match(queue, /memory\/events\.jsonl#1/);
  assert.equal(preserved, queue);
});

test("renderSkillPatchQueue dedupes by stable candidate id when JSONL line numbers shift", async () => {
  const aios = await tmpAios();
  const entry = {
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    summary: "Patch the research skill to require citations before writing the final report.",
    disposition: "skill patch"
  };
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify(entry)}\n`);

  const firstReport = await auditHot(aios);
  const queue = renderSkillPatchQueue(firstReport, { generatedAt: new Date("2026-07-06T12:00:00.000Z") });
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({ ts: "2026-06-29T12:00:00.000Z", type: "note", summary: "Older note" })}\n${JSON.stringify(entry)}\n`);

  const shiftedReport = await auditHot(aios);
  const preserved = renderSkillPatchQueue(shiftedReport, { generatedAt: new Date("2026-07-06T12:00:00.000Z"), previousContent: queue });

  assert.equal(preserved, queue);
});

test("renderSkillPatchQueue removes empty marker when later candidates appear", async () => {
  const aios = await tmpAios();
  const emptyReport = await auditHot(aios);
  const emptyQueue = renderSkillPatchQueue(emptyReport, { generatedAt: new Date("2026-07-06T12:00:00.000Z") });
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    summary: "Patch the research skill to require citations before writing the final report.",
    disposition: "skill patch"
  })}\n`);

  const report = await auditHot(aios);
  const queue = renderSkillPatchQueue(report, { generatedAt: new Date("2026-07-06T12:00:00.000Z"), previousContent: emptyQueue });

  assert.doesNotMatch(queue, /No new skill-tied memory entries/);
  assert.match(queue, /research/);
});

test("auditMemory hot scope consumes the canonical bounded timeline selection", async () => {
  const aios = await tmpAios();
  const today = isoDate(FIXED_NOW);
  const staleDate = new Date(FIXED_NOW.getTime());
  staleDate.setDate(staleDate.getDate() - 2);
  const oldSkillEntry = {
    ts: "2026-01-01T12:00:00.000Z",
    type: "lesson",
    skill: "old",
    memory_decision: "skill-patch",
    summary: "The old skill should not appear from cold event history."
  };
  const events = [
    oldSkillEntry,
    {
      ts: `${today}T09:00:00.000Z`,
      type: "lesson",
      skill: "outside-bound",
      memory_decision: "skill-patch",
      summary: "This ninth event should stay outside the canonical event cap."
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      ts: `${today}T${String(index + 10).padStart(2, "0")}:00:00.000Z`,
      type: "lesson",
      skill: `selected-event-${index + 1}`,
      memory_decision: "skill-patch",
      summary: `Selected event lesson ${index + 1}.`
    }))
  ];
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
  await fs.writeFile(path.join(aios, "memory", "signals", `${isoDate(staleDate)}.jsonl`), `${JSON.stringify(oldSkillEntry)}\n`);
  await fs.writeFile(path.join(aios, "memory", "signals", `mini-${today}.jsonl`), `${JSON.stringify({
    ts: `${today}T18:00:00.000Z`,
    type: "lesson",
    skill: "closeday",
    memory_decision: "skill-patch",
    summary: "The closeday skill should ask for carry-over before writing the final note."
  })}\n`);

  const context = await selectWorkingContext(aios, {}, { clock: fixedClock });
  const report = await auditHot(aios);

  assert.equal(report.summary.memoryEntriesScanned, context.events.length + context.signals.length);
  assert.equal(report.summary.memoryEntriesScanned, 9);
  assert.deepEqual(
    report.skillPatchCandidates.map((candidate) => candidate.skill).sort(),
    ["closeday", ...Array.from({ length: 8 }, (_, index) => `selected-event-${index + 1}`)].sort()
  );
  assert.ok(report.skillPatchCandidates.some((candidate) => candidate.source === "memory/events.jsonl#10"));
  assert.ok(report.skillPatchCandidates.some((candidate) => candidate.source === `memory/signals/mini-${today}.jsonl#1`));
  assert.ok(report.skillPatchCandidates.every((candidate) => candidate.skill !== "old"));
  assert.ok(report.skillPatchCandidates.every((candidate) => candidate.skill !== "outside-bound"));
});

test("auditMemory can scan all memory when requested", async () => {
  const aios = await tmpAios();
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-01-01T12:00:00.000Z",
    type: "lesson",
    skill: "old",
    memory_decision: "skill-patch",
    summary: "The old skill should appear in all-memory scans."
  })}\n`);
  await fs.writeFile(path.join(aios, "memory", "signals", "2026-01-01.jsonl"), `${JSON.stringify({
    ts: "2026-01-01T12:00:00.000Z",
    type: "lesson",
    skill: "archive",
    memory_decision: "skill-patch",
    summary: "The archive skill should appear in all-memory scans."
  })}\n`);

  const report = await auditHot(aios, { memoryScope: "all" });

  assert.equal(report.summary.memoryEntriesScanned, 2);
  assert.deepEqual(report.skillPatchCandidates.map((candidate) => candidate.skill).sort(), ["archive", "old"]);
});

test("auditMemory reports candidate truncation without hiding the total", async () => {
  const aios = await tmpAios();
  const events = Array.from({ length: 5 }, (_, index) => ({
    ts: `2026-06-30T12:00:0${index}.000Z`,
    type: "lesson",
    skill: "research",
    memory_decision: "skill-patch",
    summary: `Research skill lesson ${index + 1}.`
  }));
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));

  const report = await auditHot(aios, { maxQueueCandidates: 2 });

  assert.equal(report.summary.skillPatchCandidates, 5);
  assert.equal(report.summary.skillPatchCandidatesShown, 2);
  assert.equal(report.summary.skillPatchCandidatesTruncated, true);
  assert.equal(report.skillPatchCandidates.length, 2);
  assert.equal(report.findings.find((finding) => finding.code === "skill-patch-candidates-truncated").severity, "info");
});

test("auditMemory does not infer a skill name from generic skill-patch wording", async () => {
  const aios = await tmpAios();
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    summary: "Duplicate skill install handling needs a follow-up, but no exact skill is named.",
    disposition: "skill patch"
  })}\n`);

  const report = await auditHot(aios);

  assert.equal(report.skillPatchCandidates.length, 1);
  assert.equal(report.skillPatchCandidates[0].skill, "needs-routing");
});

test("renderSkillPatchQueue routes unclear skill candidates instead of naming a fake skill path", async () => {
  const aios = await tmpAios();
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    summary: "Duplicate skill install handling needs a follow-up, but no exact skill is named.",
    disposition: "skill patch"
  })}\n`);

  const report = await auditHot(aios);
  const queue = renderSkillPatchQueue(report, { generatedAt: new Date("2026-07-06T12:00:00.000Z") });

  assert.match(queue, /Route this to an existing skill/);
  assert.doesNotMatch(queue, /skills\/needs-routing\/SKILL\.md/);
});

test("applySkillPatchCandidates appends explicit lessons to existing skills idempotently", async () => {
  const aios = await tmpAios();
  await fs.mkdir(path.join(aios, "skills", "research"), { recursive: true });
  const skillPath = path.join(aios, "skills", "research", "SKILL.md");
  await fs.writeFile(skillPath, "# research\n\nUse citations.\n");
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "lesson",
    skill: "research",
    memory_decision: "skill-patch",
    summary: "The research skill should require citations before writing the final report."
  })}\n`);

  const report = await auditHot(aios);
  const first = await applySkillPatchCandidates(aios, report);
  const second = await applySkillPatchCandidates(aios, report);
  const content = await fs.readFile(skillPath, "utf8");

  assert.equal(first.applied, 1);
  assert.equal(second.unchanged, 1);
  assert.match(content, /## Field Notes/);
  assert.match(content, /memory\/events\.jsonl#1/);
  assert.equal((content.match(/dotaios-memory-audit:id=/g) || []).length, 1);
});

test("applySkillPatchCandidates skips uncertain or missing skills", async () => {
  const aios = await tmpAios();
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), [
    JSON.stringify({
      ts: "2026-06-30T12:00:00.000Z",
      type: "lesson",
      summary: "Duplicate skill install handling needs a follow-up, but no exact skill is named.",
      disposition: "skill patch"
    }),
    JSON.stringify({
      ts: "2026-06-30T12:01:00.000Z",
      type: "lesson",
      skill: "missing",
      memory_decision: "skill-patch",
      summary: "The missing skill should not be created implicitly."
    })
  ].join("\n"));

  const report = await auditHot(aios);
  const result = await applySkillPatchCandidates(aios, report);

  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.results.map((item) => item.reason).sort(), ["missing-skill", "needs-routing"]);
});

test("applySkillPatchCandidates skips text-only skill path matches as review-only", async () => {
  const aios = await tmpAios();
  await fs.mkdir(path.join(aios, "skills", "research"), { recursive: true });
  const skillPath = path.join(aios, "skills", "research", "SKILL.md");
  await fs.writeFile(skillPath, "# research\n\nUse citations.\n");
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), `${JSON.stringify({
    ts: "2026-06-30T12:00:00.000Z",
    type: "status",
    summary: "Saved at skills/research/SKILL.md after a cleanup pass."
  })}\n`);

  const report = await auditHot(aios);
  const result = await applySkillPatchCandidates(aios, report);
  const content = await fs.readFile(skillPath, "utf8");

  assert.equal(report.skillPatchCandidates.length, 1);
  assert.equal(report.skillPatchCandidates[0].skill, "research");
  assert.equal(report.skillPatchCandidates[0].safeToApply, false);
  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].reason, "review-only");
  assert.equal(content, "# research\n\nUse citations.\n");
});

// The release tells agents to supersede a fact that stopped being true. The
// auditor must not then report that same workflow as a conflict and recommend
// removing one of the two blocks — that would talk a user into deleting the
// correction they just made.

function promotionEvent(ts, { operation = "add", hash, matched }) {
  return JSON.stringify({
    ts,
    type: "memory-promotion",
    operation,
    destination_path: "context/work.md",
    content_hash: hash,
    ...(matched ? { matched_content_hash: matched } : {}),
    summary: `promotion ${hash}`
  });
}

test("promote-then-supersede is not reported as a conflict", async () => {
  const aios = await tmpAios();
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), [
    promotionEvent("2026-06-01T10:00:00.000Z", { hash: "aaa" }),
    promotionEvent("2026-06-02T10:00:00.000Z", { operation: "supersede", hash: "bbb", matched: "aaa" })
  ].join("\n") + "\n");

  const report = await auditHot(aios, { memoryScope: "all" });

  const conflicts = report.findings.filter((f) => /conflict/i.test(f.message || ""));
  assert.deepEqual(conflicts, [], `superseding is the documented workflow, not a defect: ${JSON.stringify(conflicts)}`);
});

test("a conflict verdict does not depend on the order events are handed in", async () => {
  const aios = await tmpAios();
  // Newest first — the order a recency-ordered reader naturally produces.
  await fs.writeFile(path.join(aios, "memory", "events.jsonl"), [
    promotionEvent("2026-06-02T10:00:00.000Z", { operation: "supersede", hash: "bbb", matched: "aaa" }),
    promotionEvent("2026-06-01T10:00:00.000Z", { hash: "aaa" })
  ].join("\n") + "\n");

  const report = await auditHot(aios, { memoryScope: "all" });

  const conflicts = report.findings.filter((f) => /conflict/i.test(f.message || ""));
  assert.deepEqual(conflicts, [], `the fold must sort by ts, not trust input order: ${JSON.stringify(conflicts)}`);
});
