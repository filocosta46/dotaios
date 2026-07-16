import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  connectCommand,
  shSingleQuote,
  buildGeminiHookScript,
  mergeGeminiSettings,
  mergeOpenCodeSettings
} from "../../packages/cli/src/commands/connect.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-connect-test-"));
}

test("shSingleQuote neutralizes shell metacharacters in a path", () => {
  const dir = tmp();
  const sentinel = path.join(dir, "pwned");
  const malicious = `/tmp/x'; touch ${sentinel}; echo '`;
  const quoted = shSingleQuote(malicious);
  const out = spawnSync("bash", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, malicious); // path arrives as one intact argument
  assert.equal(fs.existsSync(sentinel), false); // the injected command did not run
});

test("buildGeminiHookScript single-quotes the AIOS path (no shell interpolation)", () => {
  const script = buildGeminiHookScript(`/home/u/ai'os`);
  assert.match(script, /--path '\/home\/u\/ai'\\''os'/);
  assert.doesNotMatch(script, /--path "/); // never wraps the path in double quotes
});

// Regression coverage for the "no partial install" guard (open item a): a
// corrupt existing agent config must abort the merge before anything is written.
test("mergeGeminiSettings refuses to overwrite a malformed settings.json", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = "{ this is not valid json";
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /not valid JSON/
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original); // left untouched
});

test("mergeOpenCodeSettings refuses to overwrite a malformed opencode.json", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = "{ broken";
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /not valid JSON/
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original); // left untouched
});

test("mergeGeminiSettings writes a SessionStart hook into a fresh config", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const hookPath = path.join(dir, "hook.sh");

  await mergeGeminiSettings(settingsPath, hookPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const names = written.hooks.SessionStart.flatMap((h) => h.hooks.map((hh) => hh.name));
  assert.ok(names.includes("dotaios-context"));
  assert.equal(written.mcp, undefined);
});

test("mergeGeminiSettings removes only the legacy DotAIOS MCP entry", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    mcp: {
      servers: {
        dotaios: { command: "npx", args: ["dotaios-mcp", "--path", "/old/aios"] },
        custom: { command: "custom-server", args: [] }
      }
    }
  }));

  await mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(written.mcp.servers.dotaios, undefined);
  assert.equal(written.mcp.servers.custom.command, "custom-server");
});

test("mergeOpenCodeSettings uses the packaged server directly", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");

  await mergeOpenCodeSettings(settingsPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const entry = written.mcp.servers.dotaios;
  assert.equal(entry.command, process.execPath);
  assert.match(entry.args[0], /packages[\\/]mcp[\\/]src[\\/]server\.mjs$/);
  assert.deepEqual(entry.args.slice(1), ["--path", "/home/u/aios"]);
});

test("Google connection records redact binary paths and untrusted version output", async () => {
  const dir = tmp();
  const aiosPath = path.join(dir, "aios");
  const gwsBin = path.join(dir, "private-tools", "gws");
  fs.mkdirSync(path.dirname(gwsBin), { recursive: true });
  fs.mkdirSync(aiosPath, { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), "{}\n");
  fs.writeFileSync(gwsBin, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gws 9.8.7 binary=${gwsBin} refresh_token=TOPSECRET"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"auth_method":"oauth"}'
  exit 0
fi
exit 1
`);
  fs.chmodSync(gwsBin, 0o755);

  const originalLog = console.log;
  console.log = () => {};
  try {
    await connectCommand(["google", "--path", aiosPath, "--gws-bin", gwsBin]);
  } finally {
    console.log = originalLog;
  }

  const recordPaths = [
    path.join(aiosPath, "connections", "apis", "google-workspace.md"),
    path.join(aiosPath, "connections", "registry.md"),
    path.join(aiosPath, "skills", "google-workspace", "SKILL.md"),
    path.join(aiosPath, "memory", "events.jsonl")
  ];
  const records = recordPaths.map((recordPath) => fs.readFileSync(recordPath, "utf8")).join("\n");

  assert.match(records, /Tool: gws/);
  assert.match(records, /Version: 9\.8\.7/);
  assert.doesNotMatch(records, new RegExp(gwsBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(records, /TOPSECRET|refresh_token|Binary:/);
});
