import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
