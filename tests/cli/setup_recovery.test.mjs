import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { appendMetric } from "../../packages/core/src/metrics.mjs";

// `dotaios setup` is the one command a brand-new user runs, and in 1.27.1 it
// lied to its caller three ways when step 1 failed:
//
//   1. it printed "Setup could not complete." and exited 0, so every wrapper,
//      CI step, and agent that checks the status code was told the install
//      worked;
//   2. the failure path itself emitted pilot metrics, and the metrics writer
//      mkdir -p's its parent — so a failed `init` still left <aios>/memory/
//      metrics/pilot.jsonl behind, and the documented retry (`dotaios setup`)
//      then died on "Target already exists and is not empty";
//   3. nothing ever cleared that wreck, so the retry could not recover.
//
// These tests pin all three. Every spawn pins HOME so no run can reach the
// developer's real ~/.dotaios (see state_isolation.test.mjs).

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const lifecycleHarness = path.join(repoRoot, "tests", "fixtures", "setup-lifecycle-harness.mjs");

function makeSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dotaios-${label}-`));
  const processHomePath = path.join(root, "process-home");
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  fs.mkdirSync(processHomePath, { recursive: true });
  fs.mkdirSync(homePath, { recursive: true });
  return { root, processHomePath, homePath, aiosPath };
}

// stdin is "ignore" so process.stdin.isTTY is undefined — the exact shape of a
// run pasted into a chat window, a CI job, or an agent shell.
function runSetup(sandbox, args, env = {}) {
  const usesLifecycleHarness = Object.keys(env).some((key) => key.startsWith("DOTAIOS_TEST_"));
  const commandArgs = usesLifecycleHarness
    ? [lifecycleHarness, "--path", sandbox.aiosPath, "--home", sandbox.homePath, "--skip-reveal", ...args]
    : [cli, "setup", "--path", sandbox.aiosPath, "--home", sandbox.homePath, "--skip-reveal", ...args];
  return spawnSync(process.execPath, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // PATH is trimmed for the same reason setup.test.mjs trims it:
    // resolveLightpanda falls back to `which lightpanda`.
    env: { ...process.env, HOME: sandbox.processHomePath, PATH: "/usr/bin:/bin", ...env }
  });
}

function startSetup(sandbox, args, env = {}) {
  const child = spawn(process.execPath, [
    lifecycleHarness,
    "--path", sandbox.aiosPath,
    "--home", sandbox.homePath,
    "--skip-reveal",
    ...args
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: sandbox.processHomePath, PATH: "/usr/bin:/bin", ...env }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    completed: new Promise((resolve) => {
      child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    })
  };
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const started = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listTree(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

test("a failed setup exits non-zero", () => {
  const sandbox = makeSandbox("setup-exit");
  // No TTY and no --yes: init cannot ask its questions, so step 1 fails.
  const result = runSetup(sandbox, []);

  assert.match(result.stderr, /Setup could not complete/);
  assert.notEqual(
    result.status,
    0,
    "a caller checking the exit code must be told setup failed, not that it succeeded"
  );
});

test("a failed setup does not create the AIOS folder", () => {
  const sandbox = makeSandbox("setup-nofolder");
  const result = runSetup(sandbox, []);

  assert.notEqual(result.status, 0);
  assert.equal(
    fs.existsSync(sandbox.aiosPath),
    false,
    `setup failed before creating anything, so nothing may be left behind: ${
      fs.existsSync(sandbox.aiosPath) ? JSON.stringify(listTree(sandbox.aiosPath)) : ""
    }`
  );
});

test("setup rejects duplicate --path values before either target is mutated", () => {
  const sandbox = makeSandbox("setup-duplicate-path");
  const secondTarget = path.join(sandbox.root, "second-aios");
  const foreignFile = path.join(secondTarget, "private-notes.md");
  fs.mkdirSync(secondTarget, { recursive: true });
  fs.writeFileSync(foreignFile, "keep this byte-for-byte\n");
  const before = fs.readFileSync(foreignFile);

  const result = runSetup(sandbox, ["--yes", "--force", "--path", secondTarget]);

  assert.notEqual(result.status, 0, "ambiguous setup targets must be rejected");
  assert.match(result.stderr, /--path may only be provided once/);
  assert.equal(fs.existsSync(sandbox.aiosPath), false, "the first target must stay absent");
  assert.deepEqual(fs.readFileSync(foreignFile), before, "foreign bytes in the second target must survive");
  assert.deepEqual(listTree(secondTarget), ["private-notes.md"], "setup must not add scaffold files to either target");
});

test("an activation failure exits non-zero and records a failed install", () => {
  const sandbox = makeSandbox("setup-activate-exit");
  const invalidHomePath = path.join(sandbox.root, "home-is-a-file");
  fs.writeFileSync(invalidHomePath, "not a directory\n");

  const result = runSetup(sandbox, ["--yes", "--all", "--home", invalidHomePath]);

  assert.ok(
    fs.existsSync(path.join(sandbox.aiosPath, "aios.json")),
    "init must finish before the invalid home makes activation fail"
  );
  assert.match(result.stderr, /Step 2 failed:/);
  assert.notEqual(result.status, 0, "an activation failure must be observable to the caller");

  const rows = fs.readFileSync(
    path.join(sandbox.aiosPath, "memory", "metrics", "reliability.jsonl"),
    "utf8"
  ).trim().split("\n").map((line) => JSON.parse(line));
  const installEnd = rows.findLast((row) => row.type === "install_end");
  assert.equal(installEnd?.outcome, "fail", "a failed activation is a failed install, not a warning");
  assert.equal(
    fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")),
    true,
    "a failed activation must retain the exact setup ownership marker for a safe identical retry"
  );
  assert.match(`${result.stdout}\n${result.stderr}`, /re-run the identical `dotaios setup` command/i);

  fs.unlinkSync(invalidHomePath);
  fs.mkdirSync(invalidHomePath);
  const retry = runSetup(sandbox, ["--yes", "--all", "--home", invalidHomePath]);
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.match(retry.stdout, /Recovered an unfinished folder/);
  assert.equal(
    fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")),
    false,
    "the successful identical retry must close the setup transaction"
  );
});

test("a raced skill catalog is preserved and the identical setup recovers after repair", () => {
  const sandbox = makeSandbox("setup-catalog-race");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_RACE_SETUP_CATALOGS: "1"
  });
  const markerPath = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const indexPath = path.join(sandbox.aiosPath, "skills", "INDEX.md");
  const resolverPath = path.join(sandbox.aiosPath, "skills", "RESOLVER.md");

  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /skill catalog changed while init was running/i);
  assert.equal(fs.readFileSync(indexPath, "utf8"), "foreign index bytes\n");
  assert.equal(fs.readFileSync(resolverPath, "utf8"), "foreign resolver bytes\n");
  assert.equal(fs.existsSync(markerPath), true, "setup ownership must survive the rejected race");

  fs.unlinkSync(indexPath);
  fs.unlinkSync(resolverPath);
  const retry = runSetup(sandbox, ["--yes"]);

  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.match(retry.stdout, /Recovered an unfinished folder/);
  assert.equal(fs.existsSync(markerPath), false, "a completed identical retry closes ownership");
  assert.match(fs.readFileSync(indexPath, "utf8"), /# Installed Skills/);
  assert.match(fs.readFileSync(resolverPath, "utf8"), /# Skill Resolver/);
});

test("a raced generated entrypoint blocks activation and recovers without overwriting it", () => {
  const sandbox = makeSandbox("setup-entrypoint-race");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_RACE_SETUP_ENTRYPOINT: "1"
  });
  const markerPath = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const entrypointPath = path.join(sandbox.aiosPath, "AGENTS.md");

  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /setup-owned path changed while setup was running/i);
  assert.equal(fs.readFileSync(entrypointPath, "utf8"), "foreign entrypoint bytes\n");
  assert.equal(fs.existsSync(markerPath), true);
  assert.equal(fs.existsSync(path.join(sandbox.homePath, ".claude", "CLAUDE.md")), false);

  fs.unlinkSync(entrypointPath);
  const retry = runSetup(sandbox, ["--yes"]);

  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.match(retry.stdout, /Recovered an unfinished folder/);
  assert.equal(fs.existsSync(markerPath), false);
  assert.match(fs.readFileSync(entrypointPath, "utf8"), /# My AIOS/);
});

test("a generated entrypoint changed after init is revalidated before activation", () => {
  const sandbox = makeSandbox("setup-post-init-entrypoint-race");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_RACE_SETUP_AFTER_INIT_ENTRYPOINT: "1"
  });
  const markerPath = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const entrypointPath = path.join(sandbox.aiosPath, "AGENTS.md");

  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /setup-owned path changed while setup was running/i);
  assert.equal(fs.readFileSync(entrypointPath, "utf8"), "foreign bytes after init\n");
  assert.equal(fs.existsSync(markerPath), true);
  assert.equal(fs.existsSync(path.join(sandbox.homePath, ".claude", "CLAUDE.md")), false);

  fs.unlinkSync(entrypointPath);
  const retry = runSetup(sandbox, ["--yes"]);
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.equal(fs.existsSync(markerPath), false);
  assert.match(fs.readFileSync(entrypointPath, "utf8"), /# My AIOS/);
});

test("the retry after a failed setup reports the original error, not a folder collision", () => {
  const sandbox = makeSandbox("setup-retry-error");
  const first = runSetup(sandbox, []);
  const second = runSetup(sandbox, []);

  assert.notEqual(first.status, 0);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /interactive terminal required/);
  assert.doesNotMatch(
    second.stderr,
    /already exists and is not empty/,
    "the retry must not be poisoned by residue the first run left behind"
  );
});

test("setup completes on a folder an earlier failed run left half-made", () => {
  const sandbox = makeSandbox("setup-recover");
  // Exactly what a 1.27.1 failed run leaves behind: the metrics file its own
  // error path wrote, and nothing else. Users upgrading are already in this
  // state, so the fix has to clear it rather than only stop creating it.
  const metricsDir = path.join(sandbox.aiosPath, "memory", "metrics");
  const legacyRunId = "2ca5bf65-d4cf-4f03-9e31-3df7efdcbe2b";
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    path.join(metricsDir, "pilot.jsonl"),
    [
      { ts: "2026-08-04T10:00:00.000Z", type: "setup_phase_start", phase: "init", run_id: legacyRunId },
      { ts: "2026-08-04T10:00:00.010Z", type: "setup_phase_end", phase: "init", run_id: legacyRunId, outcome: "fail" },
      {
        ts: "2026-08-04T10:00:00.020Z",
        type: "install_end",
        command: "setup",
        outcome: "fail",
        phase: "init",
        run_id: legacyRunId,
        duration_ms: 20
      }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n"
  );

  const result = runSetup(sandbox, ["--yes"]);

  assert.equal(result.status, 0, `setup must recover the half-made folder:\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    fs.existsSync(path.join(sandbox.aiosPath, "aios.json")),
    "recovery means the folder is actually finished, not just reported as fine"
  );
  assert.match(
    `${result.stdout}${result.stderr}`,
    /unfinished folder/i,
    "the recovery must be stated once, not performed silently"
  );
  // The residue is evidence, not garbage — recovery adds missing files, it
  // never overwrites what is already there.
  assert.match(fs.readFileSync(path.join(metricsDir, "pilot.jsonl"), "utf8"), /"outcome":"fail"/);
});

