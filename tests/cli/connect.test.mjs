import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  buildGeminiHookScript,
  mergeGeminiSettings,
  shSingleQuote,
  writeGeminiHookScript
} from "../../packages/cli/src/adapters/gemini.mjs";
import { connectCommand, mergeOpenCodeSettings } from "../../packages/cli/src/commands/connect.mjs";
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

test("buildGeminiHookScript pins DotAIOS instead of executing a project-local binary", () => {
  const script = buildGeminiHookScript("/home/u/aios");
  assert.match(script, new RegExp(`npx -y --loglevel=error dotaios@${DOTAIOS_PACKAGE_VERSION.replaceAll(".", "\\.")} brief`));
  assert.doesNotMatch(script, /npx dotaios brief/);
});

test("Gemini hook never executes a matching project-local DotAIOS package", () => {
  const root = tmp();
  const project = path.join(root, "untrusted-project");
  const packageDir = path.join(project, "node_modules", "dotaios");
  const binDir = path.join(project, "node_modules", ".bin");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "dotaios",
    version: DOTAIOS_PACKAGE_VERSION,
    bin: { dotaios: "bin.mjs" },
    type: "module"
  }));
  fs.writeFileSync(
    path.join(packageDir, "bin.mjs"),
    "#!/usr/bin/env node\nconsole.log('PROJECT-LOCAL-SHADOW');\n",
    { mode: 0o755 }
  );
  fs.symlinkSync(path.join("..", "dotaios", "bin.mjs"), path.join(binDir, "dotaios"));

  const result = spawnSync("bash", ["-c", buildGeminiHookScript("/missing/aios")], {
    cwd: project,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      npm_config_cache: path.join(root, "empty-npm-cache"),
      npm_config_offline: "true"
    }
  });

  assert.doesNotMatch(result.stdout, /PROJECT-LOCAL-SHADOW/);
});

