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
      allOutput.includes("step 2") || allOutput.includes("activate") || allOutput.includes("skip") || allOutput.includes("re-run"),
      `Expected failure guidance in output, got: ${allOutput.slice(0, 500)}`
    );
  });
});
