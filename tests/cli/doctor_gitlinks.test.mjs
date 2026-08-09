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

const entries = (...lines) => ({ kind: "index", entries: lines.join("\0") });

test("a folder with no gitlinks passes", () => {
  const check = checkTrackedGitlinks("/anywhere", {
    runGit: () => entries("100644 aaaa 0\tcontext/identity.md", "100644 bbbb 0\taios.json")
  });
  assert.equal(check.status, "ok");
});

test("a folder that is not a Git repository is not a failure", () => {
  const check = checkTrackedGitlinks("/anywhere", { runGit: () => ({ kind: "not-a-repo" }) });
  assert.equal(check.status, "ok");
  assert.match(check.detail, /not a Git repository/);
});

test("committed gitlinks are reported by path", () => {
  const check = checkTrackedGitlinks("/anywhere", {
    runGit: () => entries(
      "100644 aaaa 0\taios.json",
      "160000 58e00d5369181dc0b84b45a2a55e6f64a017f59b 0\tprojects/demo/reference/template"
    )
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /projects\/demo\/reference\/template/);
  assert.match(check.fix, /git rm --cached/);
});

// A check that cannot run must never claim the folder is clean, and must never
// claim a specific reason it did not verify. Reporting "not a Git repository"
// on an ENOBUFS was the original defect: it failed open on exactly the large
// folders most likely to contain a vendored repository.
for (const [label, reason] of [
  ["git is missing", "ENOENT"],
  ["the index exceeds the buffer", "ENOBUFS"],
  ["git times out", "ETIMEDOUT"]
]) {
  test(`an unreadable index warns rather than passing when ${label}`, () => {
    const check = checkTrackedGitlinks("/anywhere", {
      runGit: () => ({ kind: "unavailable", reason })
    });
    assert.equal(check.status, "warn", "an unrun check must not report ok");
    assert.match(check.detail, new RegExp(reason));
    assert.match(check.detail, /did not run/);
    assert.doesNotMatch(check.detail, /not a Git repository/, "must not claim a reason it did not verify");
  });
}

test("non-ASCII gitlink paths are reported unquoted so the suggested fix is usable", () => {
  const check = checkTrackedGitlinks("/anywhere", {
    runGit: () => entries("160000 dead 0\tproyectos/caffè-plantilla")
  });
  assert.equal(check.status, "warn");
  assert.match(check.detail, /caffè-plantilla/);
  assert.doesNotMatch(check.detail, /\\303\\250/, "octal-escaped paths cannot be pasted into the fix");
});

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

test("a large index is still read rather than reported as not-a-repo", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-gitlink-big-"));
  try {
    const repo = path.join(base, "aios");
    fs.mkdirSync(repo, { recursive: true });
    git(base, ["init", "-q", "aios"]);
    git(repo, ["config", "user.email", "test@example.test"]);
    git(repo, ["config", "user.name", "Test"]);
    // Enough tracked paths to blow past spawnSync's 1MB default buffer.
    const dir = path.join(repo, "many");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 14000; i++) {
      fs.writeFileSync(path.join(dir, `file-${String(i).padStart(6, "0")}-padding-padding.md`), "x");
    }
    git(repo, ["add", "many"]);

    const check = checkTrackedGitlinks(repo);
    assert.notEqual(check.detail, "Folder is not a Git repository; nothing to check.");
    assert.equal(check.status, "ok", JSON.stringify(check));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