test("legacy 1.27.1 residue requires its exact ordered three-row shared-run shape", () => {
  const runId = "2ca5bf65-d4cf-4f03-9e31-3df7efdcbe2b";
  const exactRows = [
    { ts: "2026-08-04T10:00:00.000Z", type: "setup_phase_start", phase: "init", run_id: runId },
    { ts: "2026-08-04T10:00:00.010Z", type: "setup_phase_end", phase: "init", run_id: runId, outcome: "fail" },
    { ts: "2026-08-04T10:00:00.020Z", type: "install_end", command: "setup", outcome: "fail", phase: "init", run_id: runId, duration_ms: 20 }
  ];

  for (const [label, rows] of [
    ["different run", exactRows.map((row, index) => index === 1 ? { ...row, run_id: "00000000-0000-4000-8000-000000000000" } : row)],
    ["reordered", [exactRows[1], exactRows[0], exactRows[2]]],
    ["extra field", exactRows.map((row, index) => index === 2 ? { ...row, note: "foreign" } : row)],
    ["missing install end", exactRows.slice(0, 2)]
  ]) {
    const sandbox = makeSandbox(`legacy-residue-${label.replaceAll(" ", "-")}`);
    const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl");
    fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
    fs.writeFileSync(metricsFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const result = runSetup(sandbox, ["--yes"]);
    assert.notEqual(result.status, 0, `${label} must not prove legacy setup ownership`);
    assert.match(result.stderr, /already exists and is not empty/);
  }
});

test("the identical setup command recovers an interruption after the base tree is created", () => {
  const sandbox = makeSandbox("setup-transaction-recover");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE: "1"
  });

  assert.notEqual(first.status, 0, "the injected interruption must stop the first setup");
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.ok(
    fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")),
    "setup must record ownership before createBaseTree mutates the target"
  );
  const metrics = fs.readFileSync(
    path.join(sandbox.aiosPath, "memory", "metrics", "reliability.jsonl"),
    "utf8"
  );
  assert.match(metrics, /"setup_phase_end".*"init".*"fail"/, "mid-scaffold failure remains visible in metrics");
  assert.match(metrics, /"install_end".*"fail"/, "the failed install remains visible in metrics");

  const retry = runSetup(sandbox, ["--yes"]);

  assert.equal(retry.status, 0, `the documented identical retry must recover:\n${retry.stdout}\n${retry.stderr}`);
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")));
  assert.equal(
    fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")),
    false,
    "a completed setup must remove its recovery marker"
  );
  assert.match(`${retry.stdout}${retry.stderr}`, /unfinished folder/i);
});

