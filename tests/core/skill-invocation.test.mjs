import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  INVOCATION_RECEIPT_SCHEMA,
  createInvocationReceipt,
  markerWasProduced,
  sha256File,
  writeInvocationReceipt
} from "../../packages/core/src/skill-invocation.mjs";

test("invocation receipt keeps configuration, discovery, invocation, and output separate", () => {
  const receipt = createInvocationReceipt({
    client: "Codex",
    clientVersion: "0.137.0",
    configured: "yes",
    discoverable: "path-ready",
    invoked: "yes",
    produced: "yes",
    targetPath: "/tmp/project/.agents/skills/dotaios-probe",
    skillName: "dotaios-probe",
    skillPath: "/tmp/project/skills/dotaios-probe/SKILL.md",
    skillDigest: "a".repeat(64),
    command: ["codex", "exec", "--sandbox", "read-only"],
    marker: "DOTAIOS_PROBE_OK_1234",
    exitCode: 0
  });

  assert.equal(receipt.schema, INVOCATION_RECEIPT_SCHEMA);
  assert.deepEqual(receipt.evidence, {
    configured: "yes",
    discoverable: "path-ready",
    invoked: "yes",
    produced: "yes"
  });
  assert.equal(receipt.skill.sha256.length, 64);
  assert.deepEqual(receipt.command, ["codex", "exec", "--sandbox", "read-only"]);
});

test("marker evidence requires an exact output line", () => {
  assert.equal(markerWasProduced("before\nDOTAIOS_PROBE_OK_1\nafter\n", "DOTAIOS_PROBE_OK_1"), true);
  assert.equal(markerWasProduced("DOTAIOS_PROBE_OK_10\n", "DOTAIOS_PROBE_OK_1"), false);
  assert.equal(markerWasProduced("the marker is DOTAIOS_PROBE_OK_1", "DOTAIOS_PROBE_OK_1"), false);
});

test("receipt writer creates a portable JSON artifact and hashes the skill bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-invocation-contract-"));
  const skillPath = path.join(root, "SKILL.md");
  const receiptPath = path.join(root, "receipts", "probe.json");
  await fs.writeFile(skillPath, "probe skill\n", "utf8");
  const digest = await sha256File(skillPath);
  const receipt = createInvocationReceipt({
    client: "Gemini",
    skillName: "probe",
    skillPath,
    skillDigest: digest,
    limitation: "not-run in this test"
  });

  await writeInvocationReceipt(receiptPath, receipt);
  const saved = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(saved.schema, INVOCATION_RECEIPT_SCHEMA);
  assert.equal(saved.skill.sha256, digest);
  assert.equal(saved.evidence.invoked, "not-run");
});

test("receipt validation rejects invented evidence states", () => {
  assert.throws(
    () => createInvocationReceipt({ client: "Codex", invoked: "configured" }),
    /invoked must be one of/
  );
});
