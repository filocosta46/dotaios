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
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-home-a-"));
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const lines = [];
    const origLog = console.log.bind(console);
    console.log = (...args) => lines.push(args.join(" "));

    try {
      await assert.doesNotReject(
        doctorCommand(["--path", aiosPath, "--home", tmpHome]),
        "doctorCommand should not throw even when it finds issues"
      );
    } finally {
      console.log = origLog;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not throw when aios folder is missing", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-home-b-"));
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const lines = [];
    const origLog = console.log.bind(console);
    console.log = (...args) => lines.push(args.join(" "));
    const prevExitCode = process.exitCode;

    try {
      await assert.doesNotReject(
        doctorCommand(["--path", path.join(tmpBase, "nonexistent"), "--home", tmpHome]),
        "doctorCommand should not throw on missing folder"
      );
    } finally {
      console.log = origLog;
      // doctor sets process.exitCode = 1 on failure; restore so the test runner
      // does not interpret this as a test suite failure.
      process.exitCode = prevExitCode;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("prints [ok] for Node version check", async () => {
    const aiosPath = await makeMinimalAios(tmpBase);
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-home-"));
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const lines = [];
    const origLog = console.log.bind(console);
    console.log = (...args) => lines.push(args.join(" "));

    try {
      await doctorCommand(["--path", aiosPath, "--home", tmpHome]);
    } finally {
      console.log = origLog;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }

    const out = lines.join("\n");
    assert.ok(out.includes("[ok]"), `expected [ok] in output, got: ${out.slice(0, 400)}`);
    assert.ok(
      lines.some((l) => l.includes("[ok]") && l.includes("Node")),
      `expected [ok] Node.js line, got: ${out.slice(0, 400)}`
    );
  });

  it("prints [fail] for AIOS folder when path does not exist, does not inspect real home", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-home2-"));
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const lines = [];
    const origLog = console.log.bind(console);
    console.log = (...args) => lines.push(args.join(" "));
    const prevExitCode = process.exitCode;

    try {
      await doctorCommand([
        "--path", path.join(tmpBase, "nonexistent-smoke"),
        "--home", tmpHome
      ]);
    } finally {
      console.log = origLog;
      process.exitCode = prevExitCode;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }

    const out = lines.join("\n");
    assert.ok(
      lines.some((l) => l.includes("[fail]") && l.includes("AIOS folder")),
      `expected [fail] AIOS folder line, got: ${out.slice(0, 400)}`
    );
  });

  it("prints [ok] for AIOS folder when valid folder and config present", async () => {
    const aiosPath = await makeMinimalAios(tmpBase);
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-home3-"));
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const lines = [];
    const origLog = console.log.bind(console);
    console.log = (...args) => lines.push(args.join(" "));

    try {
      await doctorCommand(["--path", aiosPath, "--home", tmpHome]);
    } finally {
      console.log = origLog;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }

    assert.ok(
      lines.some((l) => l.includes("[ok]") && l.includes("AIOS folder")),
      `expected [ok] AIOS folder line, got: ${lines.join("\n").slice(0, 400)}`
    );
    assert.ok(
      lines.some((l) => l.includes("[ok]") && l.includes("aios.json")),
      `expected [ok] aios.json line, got: ${lines.join("\n").slice(0, 400)}`
    );
  });
});
