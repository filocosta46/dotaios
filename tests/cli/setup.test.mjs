import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { explicitOptIn } from "../../packages/cli/src/commands/setup.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname;

test("optional setup capabilities require an explicit yes", () => {
  for (const answer of ["", "n", "no", "later", " "]) {
    assert.equal(explicitOptIn(answer), false);
  }
  for (const answer of ["y", "Y", "yes", " YES "]) {
    assert.equal(explicitOptIn(answer), true);
  }
});

test("setup --dry-run previews concrete actions without DotAIOS-managed changes", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-preview-"));
  const aiosPath = path.join(tmp, "aios");
  const homePath = path.join(tmp, "home");

  const result = spawnSync(process.execPath, [
    path.resolve(repoRoot, "packages/cli/src/index.mjs"),
    "setup",
    "--dry-run",
    "--verbose",
    "--path", aiosPath,
    "--home", homePath
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Setup preview - no DotAIOS-managed changes made/);
    assert.match(result.stdout, new RegExp(aiosPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stdout, /\[would create\]/);
    assert.match(result.stdout, /preserves unmanaged files/i);
    assert.match(result.stdout, /private GitHub sync stays off/i);
    assert.match(result.stdout, /does not copy credentials/i);
    assert.match(result.stdout, /dotaios doctor/);
    assert.match(result.stdout, /remove only DotAIOS-managed bridges/i);
    assert.match(result.stdout, /npm may download and cache the named package/i);
    assert.equal(fsSync.existsSync(aiosPath), false, "preview must not create the AIOS folder");
    assert.equal(fsSync.existsSync(homePath), false, "preview must not create client configuration");
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

// The preview built its own answer to "which skill-link directories get
// written" instead of reading the one the writer uses. It promised one
// directory while the run created three. On a machine with Claude Code
// installed only the Antigravity line is visibly missing, so this fixture must
// keep every agent undetected — no client directories and no agent binaries on
// PATH — or the test passes while .claude/skills is still under-reported.
function skillDirsUnder(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "skills") found.push(full);
      else walk(full);
    }
  };
  walk(root);
  return found.sort();
}

