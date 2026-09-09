import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { portableAiosPointer } from "../../packages/cli/src/commands/activate.mjs";
import { applyApprovedProjectRegistration } from "../helpers/project-registration.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("portable AIOS pointers stay path-free inside and outside home", () => {
  assert.equal(
    portableAiosPointer("/Users/alice/aios", "/Users/alice"),
    "the `AGENTS.md` selected by the host-managed global bridge"
  );
  assert.equal(
    portableAiosPointer("/Users/alice/nested/aios", "/Users/alice"),
    "the `AGENTS.md` selected by the host-managed global bridge"
  );
  assert.equal(
    portableAiosPointer("/opt/aios", "/Users/alice"),
    "the `AGENTS.md` selected by the host-managed global bridge"
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
    registerApprovedProject({ aiosPath: aios, homePath: home, projectPath: repo });
    const attach = spawnSync(
      process.execPath,
      [cli, "attach", repo, "--path", aios, "--home", home],
      { encoding: "utf8" }
    );
    assert.equal(attach.status, 0, attach.stderr);

    const bridge = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    const projectRecords = bridge
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.includes('"registered_project"'));
    assert.equal(projectRecords.length, 1, "one host-written registered project identity is required");
    const projectRecord = JSON.parse(projectRecords[0]);
    assert.deepEqual(Object.keys(projectRecord), ["registered_project"]);
    assert.deepEqual(Object.keys(projectRecord.registered_project).sort(), ["id", "slug"]);
    assert.match(projectRecord.registered_project.id, /\S/);
    assert.match(projectRecord.registered_project.slug, /\S/);
    const resolved = spawnSync(
      process.execPath,
      [
        cli, "project", "resolve", projectRecord.registered_project.id,
        "--path", aios, "--home", home
      ],
      { encoding: "utf8" }
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(fs.realpathSync(resolved.stdout.trim()), fs.realpathSync(repo));
    const identified = spawnSync(
      process.execPath,
      [cli, "project", "identify", "--json", "--path", aios, "--home", home],
      { cwd: repo, encoding: "utf8" }
    );
    assert.equal(identified.status, 0, identified.stderr);
    assert.deepEqual(JSON.parse(identified.stdout), {
      receipt: "Memory: This project",
      registered_project: projectRecord.registered_project
    });
    assert.match(bridge, /AGENTS\.md.*host-managed global bridge/);
    assert.match(bridge, /Memory: This project/);
    assert.match(bridge, /project["`, ]+identify[\s\S]*same attached checkout/is);
    assert.match(bridge, /Only after[\s\S]*Memory: This project[\s\S]*registered_project/is);
    assert.match(bridge, /--memory project --project/);
    assert.match(bridge, /host-managed `candidate_invocation`/);
    assert.match(bridge, /exact configured AIOS path suffix from the global bridge/);
    assert.match(bridge, /\["brief","--compact","--memory","project","--project","[^"]+"\]/);
    assert.doesNotMatch(bridge, /\bnpx(?:\.cmd)?\s+dotaios/, "a project bridge must not define another CLI authority");
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

test("attach never writes an outside-home custom AIOS path into the project bridge", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-outside-home-bridge-leak-"));
  const home = path.join(base, "home");
  const aios = path.join(base, "private", "Operator AIOS");
  const repo = path.join(base, "myrepo");
  fs.mkdirSync(repo, { recursive: true });

  try {
    const initialized = spawnSync(
      process.execPath,
      [cli, "init", "--yes", "--path", aios, "--home", home],
      { encoding: "utf8" }
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    registerApprovedProject({ aiosPath: aios, homePath: home, projectPath: repo });
    const attach = spawnSync(
      process.execPath,
      [cli, "attach", repo, "--path", aios, "--home", home],
      { encoding: "utf8" }
    );
    assert.equal(attach.status, 0, attach.stderr);

    const bridge = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    assert.doesNotMatch(bridge, new RegExp(aios.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(bridge, /AGENTS\.md.*host-managed global bridge/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("attach refuses an unregistered project before writing registration or bridge state", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-unregistered-attach-"));
  const home = path.join(base, "home");
  const aios = path.join(home, "aios");
  const repo = path.join(base, "unregistered-project");
  fs.mkdirSync(repo, { recursive: true });

  try {
    const initialized = spawnSync(
      process.execPath,
      [cli, "init", "--yes", "--path", aios, "--home", home],
      { encoding: "utf8" }
    );
    assert.equal(initialized.status, 0, initialized.stderr);

    const identified = spawnSync(
      process.execPath,
      [cli, "project", "identify", "--json", "--path", aios, "--home", home],
      { cwd: repo, encoding: "utf8" }
    );
    assert.equal(identified.status, 0, identified.stderr);
    assert.deepEqual(JSON.parse(identified.stdout), {
      receipt: "Memory: Off",
      registered_project: null
    });

    for (const args of [
      ["attach", repo, "--path", aios, "--home", home],
      ["activate", "--project", repo, "--path", aios, "--home", home]
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not registered[\s\S]*project add/i);
      assert.equal(fs.existsSync(path.join(repo, "AGENTS.md")), false);
      assert.equal(
        fs.existsSync(path.join(aios, "projects", "unregistered-project", "README.md")),
        false
      );
      assert.equal(fs.existsSync(path.join(home, ".dotaios", "projects.json")), false);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function registerApprovedProject({ aiosPath, homePath, projectPath }) {
  applyApprovedProjectRegistration(
    (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }),
    [
    "project", "add", projectPath,
    "--path", aiosPath,
    "--home", homePath
    ]
  );
}
