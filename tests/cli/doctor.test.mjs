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
  // A real AIOS folder always has its entrypoint. Without it, bridge tests here
  // land in doctor's missing-entrypoint branch instead of the one they target.
  await fs.writeFile(path.join(aiosPath, "AGENTS.md"), "# My AIOS\n");
  return aiosPath;
}

// doctor detected agents from the ambient process.env.PATH, so its agent
// section depended on what the developer happened to have installed — a real
// `hermes` on PATH silently changed which branch these tests exercised.
async function runDoctor({ aiosPath, homePath, detection }) {
  const { doctorCommand } = await import(
    path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
  );
  const lines = [];
  const origLog = console.log.bind(console);
  const prevExitCode = process.exitCode;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await doctorCommand(["--verbose", "--path", aiosPath, "--home", homePath], { detection });
    return { output: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = origLog;
    process.exitCode = prevExitCode;
  }
}

// A PATH with no agent binaries on it at all. Detection then rests entirely on
// the sandbox home, which is what each of these fixtures is controlling.
const noAgentBinaries = { env: { PATH: "" } };

describe("doctor native-skill runtimes", () => {
  let tmpBase;

  before(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-native-"));
  });

  after(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  async function makeHome(label) {
    const homePath = path.join(tmpBase, `home-${label}`);
    await fs.mkdir(homePath, { recursive: true });
    return homePath;
  }

  // With no source skills, "every skill is linked" is vacuously true and a
  // symlink target looks complete however empty it is.
  async function addSourceSkill(aiosPath) {
    await fs.mkdir(path.join(aiosPath, "skills", "today"), { recursive: true });
    await fs.writeFile(
      path.join(aiosPath, "skills", "today", "SKILL.md"),
      "---\nname: today\ndescription: plan today\n---\n"
    );
  }

  it("warns for a runtime detected only by a same-named binary on PATH", async () => {
    const aiosPath = await makeMinimalAios(path.join(tmpBase, "phantom"));
    const homePath = await makeHome("phantom");
    const fakeBin = path.join(tmpBase, "fakebin");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(path.join(fakeBin, "hermes"), "#!/bin/sh\necho unrelated\n", { mode: 0o755 });

    const { output } = await runDoctor({
      aiosPath,
      homePath,
      detection: { env: { PATH: fakeBin } }
    });

    assert.match(output, /\[warn\] Hermes native skills/);
    assert.doesNotMatch(output, /\[ok\] Hermes native skills/);
    assert.match(output, /config\.yaml/);
  });

  it("does not let a phantom runtime suppress the nothing-is-connected warning", async () => {
    const aiosPath = await makeMinimalAios(path.join(tmpBase, "suppress"));
    const homePath = await makeHome("suppress");
    const fakeBin = path.join(tmpBase, "fakebin2");
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.writeFile(path.join(fakeBin, "hermes"), "#!/bin/sh\necho unrelated\n", { mode: 0o755 });

    const { output } = await runDoctor({
      aiosPath,
      homePath,
      detection: { env: { PATH: fakeBin } }
    });

    assert.match(output, /At least one AI tool connected/);
  });

  // activate creates ~/.gemini/antigravity/skills for a client it declared "not
  // detected" in the same run, and that path is Antigravity's own detect path.
  // This phantom needs no stray binary at all.
  it("warns for a symlink runtime whose skill directory holds no live links", async () => {
    const aiosPath = await makeMinimalAios(path.join(tmpBase, "antigravity"));
    await addSourceSkill(aiosPath);
    const homePath = await makeHome("antigravity");
    await fs.mkdir(path.join(homePath, ".gemini", "antigravity", "skills"), { recursive: true });

    const { output } = await runDoctor({ aiosPath, homePath, detection: noAgentBinaries });

    assert.match(output, /\[warn\] Antigravity native skills/);
    assert.doesNotMatch(output, /\[ok\] Antigravity native skills/);
  });

  it("reports a runtime whose config really lists the skills directory as healthy", async () => {
    const aiosPath = await makeMinimalAios(path.join(tmpBase, "healthy-hermes"));
    const homePath = await makeHome("healthy-hermes");
    await fs.mkdir(path.join(aiosPath, "skills"), { recursive: true });
    await fs.mkdir(path.join(homePath, ".hermes"), { recursive: true });
    await fs.writeFile(
      path.join(homePath, ".hermes", "config.yaml"),
      `skills:\n  external_dirs:\n    - ${path.join(aiosPath, "skills")}\n`
    );

    const { output } = await runDoctor({ aiosPath, homePath, detection: noAgentBinaries });

    assert.match(output, /\[ok\] Hermes native skills/);
    assert.doesNotMatch(output, /\[warn\] Hermes native skills/);
  });

  it("keeps an unconfigured runtime a warning, not a blocking failure", async () => {
    const aiosPath = await makeMinimalAios(path.join(tmpBase, "exitcode"));
    const homePath = await makeHome("exitcode");
    await fs.mkdir(path.join(homePath, ".hermes"), { recursive: true });

    const { exitCode } = await runDoctor({ aiosPath, homePath, detection: noAgentBinaries });

    assert.notEqual(exitCode, 1, "a native-skills warning must not turn doctor into a failed run");
  });
});

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

  it("prints [ok] for the folder and warns when its schema can be migrated", async () => {
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
      lines.some((l) => l.includes("[warn]") && l.includes("aios.json schema update")),
      `expected migration warning, got: ${lines.join("\n").slice(0, 400)}`
    );
  });

  it("warns when a managed bridge still references the pre-1.23 digest tool", async () => {
    const aiosPath = await makeMinimalAios(tmpBase);
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-home-legacy-"));
    const bridgePath = path.join(tmpHome, ".claude", "CLAUDE.md");
    await fs.mkdir(path.dirname(bridgePath), { recursive: true });
    await fs.writeFile(bridgePath, [
      "# DotAIOS Claude Code Bridge",
      "<!-- dotaios-managed:start -->",
      `Read ${path.join(aiosPath, "AGENTS.md")} first.`,
      "Run read_session_digest at session start.",
      "<!-- dotaios-managed:end -->"
    ].join("\n"));
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
    assert.match(lines.join("\n"), /predates v1\.23.*read_session_digest/i);
  });
});