test("setup --dry-run promises every skill-link directory the real run creates", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-skilldirs-"));
  const aiosPath = path.join(tmp, "aios");
  const homePath = path.join(tmp, "home");
  const cli = path.resolve(repoRoot, "packages/cli/src/index.mjs");
  const env = { ...process.env, PATH: "/usr/bin:/bin" };
  const target = ["--path", aiosPath, "--home", homePath];

  try {
    const preview = spawnSync(process.execPath, [cli, "setup", "--dry-run", "--verbose", ...target], {
      encoding: "utf8",
      env
    });
    assert.equal(preview.status, 0, preview.stderr);
    const promised = [...preview.stdout.matchAll(/\[would create managed skill links\] (\S+)/g)]
      .map((match) => match[1])
      .sort();

    const real = spawnSync(process.execPath, [cli, "setup", "--yes", "--skip-reveal", ...target], {
      encoding: "utf8",
      env
    });
    assert.equal(real.status, 0, `${real.stdout}\n${real.stderr}`);
    const created = skillDirsUnder(homePath);

    assert.deepEqual(promised, created, "the preview must name exactly the directories the run creates");
    assert.deepEqual(created, [
      path.join(homePath, ".agents", "skills"),
      path.join(homePath, ".claude", "skills"),
      path.join(homePath, ".gemini", "antigravity", "skills")
    ].sort(), "all three projection roots are written with nothing detected");
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup --dry-run reports an unmanaged bridge collision without changing it", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-collision-"));
  const aiosPath = path.join(tmp, "aios");
  const homePath = path.join(tmp, "home");
  const bridgePath = path.join(homePath, ".claude", "CLAUDE.md");
  const existing = "# My existing Claude instructions\n";
  fsSync.mkdirSync(aiosPath, { recursive: true });
  fsSync.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fsSync.writeFileSync(bridgePath, existing);

  const result = spawnSync(process.execPath, [
    path.resolve(repoRoot, "packages/cli/src/index.mjs"),
    "setup",
    "--dry-run",
    "--verbose",
    "--path", aiosPath,
    "--home", homePath
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[would populate\].*existing empty directory/);
    assert.match(result.stdout, /\[would preserve collision\].*CLAUDE\.md.*existing unmanaged file/);
    assert.equal(fsSync.readFileSync(bridgePath, "utf8"), existing);
    assert.deepEqual(fsSync.readdirSync(aiosPath), []);
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup --dry-run preserves a bridge whose managed markers are reversed", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-reversed-markers-"));
  const aiosPath = path.join(tmp, "aios");
  const homePath = path.join(tmp, "home");
  const bridgePath = path.join(homePath, ".claude", "CLAUDE.md");
  const existing = "<!-- dotaios-managed:end -->\nuser content\n<!-- dotaios-managed:start -->\n";
  fsSync.mkdirSync(aiosPath, { recursive: true });
  fsSync.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fsSync.writeFileSync(bridgePath, existing);

  const result = spawnSync(process.execPath, [
    path.resolve(repoRoot, "packages/cli/src/index.mjs"),
    "setup",
    "--dry-run",
    "--verbose",
    "--path", aiosPath,
    "--home", homePath
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[would preserve collision\].*CLAUDE\.md.*managed markers are malformed/);
    assert.equal(fsSync.readFileSync(bridgePath, "utf8"), existing);
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

test("setup --dry-run preserves a bridge with duplicate managed markers", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-duplicate-markers-"));
  const aiosPath = path.join(tmp, "aios");
  const homePath = path.join(tmp, "home");
  const bridgePath = path.join(homePath, ".claude", "CLAUDE.md");
  const existing = [
    "<!-- dotaios-managed:start -->",
    "first block",
    "<!-- dotaios-managed:end -->",
    "<!-- dotaios-managed:start -->",
    "second block",
    "<!-- dotaios-managed:end -->",
    ""
  ].join("\n");
  fsSync.mkdirSync(aiosPath, { recursive: true });
  fsSync.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fsSync.writeFileSync(bridgePath, existing);

  const result = spawnSync(process.execPath, [
    path.resolve(repoRoot, "packages/cli/src/index.mjs"),
    "setup",
    "--dry-run",
    "--verbose",
    "--path", aiosPath,
    "--home", homePath
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[would preserve collision\].*CLAUDE\.md.*managed markers are malformed/);
    assert.equal(fsSync.readFileSync(bridgePath, "utf8"), existing);
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

// The folder here holds someone else's file, not a DotAIOS install. That is the
// case this protection is for, and it is unchanged. A healthy DotAIOS folder
// now previews as `[would keep]` instead — see setup_second_machine.test.mjs,
// because reporting both the same way halted the second-machine install.
test("setup --dry-run reports that a non-DotAIOS non-empty target would stop", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-blocked-"));
  const aiosPath = path.join(tmp, "aios");
  fsSync.mkdirSync(aiosPath, { recursive: true });
  fsSync.writeFileSync(path.join(aiosPath, "keep.txt"), "keep\n");

  const result = spawnSync(process.execPath, [
    path.resolve(repoRoot, "packages/cli/src/index.mjs"),
    "setup",
    "--dry-run",
    "--path", aiosPath,
    "--home", path.join(tmp, "home")
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });

  try {
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[would stop\].*already exists and is not a DotAIOS folder/);
    assert.doesNotMatch(result.stdout, /\[would create\].*aios/);
    assert.equal(fsSync.readFileSync(path.join(aiosPath, "keep.txt"), "utf8"), "keep\n");
  } finally {
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

for (const args of [
  ["--all"],
  ["--overwrite"],
  ["--vault-path", "/tmp/external-vault"]
]) {
  test(`setup --dry-run rejects unsupported preview option ${args[0]}`, () => {
    const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-option-preview-"));
    const aiosPath = path.join(tmp, "aios");
    const result = spawnSync(process.execPath, [
      path.resolve(repoRoot, "packages/cli/src/index.mjs"),
      "setup",
      "--dry-run",
      "--path", aiosPath,
      "--home", path.join(tmp, "home"),
      ...args
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" }
    });

    try {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot safely preview.*option/i);
      assert.equal(fsSync.existsSync(aiosPath), false);
    } finally {
      fsSync.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

describe("setupCommand — step isolation", () => {
  it("prints clear failure message and does not throw when activate fails", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-"));

    // Capture console output
    const messages = [];
    const originalError = console.error.bind(console);
    const originalLog = console.log.bind(console);
    const originalExitCode = process.exitCode;
    let setupExitCode;
    console.error = (...args) => messages.push(["err", args.join(" ")]);
    console.log = (...args) => messages.push(["log", args.join(" ")]);

    try {
      const { setupCommand } = await import(
        path.join(repoRoot, "packages/cli/src/commands/setup.mjs")
      );

      // Run setup with --yes (non-interactive), --skip-reveal,
      // and a deliberately invalid home dir to trigger activate failure.
      // Because activate writes to ~/.claude etc, we use --home to point
      // to a read-only location. /dev/null works on Mac/Linux.
      await setupCommand([
        "--path", path.join(tmpBase, "aios"),
        "--yes",
        "--skip-reveal",
        "--home", "/nonexistent-home-12345"
      ]);
      setupExitCode = process.exitCode;
    } catch {
      // setup should NOT throw — it should catch and report
      assert.fail("setupCommand should not throw when a step fails — it should report and continue");
    } finally {
      process.exitCode = originalExitCode;
      console.error = originalError;
      console.log = originalLog;
      await fs.rm(tmpBase, { recursive: true, force: true });
    }

    assert.equal(setupExitCode, 1, "an activation failure must set a failing process status");
    const allOutput = messages.map(([, m]) => m).join("\n");
    assert.ok(
      allOutput.includes("Step 2 failed:") || allOutput.includes("Re-run: dotaios activate"),
      `Expected activate failure message in output, got: ${allOutput.slice(0, 500)}`
    );
    assert.ok(
      allOutput.includes("Folder created. Tool connection needs attention"),
      `Expected partial-failure final message, got: ${allOutput.slice(0, 500)}`
    );
    assert.ok(
      !allOutput.includes("All set. To get started:"),
      `Expected "All set." absent when activate failed, got: ${allOutput.slice(0, 500)}`
    );
  });
});

describe("enableSchedule — fallback when entry missing", () => {
  it("returns false and prints fallback message when schedule name not found", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-enablesched-"));
    const aiosPath = path.join(tmpBase, "aios");
    await fs.mkdir(aiosPath, { recursive: true });

    const yamlContent = "schedules:\n  - name: other-schedule\n    enabled: false\n";
    await fs.writeFile(path.join(aiosPath, "schedules.yml"), yamlContent);

    const { enableSchedule } = await import(
      path.join(repoRoot, "packages/cli/src/commands/setup.mjs")
    );

    const messages = [];
    const originalLog = console.log.bind(console);
    console.log = (...args) => messages.push(args.join(" "));

    let result;
    try {
      result = await enableSchedule(aiosPath, "daily-brief");
    } finally {
      console.log = originalLog;
      await fs.rm(tmpBase, { recursive: true, force: true });
    }

    assert.equal(result, false, "should return false when schedule not found");
    assert.ok(
      messages.some((m) => m.includes("edit schedules.yml")),
      `should print manual fallback message, got: ${messages.join(" | ")}`
    );
  });

  it("returns true and enables schedule when entry found", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-enablesched2-"));
    const aiosPath = path.join(tmpBase, "aios");
    await fs.mkdir(aiosPath, { recursive: true });

    const yamlContent = "schedules:\n  - name: daily-brief\n    enabled: false\n    cron: '0 8 * * *'\n";
    await fs.writeFile(path.join(aiosPath, "schedules.yml"), yamlContent);

    const { enableSchedule } = await import(
      path.join(repoRoot, "packages/cli/src/commands/setup.mjs")
    );

    const result = await enableSchedule(aiosPath, "daily-brief");
    const updated = await fs.readFile(path.join(aiosPath, "schedules.yml"), "utf8");

    await fs.rm(tmpBase, { recursive: true, force: true });

    assert.equal(result, true, "should return true when schedule found and enabled");
    assert.ok(updated.includes("enabled: true"), "should have updated enabled to true");
    assert.ok(!updated.includes("enabled: false"), "should not still have enabled: false");
  });
});

test("non-interactive setup does not download the optional web browsing engine by default", () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "dotaios-setup-lp-"));
  const aiosPath = path.join(tmp, "aios");
  const homePath = path.join(tmp, "home");
  const processHomePath = path.join(tmp, "process-home");
  fsSync.mkdirSync(processHomePath, { recursive: true });
  const result = spawnSync(process.execPath, [
    path.resolve(repoRoot, "packages/cli/src/index.mjs"),
    "setup",
    "--path", aiosPath,
    "--home", homePath,
    "--yes",
    "--skip-reveal"
  ], {
    encoding: "utf8",
    // HOME isolation only covers the ~/.dotaios/bin probe; resolveLightpanda
    // also falls back to `which lightpanda`, so PATH must not reach a real
    // engine installed on this machine (e.g. ~/.local/bin on the fleet Mini).
    env: { ...process.env, HOME: processHomePath, PATH: "/usr/bin:/bin" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(`  2. Your one AIOS folder: ${aiosPath}`),
    `setup guidance must name the resolved --path target, got:\n${result.stdout}`
  );
  assert.match(result.stdout, /project checkout already attached with `dotaios activate`/i);
  assert.match(result.stdout, /Choose "Only this project" only inside that registered checkout/i);
  assert.doesNotMatch(result.stdout, /make it your working directory/i);
  assert.match(result.stdout, /Web browsing engine: not installed.*plain fetch remains available/);
  assert.equal(fsSync.existsSync(path.join(homePath, ".dotaios", "bin", "lightpanda")), false);
  assert.doesNotMatch(result.stdout, /All set\./);
});