test("--force refuses an unfinished setup marker instead of orphaning it", () => {
  const sandbox = makeSandbox("setup-marker-force");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE: "1"
  });
  assert.notEqual(first.status, 0);
  const marker = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const before = fs.readFileSync(marker);

  const forced = runSetup(sandbox, ["--yes", "--force"]);
  assert.notEqual(forced.status, 0);
  assert.match(forced.stderr, /unfinished setup|re-run.*without.*force/i);
  assert.deepEqual(fs.readFileSync(marker), before);
});

test("init --force cannot bypass an unfinished setup marker", () => {
  const sandbox = makeSandbox("init-marker-force");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE: "1"
  });
  assert.notEqual(first.status, 0);
  const marker = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const before = fs.readFileSync(marker);

  const forced = spawnSync(process.execPath, [
    cli,
    "init",
    "--path", sandbox.aiosPath,
    "--yes",
    "--force"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: sandbox.processHomePath, PATH: "/usr/bin:/bin" }
  });

  assert.notEqual(forced.status, 0);
  assert.match(forced.stderr, /unfinished setup|re-run.*without.*force/i);
  assert.deepEqual(fs.readFileSync(marker), before);
});

test("production setup and activation contain no environment-controlled test branches", () => {
  for (const relative of [
    "packages/cli/src/commands/setup.mjs",
    "packages/cli/src/commands/activate.mjs"
  ]) {
    assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, relative), "utf8"), /DOTAIOS_TEST_/);
  }
});

