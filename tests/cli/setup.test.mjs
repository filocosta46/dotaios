import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname;

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
  assert.match(result.stdout, /Web browsing engine: not installed.*plain fetch remains available/);
  assert.equal(fsSync.existsSync(path.join(homePath, ".dotaios", "bin", "lightpanda")), false);
  assert.doesNotMatch(result.stdout, /All set\./);
});
