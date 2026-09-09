import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { startWorkPlan, inspectWorkPlan, checkpointWorkPlan } from "../../packages/core/src/work-plan.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-work-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("a new session discovers the agreed goal and limits from the work folder", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "plan.md"), "# My project\n\nKeep this owner-written context.\n");
  await startWorkPlan(root, { goal: "Compare two retention approaches", limits: ["Public sources only"], nextAction: "Read the primary sources" });
  const current = await inspectWorkPlan(root);
  assert.equal(current.plan.goal, "Compare two retention approaches");
  assert.deepEqual(current.plan.limits, ["Public sources only"]);
  assert.equal(current.plan.nextAction, "Read the primary sources");
  assert.equal(current.status, "ready");
  assert.match(await fs.readFile(path.join(root, "plan.md"), "utf8"), /^# My project\n\nKeep this owner-written context\.\n/);
});

test("a checkpoint preserves completed progress, source provenance and result dependencies", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "research/sources"), { recursive: true });
  await fs.mkdir(path.join(root, "research/results"));
  await fs.writeFile(path.join(root, "research/sources/primary.md"), "Primary evidence");
  await fs.writeFile(path.join(root, "research/results/comparison.md"), "First comparison");
  const started = await startWorkPlan(root, { goal: "Compare approaches", limits: [], nextAction: "Read evidence" });
  const checkpoint = await checkpointWorkPlan(root, {
    completed: ["Read primary evidence"],
    sources: [{ path: "research/sources/primary.md", origin: "https://example.org/primary" }],
    outputs: [{ path: "research/results/comparison.md", sources: ["research/sources/primary.md"] }],
    nextAction: "Resolve the remaining comparison"
  }, { expectedRevision: started.revision });
  assert.equal(checkpoint.plan.sources[0].sha256, createHash("sha256").update("Primary evidence").digest("hex"));
  assert.equal(checkpoint.plan.sources[0].origin, "https://example.org/primary");
  assert.deepEqual(checkpoint.plan.outputs[0].sources, [{ path: "research/sources/primary.md", sha256: checkpoint.plan.sources[0].sha256 }]);
  await checkpointWorkPlan(root, { completed: ["Drafted comparison"], nextAction: "Review result" }, { expectedRevision: checkpoint.revision });
  const resumed = await inspectWorkPlan(root);
  assert.deepEqual(resumed.plan.completed, ["Read primary evidence", "Drafted comparison"]);
  assert.equal(resumed.plan.nextAction, "Review result");
  assert.deepEqual(resumed.verification, { state: "current", findings: [] });
});

test("changed evidence invalidates dependent results until explicitly reread and rewritten", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "research/sources"), { recursive: true });
  await fs.mkdir(path.join(root, "research/results"));
  await fs.writeFile(path.join(root, "research/sources/rules.md"), "Old rule");
  await fs.writeFile(path.join(root, "research/results/advice.md"), "Old advice");
  const start = await startWorkPlan(root, { goal: "Check the rule", limits: [], nextAction: "Read rule" });
  const saved = await checkpointWorkPlan(root, {
    completed: ["Read initial rule"],
    sources: [{ path: "research/sources/rules.md", origin: "https://example.org/rules" }],
    outputs: [{ path: "research/results/advice.md", sources: ["research/sources/rules.md"] }],
    nextAction: "Review advice"
  }, { expectedRevision: start.revision });
  await fs.writeFile(path.join(root, "research/sources/rules.md"), "Late rule changes the answer");
  const drifted = await inspectWorkPlan(root);
  assert.equal(drifted.status, "needs-attention");
  assert.deepEqual(drifted.verification.findings.map(({ code }) => code), ["source-changed", "dependency-changed"]);
  const before = await fs.readFile(path.join(root, "plan.md"));
  await assert.rejects(checkpointWorkPlan(root, { status: "complete", nextAction: null }, { expectedRevision: saved.revision }), /current evidence/);
  assert.deepEqual(await fs.readFile(path.join(root, "plan.md")), before);
  const reread = await checkpointWorkPlan(root, {
    sources: [{ path: "research/sources/rules.md", origin: "https://example.org/rules" }],
    completed: ["Read late rule"], nextAction: "Update advice"
  }, { expectedRevision: saved.revision });
  assert.deepEqual(reread.verification.findings.map(({ code }) => code), ["dependency-changed"]);
  await fs.writeFile(path.join(root, "research/results/advice.md"), "Advice follows late rule");
  const done = await checkpointWorkPlan(root, {
    outputs: [{ path: "research/results/advice.md", sources: ["research/sources/rules.md"] }],
    status: "complete", nextAction: null
  }, { expectedRevision: reread.revision });
  assert.equal(done.status, "ready");
  assert.equal(done.plan.status, "complete");
  await fs.unlink(path.join(root, "research/results/advice.md"));
  const missing = await inspectWorkPlan(root);
  assert.equal(missing.status, "needs-attention");
  assert.equal(missing.verification.findings[0].code, "output-missing");
});

