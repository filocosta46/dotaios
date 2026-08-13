import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createProjectSourceRetrievalFixture
} from "../fixtures/project-source-retrieval.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

test("CLI search leaves corrupt JSONL byte- and metadata-unchanged", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-search-safety-"));
  const aiosPath = path.join(tempRoot, "aios");
  run(["init", "--path", aiosPath, "--yes"]);

  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    `{not-json}\n${JSON.stringify({
      ts: "2026-08-10T10:00:00.000Z",
      type: "note",
      summary: "CLI_CORRUPT_SEARCH_CANARY"
    })}\n`
  );
  const before = snapshotTree(aiosPath);

  const result = run([
    "search",
    "CLI_CORRUPT_SEARCH_CANARY",
    "--scope",
    "memory",
    "--path",
    aiosPath
  ]);

  assert.match(result.stdout, /CLI_CORRUPT_SEARCH_CANARY/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, escaped(aiosPath));
  assert.equal(fs.existsSync(`${eventsPath}.bad.jsonl`), false);
  assert.deepEqual(snapshotTree(aiosPath), before);
});

test("CLI search refuses a linked aios.json before authorizing an external vault", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-search-config-"));
  const aiosPath = path.join(tempRoot, "aios");
  const outside = path.join(tempRoot, "outside");
  const outsideConfig = path.join(tempRoot, "outside-config.json");
  run(["init", "--path", aiosPath, "--yes"]);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "# Outside\n\nOUTSIDE_VAULT_CANARY\n");
  fs.writeFileSync(outsideConfig, `${JSON.stringify({ vault_path: outside })}\n`);
  fs.unlinkSync(path.join(aiosPath, "aios.json"));
  fs.symlinkSync(outsideConfig, path.join(aiosPath, "aios.json"));

  const before = snapshotTree(tempRoot);
  const result = spawnSync(process.execPath, [
    cli,
    "search",
    "OUTSIDE_VAULT_CANARY",
    "--scope",
    "vault",
    "--path",
    aiosPath
  ], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /OUTSIDE_VAULT_CANARY/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, escaped(outside));
  assert.deepEqual(snapshotTree(tempRoot), before);
});

