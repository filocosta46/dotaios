import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MANAGED_END, MANAGED_START } from "../../packages/core/src/bridges.mjs";

const run = promisify(execFile);
const cli = path.resolve("packages/cli/src/index.mjs");

// Anyone who has ever asked Claude Code to remember a preference already has a
// ~/.claude/CLAUDE.md with no DotAIOS markers in it. Refusing to touch that file
// left the most common user in the worst possible state: skills linked, exit 0,
// no error — and their assistant never learned who they are. The managed block
// is delimited, so appending it below their own text is removable and loses
// nothing. Replacing the file remains an explicit --overwrite decision.

async function sandbox() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-unmanaged-"));
  const aiosPath = path.join(base, "aios");
  const homePath = path.join(base, "home");
  await fs.mkdir(path.join(homePath, ".claude"), { recursive: true });
  await run(process.execPath, [cli, "init", "--path", aiosPath, "--yes"]);
  return { base, aiosPath, homePath, bridge: path.join(homePath, ".claude", "CLAUDE.md") };
}

async function activate(aiosPath, homePath, extra = ["--merge"]) {
  return run(process.execPath, [cli, "activate", "--path", aiosPath, "--home", homePath, ...extra]);
}

const USER_TEXT = "# My notes\n\nAlways answer in Italian.\n";

describe("an existing unmanaged bridge file", () => {
  it("gets the managed block appended, and keeps every byte the user wrote", async () => {
    const { aiosPath, homePath, bridge } = await sandbox();
    await fs.writeFile(bridge, USER_TEXT);

    await activate(aiosPath, homePath);

    const after = await fs.readFile(bridge, "utf8");
    assert.ok(after.startsWith(USER_TEXT), "the user's own file is still at the top, unchanged");
    assert.ok(after.includes(MANAGED_START), "DotAIOS actually connected");
    assert.ok(after.includes(MANAGED_END));
    assert.ok(
      after.indexOf(MANAGED_START) > after.indexOf("Always answer in Italian"),
      "the managed block is appended below the user's content, never above it"
    );
  });

  it("preserves a copy of the original using the project's own backup convention", async () => {
    const { aiosPath, homePath, bridge } = await sandbox();
    await fs.writeFile(bridge, USER_TEXT);

    await activate(aiosPath, homePath);

    const dir = path.dirname(bridge);
    const preserved = (await fs.readdir(dir))
      .filter((entry) => entry.startsWith(`${path.basename(bridge)}.dotaios-backup-`));
    assert.equal(preserved.length, 1, "exactly one preserved copy, matching how every bridge update behaves");
    assert.equal(await fs.readFile(path.join(dir, preserved[0]), "utf8"), USER_TEXT);
  });

  it("is idempotent — repeated activation appends exactly one block", async () => {
    const { aiosPath, homePath, bridge } = await sandbox();
    await fs.writeFile(bridge, USER_TEXT);

    await activate(aiosPath, homePath);
    const first = await fs.readFile(bridge, "utf8");
    await activate(aiosPath, homePath);
    await activate(aiosPath, homePath);
    const third = await fs.readFile(bridge, "utf8");

    assert.equal(third, first, "nothing changes on re-activation");
    assert.equal(third.split(MANAGED_START).length - 1, 1, "exactly one managed block");
  });

  it("still refuses a file whose managed markers are malformed", async () => {
    const { aiosPath, homePath, bridge } = await sandbox();
    // An end marker with no start: ambiguous, so it must fail closed rather than
    // guess where the block boundary is.
    const malformed = `notes\n${MANAGED_END}\nmore\n`;
    await fs.writeFile(bridge, malformed);

    // This one is a real collision, so activate must still report it and exit
    // non-zero. Appending would guess where the block boundary was meant to be.
    await assert.rejects(
      () => activate(aiosPath, homePath, ["--merge"]),
      (error) => {
        assert.match(String(error.stderr ?? error.message), /collision/i);
        return true;
      }
    );

    assert.equal(await fs.readFile(bridge, "utf8"), malformed, "an ambiguous file is left alone");
  });

  it("leaves a file that already carries a managed block spliced, not appended twice", async () => {
    const { aiosPath, homePath, bridge } = await sandbox();
    await fs.writeFile(bridge, USER_TEXT);
    await activate(aiosPath, homePath);
    const afterFirst = await fs.readFile(bridge, "utf8");
    assert.equal(afterFirst.split(MANAGED_START).length - 1, 1);

    // Append trailing user content after the block, then re-activate.
    await fs.appendFile(bridge, "\n# Trailing note\n");
    await activate(aiosPath, homePath);

    const after = await fs.readFile(bridge, "utf8");
    assert.ok(after.includes("Always answer in Italian"), "leading user text survives");
    assert.ok(after.includes("# Trailing note"), "trailing user text survives");
    assert.equal(after.split(MANAGED_START).length - 1, 1, "still exactly one managed block");
  });
});
