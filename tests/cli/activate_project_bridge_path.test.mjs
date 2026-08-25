import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { portableAiosPointer } from "../../packages/cli/src/commands/activate.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

test("an AIOS folder inside home renders as a home-relative pointer", () => {
  assert.equal(
    portableAiosPointer("/Users/alice/aios", "/Users/alice"),
    "~/aios/AGENTS.md"
  );
  assert.equal(
    portableAiosPointer("/Users/alice/nested/aios", "/Users/alice"),
    "~/nested/aios/AGENTS.md"
  );
});

test("an AIOS folder outside home keeps its absolute pointer", () => {
  assert.equal(
    portableAiosPointer("/opt/aios", "/Users/alice"),
    "/opt/aios/AGENTS.md"
  );
});

// The project bridge is written into a checkout that teammates clone. It is
// untracked but not gitignored, so `git add .` publishes it. An absolute path
// would ship the author's username to everyone who clones the repo.
test("attach never writes the author's home path into the project bridge", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-bridge-leak-"));
  const home = path.join(base, "home");
  const aios = path.join(home, "aios");
  const repo = path.join(base, "myrepo");
  fs.mkdirSync(repo, { recursive: true });

  try {
    assert.equal(
      spawnSync(process.execPath, [cli, "init", "--yes", "--path", aios, "--home", home], {
        encoding: "utf8"
      }).status,
      0
    );
    const attach = spawnSync(
      process.execPath,
      [cli, "attach", repo, "--path", aios, "--home", home],
      { encoding: "utf8" }
    );
    assert.equal(attach.status, 0, attach.stderr);

    const bridge = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    assert.match(bridge, /~\/aios\/AGENTS\.md/);
    assert.match(bridge, /Memory: This project/);
    assert.match(bridge, /--memory project --project/);
    assert.match(
      bridge,
      new RegExp(`npx dotaios@${packageVersion.replaceAll(".", "\\.")} brief --compact --memory project --project`),
      "a managed project bridge must name the exact package candidate"
    );
    assert.doesNotMatch(bridge, /`dotaios\s+[a-z]/, "a managed project bridge must never use PATH selection");
    assert.doesNotMatch(bridge, /npx dotaios(?!@)/, "a managed project bridge must never select unpinned npm code");
    assert.match(bridge, /exclude personal, unscoped, and other-project memory/i);
    assert.doesNotMatch(bridge, /Before personal recommendations.*read/is);
    assert.doesNotMatch(
      bridge,
      new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the bridge published an absolute home path:\n${bridge}`
    );
    assert.doesNotMatch(bridge, /\/Users\/|\/home\//);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