test("CLI search qualifies result counts and no-results on stdout when a scope is omitted", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-search-partial-"));
  const aiosPath = path.join(tempRoot, "aios");
  const vaultPath = path.join(tempRoot, "external-vault");
  try {
    const initialized = run(["init", "--path", aiosPath, "--yes"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    fs.mkdirSync(vaultPath);
    fs.writeFileSync(path.join(aiosPath, "context", "work.md"), "# Work\n\nCLI_PARTIAL_SEARCH_CANARY\n");
    fs.writeFileSync(path.join(vaultPath, "oversized.md"), Buffer.alloc((4 * 1024 * 1024) + 1, 0x61));
    const configPath = path.join(aiosPath, "aios.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, `${JSON.stringify({ ...config, vault_path: vaultPath }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli,
      "search",
      "CLI_PARTIAL_SEARCH_CANARY",
      "--scope",
      "all",
      "--path",
      aiosPath
    ], { cwd: repoRoot, encoding: "utf8" });
    const empty = spawnSync(process.execPath, [
      cli,
      "search",
      "CLI_PARTIAL_NO_MATCH",
      "--scope",
      "all",
      "--path",
      aiosPath
    ], { cwd: repoRoot, encoding: "utf8" });

    assert.equal(result.status, 2);
    assert.equal(empty.status, 2);
    assert.match(result.stdout, /CLI_PARTIAL_SEARCH_CANARY/);
    assert.match(result.stdout, /(?:partial|incomplete).*vault|vault.*(?:partial|incomplete)/i);
    assert.match(empty.stdout, /no results.*(?:partial|incomplete).*vault|(?:partial|incomplete).*vault.*no results/is);
    assert.doesNotMatch(result.stderr, /CLI_PARTIAL_SEARCH_CANARY/);
    assert.match(result.stderr, /incomplete.*vault.*oversized file/is);
    assert.match(empty.stderr, /incomplete.*vault.*oversized file/is);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${empty.stdout}\n${empty.stderr}`, escaped(tempRoot));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI update appears once in search while two intentional saves remain two", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-update-search-"));
  const aiosPath = path.join(tempRoot, "aios");
  const note = "CLI_UPDATE_IDENTITY_CANARY";
  try {
    run(["init", "--path", aiosPath, "--yes"]);

    run(["update", note, "--path", aiosPath]);
    const once = run(["search", note, "--scope", "memory", "--path", aiosPath]);
    assert.match(once.stdout, /1 result\(s\) found\./);

    run(["update", note, "--path", aiosPath]);
    const twice = run(["search", note, "--scope", "memory", "--path", aiosPath]);
    assert.match(twice.stdout, /2 result\(s\) found\./);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI search matches either representation before collapsing an update pair", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-cli-update-pair-fields-"));
  const aiosPath = path.join(tempRoot, "aios");
  const note = "IDENTITY_QUERY_CANARY";
  try {
    run(["init", "--path", aiosPath, "--yes"]);
    run(["update", note, "--path", aiosPath]);

    const signalPath = path.join(
      aiosPath,
      "memory",
      "signals",
      fs.readdirSync(path.join(aiosPath, "memory", "signals")).find((name) => name.endsWith(".jsonl"))
    );
    const signal = JSON.parse(fs.readFileSync(signalPath, "utf8").trim());
    const event = JSON.parse(fs.readFileSync(path.join(aiosPath, "memory", "events.jsonl"), "utf8").trim());
    assert.equal(signal.record_id, event.record_id, "the fixture must be one paired update operation");
    signal.ts = "2040-01-02T03:04:05.678Z";
    assert.notEqual(signal.ts, event.ts);
    fs.writeFileSync(signalPath, `${JSON.stringify(signal)}\n`);

    const result = run(["search", signal.ts, "--scope", "memory", "--path", aiosPath]);
    assert.match(result.stdout, /1 result\(s\) found\./);
    assert.match(result.stdout, /2040-01-02T03:04:05\.678Z/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("CLI project search keeps corpus selection separate from session attribution", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const bySlug = run([
      "search", "Launch work",
      "--scope", "all",
      "--project", "acme-campaign",
      "--session-project", "unrelated-session-tag",
      "--path", fixture.aiosPath
    ]);
    const byId = run([
      "search", "Launch work",
      "--scope", "all",
      "--project", "project-acme-001",
      "--session-project", "unrelated-session-tag",
      "--path", fixture.aiosPath
    ]);

    assert.match(bySlug.stdout, /Acme Campaign|Launch work/);
    assert.match(byId.stdout, /Acme Campaign|Launch work/);
    assert.doesNotMatch(`${bySlug.stdout}\n${byId.stdout}`, /OTHER_CLIENT_PRIVATE_CANARY|other-client/);
  } finally {
    fixture.cleanup();
  }
});

test("CLI project search preserves the exact raw project selector", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const exact = run([
      "search", "Launch work",
      "--scope", "projects",
      "--project", "acme-campaign",
      "--path", fixture.aiosPath,
    ]);
    assert.match(exact.stdout, /Acme Campaign|Launch work/);

    const padded = spawnSync(process.execPath, [
      cli,
      "search",
      "Launch work",
      "--scope",
      "projects",
      "--project",
      " acme-campaign ",
      "--path",
      fixture.aiosPath,
    ], { cwd: repoRoot, encoding: "utf8" });

    assert.equal(padded.status, 1);
    assert.match(padded.stderr, /safe project slug or stable id/);
    assert.doesNotMatch(`${padded.stdout}\n${padded.stderr}`, /OTHER_CLIENT_PRIVATE_CANARY|Launch work/);
    assert.doesNotMatch(`${padded.stdout}\n${padded.stderr}`, escaped(fixture.aiosPath));
  } finally {
    fixture.cleanup();
  }
});

test("CLI project search refuses a selector shared by a slug and another stable id", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const neighborReadme = path.join(fixture.aiosPath, "projects", "other-client", "README.md");
    fs.writeFileSync(
      neighborReadme,
      fs.readFileSync(neighborReadme, "utf8").replace("id: project-other-002", "id: acme-campaign"),
    );

    const result = spawnSync(process.execPath, [
      cli,
      "search",
      "Launch work",
      "--scope",
      "projects",
      "--project",
      "acme-campaign",
      "--path",
      fixture.aiosPath,
    ], { cwd: repoRoot, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /project selector is ambiguous/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /OTHER_CLIENT_PRIVATE_CANARY/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, escaped(fixture.aiosPath));
  } finally {
    fixture.cleanup();
  }
});

test("CLI project search refuses a selected catalog identity outside the selector contract", () => {
  const fixture = createProjectSourceRetrievalFixture();
  try {
    const selectedReadme = path.join(fixture.aiosPath, "projects", "acme-campaign", "README.md");
    fs.writeFileSync(
      selectedReadme,
      `${fs.readFileSync(selectedReadme, "utf8")
        .replace("id: project-acme-001", "id: \" project-acme-001 \"")}\nINVALID_ID_PRIVATE_CANARY\n`,
    );

    const result = spawnSync(process.execPath, [
      cli,
      "search",
      "Launch work",
      "--scope",
      "projects",
      "--project",
      "acme-campaign",
      "--path",
      fixture.aiosPath,
    ], { cwd: repoRoot, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid stable id/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /INVALID_ID_PRIVATE_CANARY/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, escaped(fixture.aiosPath));
  } finally {
    fixture.cleanup();
  }
});

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function snapshotTree(root) {
  const snapshot = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name);
    const stats = fs.lstatSync(absolute);
    snapshot.push([entry.name, entry.isDirectory() ? "directory" : "file", stats.mtimeMs]);
    if (entry.isDirectory()) {
      for (const nested of snapshotTree(absolute)) {
        snapshot.push([path.posix.join(entry.name, nested[0]), ...nested.slice(1)]);
      }
    } else if (entry.isFile()) {
      snapshot.at(-1).push(fs.readFileSync(absolute).toString("base64"));
    } else if (entry.isSymbolicLink()) {
      snapshot.at(-1).push(fs.readlinkSync(absolute));
    }
  }
  return snapshot;
}

function escaped(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
