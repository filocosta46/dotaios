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

describe("doctor Claude config root", () => {
  it("reports the default root without claiming host selection when CLAUDE_CONFIG_DIR is unset", async () => {
    const homePath = path.join(os.tmpdir(), "dotaios-doctor-claude-default-home");
    const { checkClaudeConfigRoot } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const check = checkClaudeConfigRoot(homePath, { env: {} });

    assert.equal(check.status, "ok");
    assert.match(check.detail, /No CLAUDE_CONFIG_DIR override is visible/);
    assert.ok(check.detail.includes(path.join(homePath, ".claude")));
  });

  it("warns when CLAUDE_CONFIG_DIR selects a different user root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-claude-root-"));
    const homePath = path.join(root, "home");
    const activeRoot = path.join(root, "profiles", "personal");
    const { checkClaudeConfigRoot } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    try {
      const check = checkClaudeConfigRoot(homePath, {
        env: { CLAUDE_CONFIG_DIR: activeRoot }
      });

      assert.equal(check.status, "warn");
      assert.match(check.detail, /CLAUDE_CONFIG_DIR/);
      assert.ok(check.detail.includes(path.join(homePath, ".claude")));
      assert.ok(check.detail.includes(activeRoot));
      assert.match(check.detail, /default-root bridge and skill projection is not evidence/i);
      assert.equal(check.fix, undefined);
      assert.doesNotMatch(JSON.stringify(check), /symlink|\bcopy\b|activate/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats an explicit default root as non-divergent", async () => {
    const homePath = path.join(os.tmpdir(), "dotaios-doctor-claude-explicit-home");
    const defaultRoot = path.join(homePath, ".claude");
    const { checkClaudeConfigRoot } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const check = checkClaudeConfigRoot(homePath, {
      env: { CLAUDE_CONFIG_DIR: defaultRoot }
    });

    assert.equal(check.status, "ok");
    assert.match(check.detail, /CLAUDE_CONFIG_DIR selects the default/);
  });

  it("uses the default root for a relative CLAUDE_CONFIG_DIR", async () => {
    const homePath = path.join(os.tmpdir(), "dotaios-doctor-claude-relative-home");
    const { checkClaudeConfigRoot } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const check = checkClaudeConfigRoot(homePath, {
      env: { CLAUDE_CONFIG_DIR: "profiles/personal" }
    });

    assert.equal(check.status, "ok");
    assert.match(check.detail, /not absolute/i);
    assert.ok(check.detail.includes(path.join(homePath, ".claude")));
  });

  it("does not report an unread default Claude bridge as healthy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-claude-bridge-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    const activeRoot = path.join(root, "profiles", "personal");
    const defaultBridge = path.join(homePath, ".claude", "CLAUDE.md");
    const defaultBridgeText = [
      "<!-- dotaios-managed:start -->",
      `DotAIOS keeps the user's personal context in a folder at ${aiosPath} (entrypoint: ${path.join(aiosPath, "AGENTS.md")}).`,
      "<!-- dotaios-managed:end -->",
      ""
    ].join("\n");
    await fs.mkdir(path.dirname(defaultBridge), { recursive: true });
    await fs.writeFile(defaultBridge, defaultBridgeText);
    await fs.writeFile(path.join(path.dirname(defaultBridge), "settings.json"), "{}\n");

    try {
      const { output } = await runDoctor({
        aiosPath,
        homePath,
        detection: { env: { PATH: "", CLAUDE_CONFIG_DIR: activeRoot } }
      });

      assert.match(output, /\[warn\] Claude Code configuration root/);
      assert.match(output, /CLAUDE_CONFIG_DIR/);
      assert.ok(output.includes(activeRoot));
      assert.doesNotMatch(output, /\[ok\] Claude Code bridge/);
      assert.doesNotMatch(output, /not connected to this AIOS folder yet/i);
      assert.doesNotMatch(output, /run `npx dotaios(?:@[^ ]+)? activate`/i);
      assert.equal(await fs.readFile(defaultBridge, "utf8"), defaultBridgeText);
      await assert.rejects(fs.access(activeRoot), { code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("doctor secret boundary", () => {
  it("requires a local .env to be a private regular file without reading it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-secret-"));
    const aiosPath = await makeMinimalAios(root);
    const secretPath = path.join(aiosPath, ".env");
    const { checkSecretBoundary } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    try {
      await fs.writeFile(secretPath, "API_KEY=never-read-this\n", { mode: 0o644 });
      const exposed = await checkSecretBoundary(aiosPath, { platform: "darwin" });
      assert.equal(exposed.status, "fail");
      assert.match(exposed.fix, /chmod 600/);

      await fs.chmod(secretPath, 0o600);
      assert.equal((await checkSecretBoundary(aiosPath, { platform: "darwin" })).status, "ok");

      await fs.unlink(secretPath);
      await fs.symlink(path.join(root, "outside.env"), secretPath);
      assert.equal((await checkSecretBoundary(aiosPath, { platform: "darwin" })).status, "fail");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a private-looking .env owned by another POSIX account", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-secret-owner-"));
    const aiosPath = await makeMinimalAios(root);
    const secretPath = path.join(aiosPath, ".env");
    const { checkSecretBoundary } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    try {
      await fs.writeFile(secretPath, "TOKEN=secret\n", { mode: 0o600 });
      const actual = await fs.lstat(secretPath);
      const foreign = new Proxy(actual, {
        get(target, property) {
          if (property === "uid") return 99999;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const check = await checkSecretBoundary(aiosPath, {
        platform: "linux",
        currentUid: 1000,
        fileSystem: { lstat: async () => foreign }
      });
      assert.equal(check.status, "fail");
      assert.match(`${check.detail} ${check.fix}`, /owned|account|ownership/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("warns on Windows when local ACL privacy cannot be verified", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-secret-windows-"));
    const aiosPath = await makeMinimalAios(root);
    const { checkSecretBoundary } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    try {
      const stats = {
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
        mode: 0o100600,
        uid: 1000
      };
      const check = await checkSecretBoundary(aiosPath, {
        platform: "win32",
        fileSystem: { lstat: async () => stats }
      });
      assert.equal(check.status, "warn");
      assert.match(`${check.detail} ${check.fix}`, /ACL|Windows|privacy|permissions/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

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

  // ~/.gemini/antigravity is Antigravity's detect path, so its presence alone
  // makes the client detected with no stray binary at all. Its skills, though,
  // are projected to the documented ~/.gemini/config/skills. Create both: the
  // detect directory to be seen, and an empty projection root to be the
  // "directory exists but holds no live links" case this test is named for.
  it("warns for a symlink runtime whose skill directory holds no live links", async () => {
    const aiosPath = await makeMinimalAios(path.join(tmpBase, "antigravity"));
    await addSourceSkill(aiosPath);
    const homePath = await makeHome("antigravity");
    await fs.mkdir(path.join(homePath, ".gemini", "antigravity"), { recursive: true });
    await fs.mkdir(path.join(homePath, ".gemini", "config", "skills"), { recursive: true });

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
    await fs.writeFile(path.join(tmpHome, ".claude", "settings.json"), "{}\n");
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
      await doctorCommand(["--verbose", "--path", aiosPath, "--home", tmpHome]);
    } finally {
      console.log = origLog;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
    assert.match(lines.join("\n"), /predates v1\.23.*read_session_digest/i);
  });
});

describe("doctor command reachability", () => {
  it("reports an exact candidate with no persistent PATH CLI", async () => {
    const { checkCliInstallations } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const result = await checkCliInstallations({
      candidateVersion: "2.0.11",
      inspectPersistent: async () => ({ status: "missing", ownership: "none" })
    });

    assert.equal(result.status, "ok");
    assert.match(result.detail, /Candidate CLI: 2\.0\.11 \(`npx dotaios@2\.0\.11`\)/);
    assert.match(result.detail, /Persistent PATH CLI: not installed\./);
  });

  it("reports the candidate and an owned stale global separately", async () => {
    const { checkCliInstallations } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const result = await checkCliInstallations({
      candidateVersion: "2.0.11",
      inspectPersistent: async () => ({
        status: "owned",
        ownership: "owned",
        version: "2.0.9",
        command_path: "/example/bin/dotaios"
      })
    });

    assert.equal(result.status, "warn");
    assert.match(result.detail, /Candidate CLI: 2\.0\.11 \(`npx dotaios@2\.0\.11`\)/);
    assert.match(result.detail, /Persistent PATH CLI: 2\.0\.9 .*stale/i);
    assert.match(result.detail, /\/example\/bin\/dotaios/);
  });

  it("requires exact version identity before calling a persistent CLI a match", async () => {
    const { checkCliInstallations } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    for (const persistentVersion of ["2.0.11-beta.1", "2.0.11+other-build"]) {
      const result = await checkCliInstallations({
        candidateVersion: "2.0.11",
        inspectPersistent: async () => ({
          status: "owned",
          ownership: "owned",
          version: persistentVersion,
          command_path: "/example/bin/dotaios"
        })
      });

      assert.equal(result.status, "warn");
      assert.doesNotMatch(result.detail, /matches candidate/i);
      assert.match(result.detail, /does not match candidate/i);
    }
  });

  it("reports an unrecognized PATH command as unknown and unowned", async () => {
    const { checkCliInstallations } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    const result = await checkCliInstallations({
      candidateVersion: "2.0.11",
      inspectPersistent: async () => ({
        status: "unknown",
        ownership: "unowned",
        command_path: "/custom/bin/dotaios"
      })
    });

    assert.equal(result.status, "warn");
    assert.match(result.detail, /Candidate CLI: 2\.0\.11/);
    assert.match(result.detail, /Persistent PATH CLI: unknown, unowned/);
    assert.match(result.detail, /\/custom\/bin\/dotaios/);
  });

  it("still classifies the persistent PATH CLI when candidate identity is unreadable", async () => {
    const { checkCliInstallations } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    let inspections = 0;

    const result = await checkCliInstallations({
      candidateVersion: null,
      resolveInvocation: async () => {
        throw new Error("candidate package metadata unreadable");
      },
      inspectPersistent: async () => {
        inspections += 1;
        return {
          status: "owned",
          ownership: "owned",
          version: "2.0.9",
          command_path: "/example/bin/dotaios"
        };
      }
    });

    assert.equal(inspections, 1);
    assert.equal(result.status, "warn");
    assert.match(result.detail, /Candidate CLI: unknown/i);
    assert.match(result.detail, /Persistent PATH CLI: 2\.0\.9/);
    assert.match(result.detail, /\/example\/bin\/dotaios/);
    assert.doesNotMatch(result.detail, /npx dotaios|`dotaios\b/i);
    assert.equal(result.fix, undefined);
  });

  it("rejects a bare managed invocation without consulting the PATH binary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-bare-cli-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    await fs.mkdir(homePath, { recursive: true });
    await fs.writeFile(
      path.join(aiosPath, "AGENTS.md"),
      "Use `dotaios brief --compact --memory shared`\n"
    );
    const { checkCliReachable } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    try {
      const result = await checkCliReachable(aiosPath, homePath, {
        loadRegistry: async () => [],
        resolveInvocation: async () => "npx dotaios@2.0.11"
      });
      assert.equal(result.status, "fail");
      assert.match(result.detail, /bare|candidate|managed instruction/i);
      assert.match(result.fix, /npx dotaios@2\.0\.11 context --refresh/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses singular grammar for one stale agent bridge", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-one-stale-bridge-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    const bridgeFile = path.join(homePath, ".codex", "AGENTS.md");
    await fs.mkdir(path.dirname(bridgeFile), { recursive: true });
    await fs.writeFile(
      bridgeFile,
      [
        "<!-- dotaios-managed:start -->",
        "Run `npx dotaios@2.0.10 brief --compact --memory shared`.",
        "<!-- dotaios-managed:end -->",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(aiosPath, "AGENTS.md"),
      "Use `npx dotaios@2.0.11 brief --compact --memory shared`.\n"
    );
    const { checkCliReachable } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    try {
      const result = await checkCliReachable(aiosPath, homePath, {
        loadRegistry: async () => [{ name: "Codex", bridge: ".codex/AGENTS.md" }],
        resolveInvocation: async () => "npx dotaios@2.0.11"
      });
      assert.equal(result.status, "fail");
      assert.match(result.detail, /1 agent bridge .* tells assistants/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a stale default Claude bridge when the host selected another config root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-relocated-claude-cli-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    const bridgeFile = path.join(homePath, ".claude", "CLAUDE.md");
    await fs.mkdir(path.dirname(bridgeFile), { recursive: true });
    await fs.writeFile(
      bridgeFile,
      [
        "<!-- dotaios-managed:start -->",
        "Run `npx dotaios@2.0.10 brief --compact --memory shared`.",
        "<!-- dotaios-managed:end -->",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(aiosPath, "AGENTS.md"),
      "Use `npx dotaios@2.0.11 brief --compact --memory shared`.\n"
    );
    const { checkCliReachable } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    try {
      const result = await checkCliReachable(aiosPath, homePath, {
        env: { CLAUDE_CONFIG_DIR: path.join(root, "profiles", "personal") },
        loadRegistry: async () => [{ name: "Claude Code", bridge: ".claude/CLAUDE.md" }],
        resolveInvocation: async () => "npx dotaios@2.0.11"
      });

      assert.equal(result.status, "ok");
      assert.match(result.detail, /files? this check (?:could )?read/i);
      assert.match(result.detail, /Claude Code/i);
      assert.doesNotMatch(result.detail, /^Every file that names/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects predecessor-pinned and unpinned managed invocations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-pinned-cli-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    const bridgeFile = path.join(homePath, ".codex", "AGENTS.md");
    await fs.mkdir(path.dirname(bridgeFile), { recursive: true });
    await fs.writeFile(
      bridgeFile,
      [
        "<!-- dotaios-managed:start -->",
        "Run `npx dotaios@2.0.10 brief --compact --memory shared`.",
        "<!-- dotaios-managed:end -->",
        ""
      ].join("\n")
    );
    await fs.writeFile(
      path.join(aiosPath, "AGENTS.md"),
      "Use `npx dotaios brief --compact --memory shared`.\n"
    );
    const { checkCliReachable } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    try {
      const result = await checkCliReachable(aiosPath, homePath, {
        loadRegistry: async () => [{ name: "Codex", bridge: ".codex/AGENTS.md" }],
        resolveInvocation: async () => "npx dotaios@2.0.11"
      });
      assert.equal(result.status, "fail");
      assert.match(result.detail, /agent bridge/i);
      assert.match(result.detail, /AIOS router/i);
      assert.match(result.detail, /non-candidate|exact candidate/i);
      assert.match(result.fix, /npx dotaios@2\.0\.11 activate/);
      assert.match(result.fix, /npx dotaios@2\.0\.11 context --refresh/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports stale managed instructions without inventing a command when candidate identity is unreadable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-unreadable-candidate-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    await fs.mkdir(homePath, { recursive: true });
    await fs.writeFile(
      path.join(aiosPath, "AGENTS.md"),
      "Use `dotaios brief --compact --memory shared`\n"
    );
    const { checkCliReachable } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    try {
      const result = await checkCliReachable(aiosPath, homePath, {
        loadRegistry: async () => [],
        resolveInvocation: async () => {
          throw new Error("candidate package metadata unreadable");
        }
      });

      assert.equal(result.status, "fail");
      assert.match(result.detail, /bare|candidate|managed instruction/i);
      assert.equal(result.fix, undefined);
      assert.doesNotMatch(JSON.stringify(result), /npx dotaios|`dotaios (?:activate|context)/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the router names an empty command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-empty-cli-"));
    const aiosPath = await makeMinimalAios(root);
    const homePath = path.join(root, "home");
    await fs.mkdir(homePath, { recursive: true });
    await fs.writeFile(
      path.join(aiosPath, "AGENTS.md"),
      [
        "Use ` brief --compact --memory shared`",
        "https://github.com/filocosta46/dotaios/blob/v/docs/security.md#plugins",
        ""
      ].join("\n")
    );
    const { checkCliReachable } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );
    try {
      const result = await checkCliReachable(aiosPath, homePath, {
        loadRegistry: async () => [],
        isAvailable: async () => false,
        resolveInvocation: async () => "npx dotaios@2.0.8"
      });
      assert.equal(result.status, "fail");
      assert.match(result.detail, /empty|unrunnable|blank|cannot run/i);
      assert.match(result.fix, /context --refresh/);
      assert.doesNotMatch(result.fix, /init --overwrite/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
