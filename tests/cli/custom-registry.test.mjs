import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function runCli(args, { allowNonZero = false, env = process.env } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  if (!allowNonZero) {
    assert.equal(result.status, 0, `dotaios ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

test("activation resolves native skill targets from a project-owned registry", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-custom-registry-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");

  runCli(["init", "--path", aiosPath, "--yes"]);
  fs.writeFileSync(
    path.join(aiosPath, "agents.json"),
    JSON.stringify({
      agents: [
        {
          name: "Custom Runner",
          detect: ".custom-runner",
          bridge: null,
          skills: { mode: "symlink", dir: ".custom/skills" }
        },
        {
          name: "Custom Hermes",
          detect: ".custom-hermes",
          bridge: null,
          skills: {
            mode: "config-external-dir",
            configFile: ".custom-hermes/config.yaml",
            key: "runner.skill_paths"
          }
        }
      ]
    })
  );
  fs.mkdirSync(path.join(homePath, ".custom-hermes"), { recursive: true });
  fs.writeFileSync(
    path.join(homePath, ".custom-hermes", "config.yaml"),
    "runner:\n  skill_paths: []\n"
  );

  runCli(["activate", "--path", aiosPath, "--home", homePath, "--all"]);

  const link = path.join(homePath, ".custom", "skills", "audit");
  assert.equal(fs.readlinkSync(link), path.join(aiosPath, "skills", "audit"));
  const config = fs.readFileSync(path.join(homePath, ".custom-hermes", "config.yaml"), "utf8");
  assert.match(config, new RegExp(`- ${aiosPath.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}/skills`));
  assert.match(config, /runner:\n  skill_paths:/);
  assert.doesNotMatch(config, /^skills:/m);

  const doctor = runCli(
    ["skills", "doctor", "--json", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  const report = JSON.parse(doctor.stdout);
  const customConfig = report.hermes.configs.find((entry) => entry.path.endsWith(".custom-hermes/config.yaml"));
  assert.equal(customConfig.key, "runner.skill_paths");
  assert.equal(customConfig.status, "healthy");

  fs.writeFileSync(
    path.join(homePath, ".custom-hermes", "config.yaml"),
    `skills:\n  external_dirs:\n    - ${path.join(aiosPath, "skills")}\nrunner:\n  skill_paths: []\n`
  );
  const mismatchedDoctor = runCli(
    ["skills", "doctor", "--json", "--path", aiosPath, "--home", homePath],
    { allowNonZero: true }
  );
  const mismatchedReport = JSON.parse(mismatchedDoctor.stdout);
  const customRuntime = mismatchedReport.runtimes.find((entry) => entry.name === "Custom Hermes");
  assert.equal(customRuntime.capabilities.configured, "no");
  assert.equal(customRuntime.capabilities.projected, "no");
  assert.equal(customRuntime.capabilities.discoverable, "not-probed");
  assert.deepEqual(customRuntime.evidence.hermesConfigs.map((entry) => entry.key), ["runner.skill_paths"]);
});

test("activation projects a custom target only after its client is detected", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-custom-detected-"));
  const aiosPath = path.join(tempRoot, "aios");
  const homePath = path.join(tempRoot, "home");

  try {
    runCli(["init", "--path", aiosPath, "--yes"]);
    fs.writeFileSync(
      path.join(aiosPath, "agents.json"),
      `${JSON.stringify({
        agents: [{
          name: "Custom Runner",
          detect: ".custom-runner",
          bridge: null,
          skills: { mode: "symlink", dir: ".custom\\skills" }
        }]
      }, null, 2)}\n`
    );
    fs.mkdirSync(path.join(homePath, ".custom-runner"), { recursive: true });

    const preview = runCli(
      ["setup", "--dry-run", "--verbose", "--path", aiosPath, "--home", homePath],
      { env: { ...process.env, PATH: "" } }
    );
    assert.match(
      preview.stdout,
      new RegExp(`\\[would create managed skill links\\] ${path.join(homePath, ".custom", "skills")}`)
    );
    assert.doesNotMatch(preview.stdout, /would create managed skill links.*\.claude\/skills/);
    assert.doesNotMatch(preview.stdout, /would create managed skill links.*\.gemini\/config\/skills/);
    assert.doesNotMatch(preview.stdout, /would create managed skill links.*\.grok\/skills/);

    runCli(
      ["activate", "--path", aiosPath, "--home", homePath],
      { env: { ...process.env, PATH: "" } }
    );

    const link = path.join(homePath, ".custom", "skills", "audit");
    assert.equal(fs.readlinkSync(link), path.join(aiosPath, "skills", "audit"));
    assert.equal(fs.existsSync(path.join(homePath, ".claude", "skills")), false);
    assert.equal(fs.existsSync(path.join(homePath, ".gemini", "config", "skills")), false);
    assert.equal(fs.existsSync(path.join(homePath, ".grok", "skills")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