test("the sync mirror ignores permanent and temporary setup transaction markers", () => {
  const template = fs.readFileSync(path.join(repoRoot, "templates", "sync-gitignore.template"), "utf8");
  assert.match(template, /^\.dotaios-setup-transaction\.json$/m);
  assert.match(template, /^\.dotaios-setup-\*\.tmp$/m);
});

test("the identical setup command recovers a hard interruption after init", () => {
  const sandbox = makeSandbox("setup-after-init-interrupt");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT: "1"
  });

  assert.equal(first.signal, "SIGKILL", `expected the deterministic hard interruption:\n${first.stdout}\n${first.stderr}`);
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), "init must have completed before interruption");
  assert.ok(
    fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")),
    "ownership evidence must survive until activation reaches a handled outcome"
  );

  const retry = runSetup(sandbox, ["--yes"]);

  assert.equal(retry.status, 0, `the identical retry must preserve init output and continue:\n${retry.stdout}\n${retry.stderr}`);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")), false);
  assert.match(`${retry.stdout}${retry.stderr}`, /unfinished folder/i);
});

test("the identical setup command recovers a hard interruption before marker publication", () => {
  const sandbox = makeSandbox("setup-marker-prepublish-interrupt");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_BEFORE_MARKER_LINK: "1"
  });

  assert.equal(first.signal, "SIGKILL");
  assert.deepEqual(listTree(sandbox.aiosPath), [], "pre-publication residue must stay outside the empty target");
  assert.equal(
    fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")),
    false,
    "the canonical marker must not exist before its exclusive hard link"
  );
  assert.ok(
    fs.readdirSync(sandbox.root).some((entry) => /^\.aios\.dotaios-setup-[^.]+\.tmp$/.test(entry)),
    "the complete private staging inode must be beside the target"
  );

  const retry = runSetup(sandbox, ["--yes"]);

  assert.equal(retry.status, 0, `an identical retry must start from the still-empty target:\n${retry.stdout}\n${retry.stderr}`);
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")));
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")), false);
  assert.equal(
    fs.readdirSync(sandbox.root).some((entry) => /^\.aios\.dotaios-setup-[^.]+\.tmp$/.test(entry)),
    false,
    "the retry must remove its verified pre-publication staging inode"
  );
});