test("inspection refuses inconsistent completed records and preserves the owner's edited file", async (t) => {
  for (const scenario of ["missing result", "unresolved question"]) {
    await t.test(scenario, async (t) => {
      const root = await fixture(t);
      let current = await startWorkPlan(root, { goal: "Compare sources", limits: [], nextAction: "Read sources" });
      if (scenario === "unresolved question") {
        await fs.mkdir(path.join(root, "research/sources"), { recursive: true });
        await fs.mkdir(path.join(root, "research/results"));
        await fs.writeFile(path.join(root, "research/sources/source.md"), "Primary source");
        await fs.writeFile(path.join(root, "research/results/result.md"), "Partial comparison");
        current = await checkpointWorkPlan(root, {
          sources: [{ path: "research/sources/source.md", origin: "https://example.org/source" }],
          outputs: [{ path: "research/results/result.md", sources: ["research/sources/source.md"] }],
          unresolved: ["The second source is still unavailable"], nextAction: "Read the second source"
        }, { expectedRevision: current.revision });
      }
      const filename = path.join(root, "plan.md");
      const original = await fs.readFile(filename, "utf8");
      await assert.rejects(checkpointWorkPlan(root, { status: "complete", nextAction: null }, {
        expectedRevision: current.revision
      }), (error) => error.code === "DOTAIOS_WORK_PLAN_EVIDENCE_NOT_CURRENT");
      assert.equal(await fs.readFile(filename, "utf8"), original);

      const edited = original.replace(/```json\n([\s\S]*?)\n```/, (_, json) => {
        const plan = JSON.parse(json);
        plan.status = "complete";
        plan.nextAction = null;
        return `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
      });
      await fs.writeFile(filename, edited);
      await assert.rejects(inspectWorkPlan(root), (error) => error.code === "DOTAIOS_WORK_PLAN_INVALID");
      assert.equal(await fs.readFile(filename, "utf8"), edited);
    });
  }
});

test("evidence registration refuses paths outside the research folders, links and oversized files", async (t) => {
  const root = await fixture(t);
  const elsewhere = await fixture(t);
  await fs.mkdir(path.join(root, "research/sources"), { recursive: true });
  await fs.writeFile(path.join(elsewhere, "private.md"), "Never read this");
  await fs.symlink(path.join(elsewhere, "private.md"), path.join(root, "research/sources/link.md"));
  await fs.symlink(elsewhere, path.join(root, "research/sources/linked-folder"));
  const started = await startWorkPlan(root, { goal: "Review evidence", limits: [], nextAction: "Read source" });
  const before = await fs.readFile(path.join(root, "plan.md"));
  for (const sourcePath of [
    path.join(elsewhere, "private.md"), "../private.md", "plan.md",
    "research/sources/link.md", "research/sources/linked-folder/private.md"
  ]) {
    await assert.rejects(checkpointWorkPlan(root, {
      sources: [{ path: sourcePath, origin: "Supplied document" }]
    }, { expectedRevision: started.revision }));
  }
  const big = await fs.open(path.join(root, "research/sources/huge.md"), "w");
  await big.truncate(16 * 1024 * 1024 + 1);
  await big.close();
  await assert.rejects(checkpointWorkPlan(root, {
    sources: [{ path: "research/sources/huge.md", origin: "Supplied document" }]
  }, { expectedRevision: started.revision }));
  assert.deepEqual(await fs.readFile(path.join(root, "plan.md")), before);
});

test("the current entry cannot overwrite another goal, malformed state or owner edits", async (t) => {
  const root = await fixture(t);
  assert.equal((await inspectWorkPlan(root)).status, "not-found");
  await fs.writeFile(path.join(root, "plan.md"), "# Existing owner plan\n");
  assert.equal((await inspectWorkPlan(root)).status, "not-found");
  const input = { goal: "Agreed destination", limits: ["Keep the scope"], nextAction: "Begin" };
  const started = await startWorkPlan(root, input);
  await assert.rejects(startWorkPlan(root, { ...input, goal: "Different destination" }), /already/);
  await fs.appendFile(path.join(root, "plan.md"), "\nOwner addition\n");
  await assert.rejects(checkpointWorkPlan(root, { nextAction: "Continue" }, { expectedRevision: started.revision }), /changed/);
  const inspected = await inspectWorkPlan(root);
  await checkpointWorkPlan(root, { nextAction: "Continue" }, { expectedRevision: inspected.revision });
  assert.match(await fs.readFile(path.join(root, "plan.md"), "utf8"), /\nOwner addition\n$/);
  for (const invalid of [
    { goal: "New goal" }, { completed: Array(65).fill("Task") }, { status: "delivered" },
    { nextAction: "" }, { limits: [] }, { completed: ["x".repeat(2001)] }
  ]) {
    const current = await inspectWorkPlan(root);
    await assert.rejects(checkpointWorkPlan(root, invalid, { expectedRevision: current.revision }));
  }
  await fs.writeFile(path.join(root, "plan.md"), "Owner prose\n<!-- dotaios-work-plan:start -->\nBroken record\n");
  await assert.rejects(inspectWorkPlan(root), /invalid/);
  await assert.rejects(startWorkPlan(root, input), /invalid/);
});

test("concurrent checkpoints cannot silently lose completed progress", async (t) => {
  const root = await fixture(t);
  const started = await startWorkPlan(root, { goal: "Finish research", limits: [], nextAction: "Read" });
  const results = await Promise.allSettled([
    checkpointWorkPlan(root, { completed: ["Source A read"] }, { expectedRevision: started.revision }),
    checkpointWorkPlan(root, { completed: ["Source B read"] }, { expectedRevision: started.revision })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const current = await inspectWorkPlan(root);
  assert.equal(current.plan.completed.length, 1);
  const missing = current.plan.completed[0] === "Source A read" ? "Source B read" : "Source A read";
  const retried = await checkpointWorkPlan(root, { completed: [missing] }, { expectedRevision: current.revision });
  assert.deepEqual(retried.plan.completed.slice().sort(), ["Source A read", "Source B read"]);
});

test("a failed atomic publication preserves the last complete checkpoint and can be retried", async (t) => {
  const root = await fixture(t);
  const started = await startWorkPlan(root, { goal: "Keep evidence", limits: [], nextAction: "Read" });
  const filesystem = {
    ...fs,
    async rename(from, to) {
      if (to === path.join(root, "plan.md")) throw new Error("Simulated disk failure before publication");
      return fs.rename(from, to);
    }
  };
  await assert.rejects(checkpointWorkPlan(root, { completed: ["Read source"] }, {
    expectedRevision: started.revision, filesystem
  }), /disk failure/);
  const current = await inspectWorkPlan(root);
  assert.equal(current.revision, started.revision);
  assert.deepEqual(current.plan.completed, []);
  const retried = await checkpointWorkPlan(root, { completed: ["Read source"] }, { expectedRevision: started.revision });
  assert.deepEqual(retried.plan.completed, ["Read source"]);
});

test("inspection and a new checkpoint recover after process death before atomic publication", async (t) => {
  const root = await fixture(t);
  const started = await startWorkPlan(root, { goal: "Continue after interruption", limits: [], nextAction: "Read" });
  const moduleUrl = new URL("../../packages/core/src/work-plan.mjs", import.meta.url).href;
  const script = `
    import fs from 'node:fs/promises';
    import { checkpointWorkPlan } from ${JSON.stringify(moduleUrl)};
    const filesystem = { ...fs, async rename(from, to) {
      if (to === ${JSON.stringify(path.join(root, "plan.md"))}) process.exit(73);
      return fs.rename(from, to);
    }};
    await checkpointWorkPlan(${JSON.stringify(root)}, { completed: ['Read source'] }, {
      expectedRevision: ${JSON.stringify(started.revision)}, filesystem
    });
  `;
  const stopped = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  assert.equal(stopped.status, 73, stopped.stderr);
  const resumed = await inspectWorkPlan(root);
  assert.equal(resumed.revision, started.revision);
  const saved = await checkpointWorkPlan(root, { completed: ["Read source"] }, { expectedRevision: resumed.revision });
  assert.deepEqual(saved.plan.completed, ["Read source"]);
});

test("a change during staging cannot publish stale progress over owner edits or changed sources", async (t) => {
  for (const changed of ["plan", "source"]) {
    await t.test(changed, async (t) => {
      const root = await fixture(t);
      await fs.mkdir(path.join(root, "research/sources"), { recursive: true });
      const source = path.join(root, "research/sources/source.md");
      await fs.writeFile(source, "Initial evidence");
      const started = await startWorkPlan(root, { goal: "Check evidence", limits: [], nextAction: "Read" });
      let injected = false;
      const filesystem = {
        ...fs,
        async open(file, flags, ...args) {
          const handle = await fs.open(file, flags, ...args);
          if (flags !== "wx" || !path.basename(file).startsWith(".dotaios-work-plan.")) return handle;
          return {
            async writeFile(...args) {
              await handle.writeFile(...args);
              injected = true;
              if (changed === "plan") await fs.appendFile(path.join(root, "plan.md"), "\nOwner edits\n");
              else await fs.writeFile(source, "Changed evidence");
            },
            sync: () => handle.sync(), close: () => handle.close()
          };
        }
      };
      await assert.rejects(checkpointWorkPlan(root, {
        sources: [{ path: "research/sources/source.md", origin: "Primary source" }], completed: ["Read evidence"]
      }, { expectedRevision: started.revision, filesystem }), /changed/);
      assert.equal(injected, true);
      const resumed = await inspectWorkPlan(root);
      assert.deepEqual(resumed.plan.completed, []);
      if (changed === "plan") assert.match(await fs.readFile(path.join(root, "plan.md"), "utf8"), /Owner edits/);
    });
  }
});

test("a post-publication sync failure reports uncertainty and inspection finds the completed checkpoint", async (t) => {
  const root = await fixture(t);
  const started = await startWorkPlan(root, { goal: "Keep progress", limits: [], nextAction: "Read" });
  let failNextSync = false;
  const filesystem = {
    ...fs,
    async rename(from, to) {
      await fs.rename(from, to);
      if (to === path.join(root, "plan.md")) failNextSync = true;
    },
    async open(file, ...args) {
      if (file === root && failNextSync) {
        failNextSync = false;
        throw new Error("Directory sync failed after rename");
      }
      return fs.open(file, ...args);
    }
  };
  await assert.rejects(checkpointWorkPlan(root, { completed: ["Read evidence"] }, {
    expectedRevision: started.revision, filesystem
  }), (error) => error.code === "DOTAIOS_WORK_PLAN_PUBLICATION_UNCERTAIN");
  const resumed = await inspectWorkPlan(root);
  assert.deepEqual(resumed.plan.completed, ["Read evidence"]);
  assert.notEqual(resumed.revision, started.revision);
});

test("an unresolved external outcome remains blocked even when local files are unchanged", async (t) => {
  const root = await fixture(t);
  const start = await startWorkPlan(root, { goal: "Compare evidence", limits: [], nextAction: "Read provider source" });
  const blocked = await checkpointWorkPlan(root, {
    status: "blocked", unresolved: ["The provider read has no confirmed response"],
    nextAction: "Inspect the existing provider operation before another read"
  }, { expectedRevision: start.revision });
  assert.equal(blocked.status, "needs-attention");
  assert.equal(blocked.verification.state, "current");
  assert.deepEqual(blocked.plan.completed, []);
  assert.equal(blocked.plan.status, "blocked");
});

test("one checkpoint has a total evidence read bound in addition to each file limit", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "research/sources"), { recursive: true });
  const sources = [];
  for (let index = 0; index < 5; index += 1) {
    const relative = `research/sources/source-${index}.txt`;
    const handle = await fs.open(path.join(root, relative), "w");
    await handle.truncate(16 * 1024 * 1024);
    await handle.close();
    sources.push({ path: relative, origin: "Supplied source" });
  }
  const start = await startWorkPlan(root, { goal: "Bound reading", limits: [], nextAction: "Read" });
  await assert.rejects(checkpointWorkPlan(root, { sources }, { expectedRevision: start.revision }),
    (error) => error.code === "DOTAIOS_PROJECTION_READ_BUDGET_EXCEEDED");
  assert.equal((await inspectWorkPlan(root)).revision, start.revision);
});
