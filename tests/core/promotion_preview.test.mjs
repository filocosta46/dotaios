import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPromotion, applyPromotion } from "../../packages/core/src/promotion.mjs";
import { deriveProjectionRow, parseSessionMarkdown, renderSessionMarkdown } from "../../packages/core/src/session-codec.mjs";
import { createSessionStore } from "../../packages/core/src/session-store.mjs";

// The product's core safety promise is preview-then-apply. A preview that does
// not show the real change is worse than none: it manufactures consent.

const SESSION_ID = "a1b2c3d4e5f6";

function setupAios(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const rel = path.join("memory", "sessions", "2026-07-15", `2026-07-15T09-00-00_manual_${SESSION_ID.slice(0, 6)}.md`);
  const sessionPath = path.join(aiosPath, rel);
  const session = {
    schema: 1,
    agent: "manual",
    session_id: SESSION_ID,
    captured_at: "2026-07-15T09:00:00.000Z",
    source_type: "manual",
    turns: [{ role: "user", content: "hello" }],
    title: "hello",
  };
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "context"), { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), "{}\n");
  fs.writeFileSync(sessionPath, renderSessionMarkdown(session));
  fs.mkdirSync(path.join(aiosPath, "memory", "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(aiosPath, "memory", "sessions", "index.jsonl"),
    `${JSON.stringify(deriveProjectionRow(session, rel))}\n`,
  );
  return aiosPath;
}

const TAIL = Array.from({ length: 20 }, (_, i) => `unchanged tail line ${i}`).join("\n");

test("promotion refuses forged projection metadata instead of resolving it as evidence", async (t) => {
  const aiosPath = setupAios(t);
  const indexPath = path.join(aiosPath, "memory", "sessions", "index.jsonl");
  const row = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  fs.writeFileSync(indexPath, `${JSON.stringify({ ...row, title: "FORGED_PROMOTION_TITLE" })}\n`);

  await assert.rejects(
    () => planPromotion(aiosPath, {
      source: SESSION_ID,
      destinationType: "session-only",
      summary: "Keep the canonical evidence boundary.",
    }),
    (error) => error?.code === "DOTAIOS_SESSION_PROJECTION_DRIFT",
  );
});

test("promotion apply refuses canonical session growth after preview", async (t) => {
  const aiosPath = setupAios(t);
  const target = path.join(aiosPath, "context", "work.md");
  fs.writeFileSync(target, "Original context.\n");
  const plan = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "A fact from the previewed session.",
  });

  const sessionPath = path.join(aiosPath, ...plan.source.relativePath.split("/"));
  const session = parseSessionMarkdown(fs.readFileSync(sessionPath));
  fs.writeFileSync(sessionPath, renderSessionMarkdown({
    ...session,
    turns: [...session.turns, { role: "assistant", content: "A later turn." }],
  }));
  await createSessionStore({ aiosPath }).reconcile({ apply: true });

  await assert.rejects(
    () => applyPromotion(plan),
    /captured session changed after the preview/i,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "Original context.\n");
});

test("an edit near the top of a long file is visible in the preview", async (t) => {
  const aiosPath = setupAios(t);
  const target = path.join(aiosPath, "context", "work.md");
  fs.writeFileSync(target, `THE ORIGINAL FACT\n\n${TAIL}\n`);

  const plan = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "The corrected fact.",
    operation: "add"
  });

  assert.doesNotMatch(
    plan.preview,
    /-unchanged tail line 19/,
    `an untouched line must never be shown as a deletion:\n${plan.preview}`
  );
  assert.match(plan.preview, /\+.*corrected fact/i, `the real addition must be visible:\n${plan.preview}`);
});

test("the preview never reports a deletion the operation is not making", async (t) => {
  const aiosPath = setupAios(t);
  const target = path.join(aiosPath, "context", "work.md");
  fs.writeFileSync(target, `${TAIL}\n`);

  const plan = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "A brand new fact.",
    operation: "add"
  });

  const removals = plan.preview.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  assert.deepEqual(removals, [], `an append deletes nothing, so the preview must show no removals:\n${plan.preview}`);
});

// The two tests above exercise `add`, which renderPromotionDiff short-circuits
// to a different renderer. The replace/remove/supersede path is the one that
// used to print two unaligned tail windows dressed up as a diff, so it needs
// its own coverage — a mutation of that code must turn this red.

test("superseding shows the new fact and reports no phantom deletions", async (t) => {
  const aiosPath = setupAios(t);
  const target = path.join(aiosPath, "context", "work.md");
  fs.writeFileSync(target, `${TAIL}\n`);

  const first = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "Ships on Friday.",
    operation: "add"
  });
  await applyPromotion(first);

  const plan = await planPromotion(aiosPath, {
    source: SESSION_ID,
    destinationType: "context",
    destinationPath: "context/work.md",
    summary: "Slipped to next month.",
    operation: "supersede",
    match: "Ships on Friday."
  });

  // Superseding is non-destructive on purpose: the old block stays, marked.
  // So the honest preview has NO removals. The old renderer printed the last
  // twelve lines of the file as deletions regardless, which is what made it a
  // lie rather than a diff.
  const removals = plan.preview.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  assert.deepEqual(removals, [], `supersede deletes nothing; every line here is a phantom:\n${plan.preview}`);
  assert.match(plan.preview, /\+.*Slipped to next month/, `the new fact must be visible:\n${plan.preview}`);
  assert.match(plan.preview, /superseded-by=/, `the retirement marker must be visible:\n${plan.preview}`);
});