test("a live setup staging marker cannot be mistaken for an interrupted run", async () => {
  const sandbox = makeSandbox("setup-live-overlap");
  const barrier = path.join(sandbox.root, "setup-barrier");
  const first = startSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_PAUSE_SETUP_BEFORE_MARKER_LINK: barrier
  });
  await waitForFile(`${barrier}.ready`);

  const overlapping = runSetup(sandbox, ["--yes"]);
  const treeBeforeRelease = listTree(sandbox.aiosPath);
  fs.writeFileSync(`${barrier}.release`, "release\n");
  const completed = await first.completed;

  assert.notEqual(overlapping.status, 0);
  assert.match(overlapping.stderr, /another setup is already running/i);
  assert.deepEqual(treeBeforeRelease, [], "the overlapping run must not start scaffolding");
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")));
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")), false);
});

test("an old setup marker is never reclaimed while its owner PID is live", () => {
  const sandbox = makeSandbox("setup-owner-pid-reuse");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT: "1"
  });
  assert.equal(first.signal, "SIGKILL");

  const markerPath = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  marker.owner.pid = process.pid;
  delete marker.owner.process_started_at;
  marker.owner.created_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  const retry = runSetup(sandbox, ["--yes"]);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /another setup is already running/i);
  assert.equal(fs.existsSync(markerPath), true);
});

test("a setup marker is recoverable after its dead PID is reused", (t) => {
  const sandbox = makeSandbox("setup-owner-pid-reuse");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT: "1"
  });
  assert.equal(first.signal, "SIGKILL");

  const markerPath = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(typeof marker.owner.process_started_at, "string");
  marker.owner.pid = process.pid;
  marker.owner.created_at = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  const retry = runSetup(sandbox, ["--yes"]);
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.equal(fs.existsSync(markerPath), false);
});

