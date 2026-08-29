import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bridgeManagedBlock,
  bundledCliInvocation,
  exactCliInvocation,
  resolveCliInvocation
} from "../../packages/core/src/bridges.mjs";
import {
  isRecognizedOfficialSkillOverlay,
  materializeOfficialCandidateBytes
} from "../../packages/core/src/official-skills.mjs";
import { mergeOpenCodeSettings } from "../../packages/cli/src/commands/connect.mjs";
import { checkCliReachable } from "../../packages/cli/src/commands/doctor.mjs";
import { mcpClientConfig, supportedMcpAgents } from "../../packages/cli/src/commands/mcp.mjs";
import {
  DOTAIOS_PACKAGE_VERSION,
  mcpLauncher
} from "../../packages/cli/src/lib/mcp-launcher.mjs";
import {
  applyManagedScheduleRepair,
  planManagedScheduleRepair
} from "../../packages/cli/src/commands/schedule.mjs";
import { previewUpgrade } from "../../packages/cli/src/commands/upgrade.mjs";
import { renderGeneratedPrompt } from "../helpers/official-skills-fixture.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = path.join(repoRoot, "packages", "cli", "src", "index.mjs");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const posixInvocation = `npx dotaios@${version}`;
const windowsInvocation = `npx.cmd dotaios@${version}`;

function makeAios(root, schemaVersion = "1.2.0") {
  const aiosPath = path.join(root, "aios");
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), `${JSON.stringify({
    schema_version: schemaVersion,
    skills_first: false
  }, null, 2)}\n`);
  return aiosPath;
}

test("the exact invocation owner emits only the native pinned executable", async () => {
  assert.equal(exactCliInvocation(version, { platform: "linux" }), posixInvocation);
  assert.equal(exactCliInvocation(version, { platform: "darwin" }), posixInvocation);
  assert.equal(exactCliInvocation(version, { platform: "win32" }), windowsInvocation);
  assert.equal(bundledCliInvocation({ platform: "win32" }), windowsInvocation);
  assert.equal(
    await resolveCliInvocation({ version, platform: "win32" }),
    windowsInvocation
  );

  await assert.rejects(resolveCliInvocation({ version: "latest", platform: "win32" }), /package version/i);
  assert.throws(() => exactCliInvocation(null, { platform: "win32" }), /package version/i);
});

test("managed bridges accept both owned launchers and emit the supplied native form", async () => {
  const windows = await bridgeManagedBlock("C:\\Users\\test\\aios", { cli: windowsInvocation });
  const legacy = await bridgeManagedBlock("C:\\Users\\test\\aios", { cli: posixInvocation });

  assert.match(windows, new RegExp(windowsInvocation.replaceAll(".", "\\.")));
  assert.match(legacy, new RegExp(posixInvocation.replaceAll(".", "\\.")));
  await assert.rejects(
    bridgeManagedBlock("C:\\Users\\test\\aios", { cli: "npx.cmd dotaios@latest" }),
    /exact candidate/i
  );
});

test("Windows upgrade recovery returns one executable PowerShell handoff", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-windows-upgrade-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiosPath = makeAios(root, "1.1.0");

  const preview = await previewUpgrade({
    aiosPath,
    homePath: path.join(root, "home"),
    candidateVersion: version,
    platform: "win32"
  });

  assert.equal(preview.status, "recovery-required");
  assert.equal(preview.guidance_shell, "PowerShell");
  assert.equal(preview.candidate_invocation, windowsInvocation);
  assert.match(preview.guidance.join("\n"), new RegExp(`^${windowsInvocation.replaceAll(".", "\\.")} migrate`));
  assert.doesNotMatch(preview.guidance.join("\n"), /^npx\s/m);
});

test("the public upgrade apply handoff uses the host-native executable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-native-upgrade-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const homePath = path.join(root, "home");
  fs.mkdirSync(homePath, { recursive: true });
  const env = { ...process.env, HOME: homePath, USERPROFILE: homePath };
  delete env.CLAUDE_CONFIG_DIR;

  const initialized = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--path", aiosPath],
    { cwd: repoRoot, encoding: "utf8", env }
  );
  assert.equal(initialized.status, 0, initialized.stderr);

  const preview = spawnSync(
    process.execPath,
    [cli, "upgrade", "--dry-run", "--path", aiosPath],
    { cwd: repoRoot, encoding: "utf8", env }
  );
  const nativeInvocation = process.platform === "win32" ? windowsInvocation : posixInvocation;
  const nativeShell = process.platform === "win32" ? "PowerShell" : "POSIX shell";

  assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
  assert.match(preview.stdout, new RegExp(`Apply exactly this preview in ${nativeShell}:`));
  assert.match(
    preview.stdout,
    new RegExp(`^${nativeInvocation.replaceAll(".", "\\.")} upgrade --apply`, "m")
  );
});

