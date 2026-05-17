import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;

async function makeMinimalAios(base) {
  const aiosPath = path.join(base, "aios");
  await fs.mkdir(aiosPath, { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  return aiosPath;
}

describe("doctorCommand", () => {
  let tmpBase;

  before(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-"));
  });

  after(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("does not throw on a valid aios folder", async () => {
    const aiosPath = await makeMinimalAios(tmpBase);
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    await assert.doesNotReject(
      doctorCommand(["--path", aiosPath]),
      "doctorCommand should not throw even when it finds issues"
    );
  });

  it("does not throw when aios folder is missing", async () => {
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const prevExitCode = process.exitCode;
    await assert.doesNotReject(
      doctorCommand(["--path", path.join(tmpBase, "nonexistent")]),
      "doctorCommand should not throw on missing folder"
    );
    // doctor sets process.exitCode = 1 on failure; restore so the test runner
    // does not interpret this as a test suite failure.
    process.exitCode = prevExitCode;
  });
});