test("setup recovers a crash between linking and unlinking its private marker", () => {
  const sandbox = makeSandbox("setup-marker-link-interrupt");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_MARKER_LINK: "1"
  });
  assert.equal(first.signal, "SIGKILL");

  const marker = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  const temporary = fs.readdirSync(sandbox.root)
    .find((entry) => /^\.aios\.dotaios-setup-[^.]+\.tmp$/.test(entry));
  assert.ok(temporary, "the crash window must leave the temporary hard link");
  const markerStats = fs.statSync(marker);
  const temporaryPath = path.join(sandbox.root, temporary);
  const temporaryStats = fs.statSync(temporaryPath);
  assert.equal(markerStats.ino, temporaryStats.ino, "both names must identify the same complete marker inode");
  if (process.platform !== "win32") {
    assert.equal(markerStats.mode & 0o777, 0o600);
    assert.equal(temporaryStats.mode & 0o777, 0o600);
  }
  const foreignTemporaryPath = path.join(
    sandbox.root,
    ".aios.dotaios-setup-00000000-0000-4000-8000-000000000000.tmp"
  );
  fs.writeFileSync(foreignTemporaryPath, "foreign sibling bytes\n");

  const retry = runSetup(sandbox, ["--yes"]);
  assert.equal(retry.status, 0, `same-inode marker recovery must finish:\n${retry.stdout}\n${retry.stderr}`);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(temporaryPath), false);
  assert.equal(
    fs.readFileSync(foreignTemporaryPath, "utf8"),
    "foreign sibling bytes\n",
    "cleanup must not unlink a lookalike sibling with a different inode"
  );
});