test("buildGeminiHookScript surfaces context failures instead of returning empty success", () => {
  const script = buildGeminiHookScript("/home/u/aios");
  assert.doesNotMatch(script, /2>\/dev\/null/);
  assert.doesNotMatch(script, /\|\|\s*echo ['"]\{\}['"]/);
});

test("buildGeminiHookScript refuses line-breaking AIOS paths", () => {
  assert.throws(
    () => buildGeminiHookScript("/home/u/aios\nextra-command"),
    /control characters|line breaks|unsupported.*path/i
  );
});

test("writeGeminiHookScript refuses an existing foreign script", async () => {
  const dir = tmp();
  const scriptPath = path.join(dir, "dotaios-context-hook.sh");
  const original = "#!/bin/sh\necho user-owned\n";
  fs.writeFileSync(scriptPath, original, { mode: 0o700 });

  await assert.rejects(
    () => writeGeminiHookScript(scriptPath, "/home/u/aios"),
    /not a DotAIOS-managed hook|existing foreign/i
  );
  assert.equal(fs.readFileSync(scriptPath, "utf8"), original);
  assert.equal(fs.statSync(scriptPath).mode & 0o777, 0o700);
});

test("writeGeminiHookScript makes a legacy managed hook executable without widening its backup mode", async () => {
  const dir = tmp();
  const scriptPath = path.join(dir, "dotaios-context-hook.sh");
  const original = "#!/usr/bin/env bash\n# DotAIOS context injection for Gemini CLI SessionStart\n# Injects working memory digest as the first context turn.\nnpx dotaios brief --compact --json --path '/old/aios' 2>/dev/null || echo '{}'\n";
  fs.writeFileSync(scriptPath, original, { mode: 0o600 });

  const result = await writeGeminiHookScript(scriptPath, "/home/u/aios");

  assert.equal(fs.statSync(scriptPath).mode & 0o100, 0o100);
  assert.equal(fs.readFileSync(result.preservedPath, "utf8"), original);
  assert.equal(fs.statSync(result.preservedPath).mode & 0o777, 0o600);
});

test("writeGeminiHookScript refuses a legacy-looking script with extra user content", async () => {
  const dir = tmp();
  const scriptPath = path.join(dir, "dotaios-context-hook.sh");
  const original = "#!/usr/bin/env bash\n# DotAIOS context injection for Gemini CLI SessionStart\n# Injects working memory digest as the first context turn.\nnpx dotaios brief --compact --json --path '/old/aios' 2>/dev/null || echo '{}'\n# user customization\necho keep-me\n";
  fs.writeFileSync(scriptPath, original, { mode: 0o700 });

  await assert.rejects(
    () => writeGeminiHookScript(scriptPath, "/home/u/aios"),
    /not a DotAIOS-managed hook|foreign script/i
  );
  assert.equal(fs.readFileSync(scriptPath, "utf8"), original);
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

test("mergeGeminiSettings refuses a symlinked settings file", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const outside = path.join(dir, "outside.json");
  const original = '{"theme":"mine"}\n';
  fs.writeFileSync(outside, original);
  fs.symlinkSync(outside, settingsPath);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /unsafe file destination|unsafe/i
  );
  assert.equal(fs.readFileSync(outside, "utf8"), original);
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
});

test("mergeGeminiSettings refuses a non-object configuration", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = "[]\n";
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /must contain a JSON object/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeGeminiSettings refuses an incompatible SessionStart shape", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = '{"hooks":{"SessionStart":{"custom":true}}}\n';
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /SessionStart.*array|incompatible.*SessionStart/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeGeminiSettings refuses malformed entries inside SessionStart", async () => {
  for (const entry of [null, { hooks: "not-an-array" }, { hooks: [null] }]) {
    const dir = tmp();
    const settingsPath = path.join(dir, "settings.json");
    const original = `${JSON.stringify({ hooks: { SessionStart: [entry] } })}\n`;
    fs.writeFileSync(settingsPath, original);

    await assert.rejects(
      () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
      /malformed SessionStart|hooks.*array|hook entry/i
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
  }
});

test("mergeGeminiSettings respects an explicitly disabled DotAIOS hook", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = `${JSON.stringify({ hooks: { disabled: ["dotaios-context"] } })}\n`;
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /dotaios-context.*disabled|enable.*then retry/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeGeminiSettings leaves a concurrent user edit untouched", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = '{"theme":"mine"}\n';
  const concurrent = '{"theme":"changed-during-connect"}\n';
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(
      settingsPath,
      path.join(dir, "hook.sh"),
      "/home/u/aios",
      { beforeCommit: async () => fs.writeFileSync(settingsPath, concurrent) }
    ),
    /changed during connect|conflict/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), concurrent);
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

test("mergeGeminiSettings shell-quotes a hook path containing spaces", async () => {
  const root = tmp();
  const dir = path.join(root, "Home With Space");
  fs.mkdirSync(dir);
  const settingsPath = path.join(dir, "settings.json");
  const hookPath = path.join(dir, "hook.sh");

  await mergeGeminiSettings(settingsPath, hookPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const managed = written.hooks.SessionStart
    .flatMap((entry) => entry.hooks)
    .find((entry) => entry.name === "dotaios-context");
  assert.equal(managed.command, shSingleQuote(hookPath));
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

test("mergeGeminiSettings refuses ambiguous legacy DotAIOS MCP entries", async () => {
  const ambiguousEntries = [
    { command: "npx", args: ["dotaios-mcp", "--path", "/old/aios"], env: { TOKEN: "keep" } },
    { command: "npx", args: ["dotaios-mcp", "--path", "/old/aios", "--custom"] },
    { command: "npx", args: ["dotaios-mcp"] }
  ];
  for (const entry of ambiguousEntries) {
    const dir = tmp();
    const settingsPath = path.join(dir, "settings.json");
    const original = `${JSON.stringify({ mcp: { servers: { dotaios: entry } } })}\n`;
    fs.writeFileSync(settingsPath, original);

    await assert.rejects(
      () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
      /unrecognized legacy.*dotaios|refusing to overwrite/i
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
  }
});

test("mergeGeminiSettings updates the one named DotAIOS hook and preserves foreign hooks", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const hookPath = path.join(dir, "hook.sh");
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: hookPath,
              name: "dotaios-context",
              timeout: 10000,
              description: "Keep this user-facing description",
              customUserField: { keep: true }
            },
            { type: "command", command: "/foreign/hook.sh", name: "foreign", timeout: 2500 }
          ]
        }
      ]
    }
  }));

  await mergeGeminiSettings(settingsPath, hookPath, "/home/u/aios");

  const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const hooks = written.hooks.SessionStart.flatMap((entry) => entry.hooks);
  assert.deepEqual(hooks.find((entry) => entry.name === "dotaios-context"), {
    type: "command",
    command: shSingleQuote(hookPath),
    name: "dotaios-context",
    timeout: 10000,
    description: "Keep this user-facing description",
    customUserField: { keep: true }
  });
  assert.deepEqual(hooks.find((entry) => entry.name === "foreign"), {
    type: "command",
    command: "/foreign/hook.sh",
    name: "foreign",
    timeout: 2500
  });
});

test("mergeGeminiSettings refuses duplicate named DotAIOS hooks", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = `${JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "/one", name: "dotaios-context" }] },
        { hooks: [{ type: "command", command: "/two", name: "dotaios-context" }] }
      ]
    }
  })}\n`;
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /multiple dotaios-context hooks|duplicate/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
});

test("mergeGeminiSettings refuses a foreign hook reusing the DotAIOS name", async () => {
  const dir = tmp();
  const settingsPath = path.join(dir, "settings.json");
  const original = `${JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{ name: "dotaios-context", type: "prompt", prompt: "foreign user hook" }]
      }]
    }
  })}\n`;
  fs.writeFileSync(settingsPath, original);

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(dir, "hook.sh"), "/home/u/aios"),
    /unrecognized dotaios-context hook|refusing.*ownership/i
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
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
    path.join(aiosPath, "memory", "events.jsonl")
  ];
  const records = recordPaths.map((recordPath) => fs.readFileSync(recordPath, "utf8")).join("\n");

  assert.match(records, /Tool: gws/);
  assert.match(records, /Version: 9\.8\.7/);
  assert.doesNotMatch(records, new RegExp(gwsBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(records, /TOPSECRET|refresh_token|Binary:/);
  assert.equal(fs.existsSync(path.join(aiosPath, "skills", "google-workspace")), false);
});
