import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-smoke-"));
const aiosPath = path.join(tempRoot, "aios");
const vaultPath = path.join(tempRoot, "vault");
const homePath = path.join(tempRoot, "home");
const projectPath = path.join(tempRoot, "project");
const importPath = path.join(tempRoot, "import.json");

run(["--help"]);
run(["init", "--path", aiosPath, "--vault-path", vaultPath, "--yes"]);
run(["status", "--path", aiosPath]);
run(["context", "--path", aiosPath]);
run(["context", "identity", "--path", aiosPath]);
run(["context", "--refresh", "--path", aiosPath]);
fs.mkdirSync(projectPath, { recursive: true });
run(["activate", "--path", aiosPath, "--home", homePath, "--project", projectPath, "--all"]);
fs.writeFileSync(importPath, JSON.stringify({
  context: { work: "Imported smoke context." },
  events: [{ type: "smoke-import", summary: "Smoke import verified." }]
}, null, 2));
run(["import", importPath, "--path", aiosPath]);
run(["import", importPath, "--path", aiosPath, "--apply"]);
run(["schedule", "list", "--path", aiosPath]);
run(["ingest", "--help"]);
run(["ingest", path.join(repoRoot, "README.md"), "--path", aiosPath]);
const binaryFixture = path.join(tempRoot, "sample.bin");
fs.writeFileSync(binaryFixture, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
run(["ingest", binaryFixture, "--path", aiosPath, "--dry-run"]);
run(["ingest", binaryFixture, "--path", aiosPath]);
run(["install", path.join(repoRoot, "examples", "plugins", "hello-memory"), "--path", aiosPath, "--home", homePath]);
run(["install", path.join(repoRoot, "examples", "plugins", "hello-memory"), "--dry-run"]);
run(["search", "smoke", "--path", aiosPath]);
run(["search", "cloud-safe", "--scope", "skills", "--path", aiosPath]);
run(["index", "--path", aiosPath]);
run(["index", "--path", aiosPath, "--dry-run"]);
run(["mcp", "status", "--path", aiosPath]);
run(["mcp", "install", "--path", aiosPath, "--dry-run", "--agent", "claude"]);
run(["schedule", "doctor", "--path", aiosPath]);
run(["schedule", "install", "--dry-run", "--target", "cron", "--path", aiosPath]);
run(["reveal", "--path", aiosPath, "--dry-run"]);
run(["cleanup", "--path", aiosPath, "--dry-run"]);
run(["doctor", "--path", aiosPath, "--home", homePath]);
run(["skill", "list", "--path", aiosPath]);

const liveRegistryUrl = `file://${path.join(repoRoot, "website", "public", "registry.json")}`;
run(["market", "list"], { ...process.env, DOTAIOS_REGISTRY_URL: liveRegistryUrl });

const fixtureRegistryUrl = `file://${path.join(repoRoot, "tests", "fixtures", "registry-sample.json")}`;
const marketEnv = { ...process.env, DOTAIOS_REGISTRY_URL: fixtureRegistryUrl };
run(["market", "list"], marketEnv);
run(["market", "info", "hello-memory"], marketEnv);

const licenseDir = path.join(tempRoot, "licenses");
const licenseEnv = { ...process.env, DOTAIOS_LICENSE_DIR: licenseDir };
run(["license", "list"], licenseEnv);

const paidPluginRoot = path.join(tempRoot, "paid-plugin");
fs.mkdirSync(paidPluginRoot, { recursive: true });
fs.writeFileSync(path.join(paidPluginRoot, "manifest.json"), JSON.stringify({
  name: "paid-pack",
  version: "0.1.0",
  description: "Smoke fixture for paid manifest rejection.",
  license: "Proprietary",
  aios_version: ">=1.9.0",
  requires: { connections: [], context: [] },
  provides: { skills: ["paid-pack"], memory_writers: [], scheduled_tasks: [] },
  permissions: { read: [], write: [], write_with_approval: [], connections: [] },
  paid: true,
  vendor: "filocosta",
  product_id: "paid-pack"
}, null, 2));
const paidAttempt = spawnSync(process.execPath, [cli, "install", paidPluginRoot, "--path", aiosPath], {
  cwd: repoRoot,
  encoding: "utf8",
  env: licenseEnv
});
if (paidAttempt.status === 0) {
  console.error("Expected install to fail on missing license, but it succeeded.");
  process.exit(1);
}
if (!/license/i.test(`${paidAttempt.stdout}${paidAttempt.stderr}`)) {
  console.error("Expected license-missing error, got something else.");
  console.error(paidAttempt.stderr);
  process.exit(1);
}

const setupPath = path.join(tempRoot, "setup-aios");
const setupVault = path.join(tempRoot, "setup-vault");
const setupHome = path.join(tempRoot, "setup-home");
run(["setup", "--path", setupPath, "--vault-path", setupVault, "--home", setupHome, "--yes", "--skip-reveal"]);

console.log(`Smoke test passed: ${tempRoot}`);

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
}