test("the identical setup command recovers a hard interruption after activation persists skills-first", () => {
  const sandbox = makeSandbox("setup-activation-config-interrupt");
  const first = runSetup(sandbox, ["--yes", "--skills-first"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_ACTIVATION_CONFIG: "1"
  });

  assert.equal(first.signal, "SIGKILL", `expected interruption after the activation config write:\n${first.stdout}\n${first.stderr}`);
  const interruptedConfig = JSON.parse(fs.readFileSync(path.join(sandbox.aiosPath, "aios.json"), "utf8"));
  assert.equal(interruptedConfig.skills_first, true, "activation must persist the preference before interruption");
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")));

  const retry = runSetup(sandbox, ["--yes", "--skills-first"]);

  assert.equal(retry.status, 0, `the identical retry must accept only activation's expected config transition:\n${retry.stdout}\n${retry.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox.aiosPath, "aios.json"), "utf8")).skills_first, true);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")), false);
  assert.match(`${retry.stdout}${retry.stderr}`, /unfinished folder/i);
});

test("an arbitrary aios.json edit after interruption blocks recovery without changing its bytes", () => {
  const sandbox = makeSandbox("setup-config-tamper");
  const first = runSetup(sandbox, ["--yes", "--skills-first"], {
    DOTAIOS_TEST_INTERRUPT_SETUP_AFTER_INIT: "1"
  });
  assert.equal(first.signal, "SIGKILL");

  const configPath = path.join(sandbox.aiosPath, "aios.json");
  const tampered = `${JSON.stringify({
    ...JSON.parse(fs.readFileSync(configPath, "utf8")),
    private_note: "do not claim this as setup output"
  }, null, 2)}\n`;
  fs.writeFileSync(configPath, tampered);

  const retry = runSetup(sandbox, ["--yes", "--skills-first"]);

  assert.notEqual(retry.status, 0, "only the exact activation transition may pass manifest validation");
  assert.match(retry.stderr, /already exists and is not empty/);
  assert.equal(fs.readFileSync(configPath, "utf8"), tampered);
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")));
});

test("setup publishes its recovery marker without clobbering a raced destination", () => {
  const sandbox = makeSandbox("setup-marker-race");
  const result = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_RACE_SETUP_MARKER: "1"
  });
  const marker = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Target changed while setup was preparing it/);
  assert.equal(fs.readFileSync(marker, "utf8"), "foreign marker bytes\n", "exclusive publication must not replace the raced file");
  assert.deepEqual(listTree(sandbox.aiosPath), [
    ".dotaios-setup-transaction.json",
    "memory/metrics/reliability.jsonl"
  ]);
  const rows = fs.readFileSync(
    path.join(sandbox.aiosPath, "memory", "metrics", "reliability.jsonl"),
    "utf8"
  ).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.findLast((row) => row.type === "setup_phase_end")?.outcome, "fail");
  assert.equal(rows.findLast((row) => row.type === "install_end")?.outcome, "fail");
});

test("foreign content injected after an interrupted base-tree write blocks recovery without overwrite", () => {
  const sandbox = makeSandbox("setup-transaction-foreign");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE: "1"
  });
  assert.notEqual(first.status, 0);

  const foreignFile = path.join(sandbox.aiosPath, "projects", "private-client-notes.md");
  fs.writeFileSync(foreignFile, "keep this private\n");

  const retry = runSetup(sandbox, ["--yes"]);

  assert.notEqual(retry.status, 0, "an extra path that setup did not generate must fail closed");
  assert.match(retry.stderr, /already exists and is not empty/);
  assert.equal(fs.readFileSync(foreignFile, "utf8"), "keep this private\n");
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.ok(fs.existsSync(path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json")));
});

test("a malformed setup recovery marker blocks recovery without touching scaffold residue", () => {
  const sandbox = makeSandbox("setup-transaction-malformed");
  const first = runSetup(sandbox, ["--yes"], {
    DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE: "1"
  });
  assert.notEqual(first.status, 0);

  const marker = path.join(sandbox.aiosPath, ".dotaios-setup-transaction.json");
  fs.writeFileSync(marker, "{not valid json}\n");
  const before = listTree(sandbox.aiosPath);

  const retry = runSetup(sandbox, ["--yes"]);

  assert.notEqual(retry.status, 0, "malformed ownership evidence must fail closed");
  assert.match(retry.stderr, /already exists and is not empty/);
  assert.deepEqual(listTree(sandbox.aiosPath), before);
  assert.equal(fs.readFileSync(marker, "utf8"), "{not valid json}\n");
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
});

test("setup refuses malformed failed-run residue", () => {
  const sandbox = makeSandbox("setup-malformed-residue");
  const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl");
  fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
  fs.writeFileSync(metricsFile, "{not valid json}\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "malformed metrics do not prove this is safe setup residue");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.match(fs.readFileSync(metricsFile, "utf8"), /^\{not valid json\}\n/);
});

test("setup refuses failed-run metrics mixed with an unknown JSON row", () => {
  const sandbox = makeSandbox("setup-foreign-metric");
  const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "pilot.jsonl");
  fs.mkdirSync(path.dirname(metricsFile), { recursive: true });
  fs.writeFileSync(metricsFile, [
    JSON.stringify({ type: "setup_phase_end", phase: "init", outcome: "fail" }),
    JSON.stringify({ type: "private_note", text: "not setup residue" })
  ].join("\n") + "\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "an unknown JSON row must make recovery fail closed");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.match(fs.readFileSync(metricsFile, "utf8"), /"type":"private_note"/);
});

test("setup transaction recovery rejects reordered, cross-run, or widened metric rows", () => {
  for (const [label, mutate] of [
    ["reordered", (rows) => [rows[1], rows[0], ...rows.slice(2)]],
    ["cross-run", (rows) => rows.map((row, index) => index === 1 ? { ...row, run_id: "00000000-0000-4000-8000-000000000000" } : row)],
    ["widened", (rows) => rows.map((row, index) => index === 0 ? { ...row, private_note: "not setup state" } : row)]
  ]) {
    const sandbox = makeSandbox(`setup-metric-${label}`);
    const first = runSetup(sandbox, ["--yes"], {
      DOTAIOS_TEST_FAIL_SETUP_AFTER_CREATE_BASE_TREE: "1"
    });
    assert.notEqual(first.status, 0);
    const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "reliability.jsonl");
    const rows = fs.readFileSync(metricsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    fs.writeFileSync(metricsFile, `${mutate(rows).map((row) => JSON.stringify(row)).join("\n")}\n`);

    const retry = runSetup(sandbox, ["--yes"]);
    assert.notEqual(retry.status, 0, `${label} metrics must not prove setup ownership`);
    assert.match(retry.stderr, /already exists and is not empty/);
    assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  }
});

test("setup refuses failed-run residue when any extra file is present", () => {
  const sandbox = makeSandbox("setup-extra-residue");
  const metricsDir = path.join(sandbox.aiosPath, "memory", "metrics");
  const metricsFile = path.join(metricsDir, "pilot.jsonl");
  const extraFile = path.join(metricsDir, "private-notes.md");
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.writeFileSync(
    metricsFile,
    `${JSON.stringify({ type: "setup_phase_end", phase: "init", outcome: "fail" })}\n`
  );
  fs.writeFileSync(extraFile, "keep me\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "only the exact 1.27.1 residue shape may be recovered");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.equal(fs.readFileSync(extraFile, "utf8"), "keep me\n");
});

test("setup over a complete AIOS folder changes nothing and says so", () => {
  // The guarantee here is that a second run never forces anything through. It
  // used to be expressed as a non-zero exit plus "already exists and is not
  // empty", which told someone with a perfectly healthy install that setup had
  // failed, and offered --force beside --overwrite with nothing marking the
  // second as destructive. Re-running an installer is not an error. The
  // guarantee is now asserted directly — the folder is byte-for-byte
  // untouched — which is stronger than asserting an exit code.
  const sandbox = makeSandbox("setup-healthy");
  const first = runSetup(sandbox, ["--yes"]);
  assert.equal(first.status, 0, `first setup should succeed:\n${first.stdout}\n${first.stderr}`);

  const identity = path.join(sandbox.aiosPath, "context", "identity.md");
  fs.appendFileSync(identity, "\nI am a consultant in Milan.\n");
  const before = fs.readFileSync(identity, "utf8");
  const listedBefore = fs.readdirSync(sandbox.aiosPath).sort();

  const second = runSetup(sandbox, ["--yes"]);

  assert.equal(second.status, 0, "a healthy re-run is not a failure");
  assert.match(second.stdout, /already set up/i);
  assert.doesNotMatch(`${second.stdout}${second.stderr}`, /could not complete/i);
  assert.doesNotMatch(`${second.stdout}${second.stderr}`, /unfinished folder/i);
  assert.equal(fs.readFileSync(identity, "utf8"), before, "nothing the user wrote was touched");
  assert.deepEqual(fs.readdirSync(sandbox.aiosPath).sort(), listedBefore, "no files added or removed");
});

test("setup refuses to auto-force a folder holding foreign content", () => {
  const sandbox = makeSandbox("setup-foreign");
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });
  fs.writeFileSync(path.join(sandbox.aiosPath, "tax-return-2025.pdf"), "not ours\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "a folder with the user's own files must fail closed");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
});

test("setup refuses foreign content nested under a generated folder name", () => {
  const sandbox = makeSandbox("setup-nested-foreign");
  const foreignFile = path.join(sandbox.aiosPath, "projects", "client-work", "private-notes.md");
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(foreignFile, "private client notes\n");

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0, "foreign nested content must fail closed");
  assert.match(result.stderr, /already exists and is not empty/);
  assert.equal(fs.existsSync(path.join(sandbox.aiosPath, "aios.json")), false);
  assert.equal(fs.readFileSync(foreignFile, "utf8"), "private client notes\n");
});

test("a folder needing migration surfaces the migration error, not the retry", () => {
  const sandbox = makeSandbox("setup-migration");
  // init refuses --force on a folder whose schema needs a versioned migration
  // (init.mjs), so the auto-force retry must never be attempted here.
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });
  fs.writeFileSync(
    path.join(sandbox.aiosPath, "aios.json"),
    `${JSON.stringify({ schema_version: "1.0.0", ai_tools: [] }, null, 2)}\n`
  );

  const result = runSetup(sandbox, ["--yes"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs a versioned migration/);
  assert.doesNotMatch(
    result.stderr,
    /already exists and is not empty/,
    "the migration refusal is the real answer and must not be replaced by a collision message"
  );
});

test("the local metrics writer still creates its metrics directory", async () => {
  // appendMetric has callers that legitimately depend on the mkdir. Making
  // setup's failure path non-creating must not take that away from them.
  const sandbox = makeSandbox("setup-metrics-caller");
  fs.mkdirSync(sandbox.aiosPath, { recursive: true });

  const metricsFile = path.join(sandbox.aiosPath, "memory", "metrics", "reliability.jsonl");
  await appendMetric(metricsFile, { type: "setup_probe", outcome: "ok" });
  assert.ok(fs.existsSync(metricsFile), "metrics writers must create memory/metrics/ on their own");
  assert.match(fs.readFileSync(metricsFile, "utf8"), /"type":"setup_probe"/);
});
