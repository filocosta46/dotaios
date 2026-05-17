import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname;

describe("setupCommand — step isolation", () => {
  it("prints clear failure message and does not throw when activate fails", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-"));

    // Capture console output
    const messages = [];
    const originalError = console.error.bind(console);
    const originalLog = console.log.bind(console);
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
    } catch {
      // setup should NOT throw — it should catch and report
      assert.fail("setupCommand should not throw when a step fails — it should report and continue");
    } finally {
      console.error = originalError;
      console.log = originalLog;
      await fs.rm(tmpBase, { recursive: true, force: true });
    }

    const allOutput = messages.map(([, m]) => m).join("\n");
    // Should have a message indicating activate had issues
    assert.ok(
      allOutput.includes("Step 2 failed:") || allOutput.includes("Re-run: dotaios activate"),
      `Expected activate failure message in output, got: ${allOutput.slice(0, 500)}`
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
