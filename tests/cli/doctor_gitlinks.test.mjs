import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkTrackedGitlinks } from "../../packages/cli/src/commands/doctor.mjs";

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

test("a folder with no gitlinks passes", () => {
  const check = checkTrackedGitlinks("/anywhere", {
    runGit: () => "100644 aaaa 0\tcontext/identity.md\n100644 bbbb 0\taios.json\n"
  });
  assert.equal(check.status, "ok");
});

test("a folder that is not a Git repository is not a failure", () => {
  const check = checkTrackedGitlinks("/anywhere", { runGit: () => null });
  assert.equal(check.status, "ok");
  assert.match(check.detail, /not a Git repository/);
});

test("committed gitlinks are reported by path", () => {
  const check = checkTrackedGitlinks("/anywhere", {
    runGit: () =>
      "100644 aaaa 0\taios.json\n" +
      "160000 58e00d5369181dc0b84b45a2a55e6f64a017f59b 0\tprojects/demo/reference/template\n"
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /projects\/demo\/reference\/template/);
  assert.match(check.detail, /clone of this folder gets them empty/);
  assert.match(check.fix, /git rm --cached/);
});

// The whole point of the check is that the pointer is invisible: the files sit
// on disk locally and only a fresh clone reveals the hole. Assert against a
// real index rather than a hand-written string.
test("detects a real gitlink in a real repository", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-gitlink-"));
  try {
    const outer = path.join(base, "aios");
    const inner = path.join(outer, "projects", "vendored");
    fs.mkdirSync(inner, { recursive: true });
    git(base, ["init", "-q", "aios"]);
    git(outer, ["config", "user.email", "test@example.test"]);
    git(outer, ["config", "user.name", "Test"]);

    spawnSync("git", ["-C", inner, "init", "-q"], { encoding: "utf8" });
    git(inner, ["config", "user.email", "test@example.test"]);
    git(inner, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(inner, "README.md"), "vendored content\n");
    git(inner, ["add", "README.md"]);
    git(inner, ["commit", "-qm", "seed"]);

    git(outer, ["add", "projects/vendored"]);

    const check = checkTrackedGitlinks(outer);
    assert.equal(check.status, "warn", JSON.stringify(check));
    assert.match(check.detail, /projects\/vendored/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