test("every structured MCP client uses npx.cmd on Windows and npx on POSIX", () => {
  const aiosPath = path.resolve("/tmp/dotaios-runtime-handoff/aios");
  const homePath = path.resolve("/tmp/dotaios-runtime-handoff/home");

  assert.equal(mcpLauncher(aiosPath, version, { platform: "win32" }).command, "npx.cmd");
  assert.equal(mcpLauncher(aiosPath, version, { platform: "linux" }).command, "npx");

  for (const agent of supportedMcpAgents) {
    const windows = mcpClientConfig(agent, aiosPath, homePath, { platform: "win32" }).text;
    const posix = mcpClientConfig(agent, aiosPath, homePath, { platform: "linux" }).text;
    assert.match(windows, /npx\.cmd/, `${agent} must receive the Windows executable`);
    assert.doesNotMatch(windows, /["']npx["']/, `${agent} must not receive bare npx on Windows`);
    assert.match(posix, /["']npx["']/, `${agent} must retain the POSIX executable`);
    assert.doesNotMatch(posix, /npx\.cmd/, `${agent} must not receive npx.cmd on POSIX`);
  }
});

test("OpenCode recognizes a legacy exact launcher before writing the native form", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-opencode-windows-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settingsPath = path.join(root, "opencode.json");
  const aiosPath = path.join(root, "aios");
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    mcp: {
      dotaios: {
        type: "local",
        command: [
          "npx",
          "--yes",
          "--package",
          `dotaios@${DOTAIOS_PACKAGE_VERSION}`,
          "dotaios-mcp",
          "--path",
          aiosPath
        ],
        enabled: true
      }
    }
  }, null, 2)}\n`);

  await mergeOpenCodeSettings(settingsPath, aiosPath, { platform: "win32" });
  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(written.mcp.dotaios.command[0], "npx.cmd");
});

test("managed schedules repair the wrong-platform current launcher", () => {
  const source = [
    "schedules:",
    "  - name: daily-brief",
    `    command: "${posixInvocation} brief"`,
    "    enabled: true",
    ""
  ].join("\n");

  const plan = planManagedScheduleRepair(source, { candidateVersion: version, platform: "win32" });
  assert.equal(plan.status, "ready");
  assert.equal(plan.changes[0].to, `${windowsInvocation} brief`);
  assert.match(applyManagedScheduleRepair(source, plan), new RegExp(windowsInvocation.replaceAll(".", "\\.")));
});

test("managed schedules recognize an npx.cmd predecessor on POSIX", () => {
  const source = [
    "schedules:",
    "  - name: daily-brief",
    "    command: \"npx.cmd dotaios@2.0.10 brief\"",
    "    enabled: true",
    ""
  ].join("\n");

  const plan = planManagedScheduleRepair(source, { candidateVersion: version, platform: "linux" });
  assert.equal(plan.status, "ready");
  assert.equal(plan.changes[0].to, `${posixInvocation} brief`);
});

test("schedule execution strips npx.cmd without spawning a PATH command", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-npx-cmd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiosPath = path.join(root, "aios");
  const initialized = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--path", aiosPath],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const fakeBin = path.join(root, "bin");
  const executionMarker = path.join(root, "path-launcher-executed");
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const executable of ["npx", "npx.cmd"]) {
    fs.writeFileSync(
      path.join(fakeBin, executable),
      `#!/bin/sh\nprintf executed > '${executionMarker}'\nexit 99\n`,
      { mode: 0o755 }
    );
  }
  fs.writeFileSync(path.join(aiosPath, "schedules.yml"), [
    "schedules:",
    "  - name: local-status",
    "    cadence: weekly",
    `    command: "${windowsInvocation} status"`,
    "    enabled: true",
    ""
  ].join("\n"));

  const run = spawnSync(
    process.execPath,
    [cli, "schedule", "run", "local-status", "--path", aiosPath],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: fakeBin } }
  );

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Running in-package DotAIOS: status --path /);
  assert.equal(fs.existsSync(executionMarker), false);
});

test("schedule doctor labels only the Windows handoff with npx.cmd", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-schedule-doctor-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiosPath = makeAios(root);

  const result = spawnSync(
    process.execPath,
    [cli, "schedule", "doctor", "--path", aiosPath],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`- macOS: ${posixInvocation.replaceAll(".", "\\.")} schedule install`));
  assert.match(result.stdout, new RegExp(`- Linux: ${posixInvocation.replaceAll(".", "\\.")} schedule install`));
  assert.match(result.stdout, new RegExp(`- Windows: ${windowsInvocation.replaceAll(".", "\\.")} schedule install`));
});

test("doctor recognizes stale npx.cmd instructions instead of silently ignoring them", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-doctor-npx-cmd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiosPath = makeAios(root);
  const homePath = path.join(root, "home");
  const bridgePath = path.join(homePath, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
  fs.writeFileSync(bridgePath, [
    "<!-- dotaios-managed:start -->",
    "Run `npx.cmd dotaios@2.0.10 brief --compact --memory shared`.",
    "<!-- dotaios-managed:end -->",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(aiosPath, "AGENTS.md"), `Use \`${windowsInvocation} brief --compact --memory shared\`.\n`);

  const result = await checkCliReachable(aiosPath, homePath, {
    loadRegistry: async () => [{ name: "Codex", bridge: ".codex/AGENTS.md" }],
    resolveInvocation: async () => windowsInvocation
  });

  assert.equal(result.status, "warn");
  assert.match(result.detail, /1 connected AI app instruction/);
});

test("persisted interview overlays recognize exact npx.cmd guidance", () => {
  const prompt = renderGeneratedPrompt(
    "windows",
    `This file is generated by DotAIOS. Re-run \`${windowsInvocation} interview\` to refresh it.`
  );
  assert.equal(
    isRecognizedOfficialSkillOverlay("plan-today", "prompt.md", Buffer.from(prompt)),
    true
  );
});

test("official instruction validation rejects an unpinned npx.cmd command", () => {
  assert.throws(
    () => materializeOfficialCandidateBytes(
      Buffer.from("Run npx.cmd dotaios brief for <exact-candidate-version>.\n"),
      { kind: "exact-candidate-version/v1", token_count: 1 },
      version
    ),
    (error) => error?.code === "DOTAIOS_OFFICIAL_SKILL_PACKAGE_INVALID"
  );
});
