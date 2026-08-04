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
import { DOTAIOS_PACKAGE_VERSION } from "../../packages/cli/src/lib/mcp-launcher.mjs";

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

test("mergeOpenCodeSettings refuses non-object OpenCode configuration", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({ mcp: [] });
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /must contain a JSON object/
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
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

test("mergeOpenCodeSettings writes OpenCode's documented local MCP shape", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");

  await mergeOpenCodeSettings(settingsPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const entry = written.mcp.dotaios;
  assert.equal(entry.type, "local");
  assert.deepEqual(entry.command, [
    "npx",
    "--yes",
    "--package",
    `dotaios@${DOTAIOS_PACKAGE_VERSION}`,
    "dotaios-mcp",
    "--path",
    "/home/u/aios"
  ]);
  assert.equal(entry.enabled, true);
  assert.equal(written.mcp.servers, undefined);
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(settingsPath, "utf8"), /_npx|packages[\\/]mcp[\\/]src/);
});

test("mergeOpenCodeSettings preserves foreign MCP servers", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcp: {
        custom: {
          type: "remote",
          url: "https://example.test/mcp"
        }
      }
    })
  );

  await mergeOpenCodeSettings(settingsPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(written.mcp.custom, {
    type: "remote",
    url: "https://example.test/mcp"
  });
  assert.equal(written.mcp.dotaios.type, "local");
});

test("mergeOpenCodeSettings refuses to overwrite a foreign current mcp.dotaios entry", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({
    mcp: {
      dotaios: {
        type: "remote",
        url: "https://foreign.example/mcp"
      }
    }
  });
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /unrecognized mcp\.dotaios.*refusing to overwrite/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeOpenCodeSettings requires an exact managed current launcher shape", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({
    mcp: {
      dotaios: {
        type: "local",
        command: [
          "npx",
          "foreign-prelude",
          "--package",
          `dotaios@${DOTAIOS_PACKAGE_VERSION}`,
          "foreign-middle",
          "dotaios-mcp",
          "--foreign-flag",
          "--path",
          "/foreign-aios",
          "--tail"
        ]
      }
    }
  });
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /unrecognized mcp\.dotaios/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeOpenCodeSettings refuses extra fields on an otherwise managed launcher", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({
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
          "/foreign-aios"
        ],
        url: "https://foreign.example/mcp"
      }
    }
  });
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /unrecognized mcp\.dotaios/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeOpenCodeSettings fails closed on malformed legacy mcp.servers values", async () => {
  for (const value of ["wrong", [], 42]) {
    const dir = tmp();
    const settingsPath = path.join(dir, "opencode.json");
    const original = JSON.stringify({ mcp: { servers: value } });
    fs.writeFileSync(settingsPath, original);

    await assert.rejects(
      () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
      /invalid legacy mcp\.servers/i
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
  }
});

test("mergeOpenCodeSettings refuses foreign-only legacy mcp.servers entries", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({
    mcp: {
      servers: {
        custom: { command: "custom-server" }
      }
    }
  });
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /legacy mcp\.servers entries \(custom\)/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeOpenCodeSettings preserves an existing config file mode", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ mcp: {} }), { mode: 0o640 });
  fs.chmodSync(settingsPath, 0o640);

  await mergeOpenCodeSettings(settingsPath, "/home/u/aios");

  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o640);
});

test("mergeOpenCodeSettings treats read errors as errors, not missing files", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  fs.mkdirSync(settingsPath);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /Could not read existing.*refusing to overwrite/i
  );
  assert.equal(fs.statSync(settingsPath).isDirectory(), true);
});

test("mergeOpenCodeSettings refuses to replace a symlinked config", async () => {
  const dir = tmp();
  const targetPath = path.join(dir, "shared-opencode.json");
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({ mcp: {} });
  fs.writeFileSync(targetPath, original);
  fs.symlinkSync(targetPath, settingsPath);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /not a regular file.*refusing to overwrite/i
  );
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), original);
});

test("mergeOpenCodeSettings refuses ambiguous legacy foreign MCP entries", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcp: {
        servers: {
          dotaios: {
            type: "local",
            command: process.execPath,
            args: ["/old/node_modules/dotaios/packages/mcp/src/server.mjs", "--path", "/old/aios"]
          },
          custom: {
            command: "custom-server"
          }
        }
      }
    })
  );

  const original = fs.readFileSync(settingsPath, "utf8");
  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /legacy mcp\.servers.*custom/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeOpenCodeSettings requires an exact managed legacy launcher shape", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  const original = JSON.stringify({
    mcp: {
      servers: {
        dotaios: {
          type: "local",
          command: "python3",
          args: ["/tmp/foreign/packages/mcp/src/server.mjs", "--path", "/foreign-aios"]
        }
      }
    }
  });
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeOpenCodeSettings(settingsPath, "/home/u/aios"),
    /unrecognized legacy mcp\.servers\.dotaios/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeOpenCodeSettings migrates a recognizable legacy DotAIOS-only container", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "opencode.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcp: {
        servers: {
          dotaios: {
            type: "local",
            command: process.execPath,
            args: ["/old/node_modules/dotaios/packages/mcp/src/server.mjs", "--path", "/old/aios"]
          }
        }
      }
    })
  );

  await mergeOpenCodeSettings(settingsPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(written.mcp.servers, undefined);
  assert.equal(written.mcp.dotaios.type, "local");
  assert.equal(written.mcp.dotaios.command[0], "npx");
});

test("connect rejects --status for non-Google services before any mutation", async () => {
  await assert.rejects(
    () => connectCommand(["gemini", "--status"]),
    /--status option is supported only/
  );
  await assert.rejects(
    () => connectCommand(["opencode", "--status"]),
    /--status option is supported only/
  );
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
