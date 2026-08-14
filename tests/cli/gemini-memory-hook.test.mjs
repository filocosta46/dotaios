import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  buildGeminiHookScript
} from "../../packages/cli/src/adapters/gemini.mjs";
import { readGeminiFirstUserMessage } from "../../packages/cli/src/lib/gemini-memory-hook.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.mjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-gemini-hook-test-"));
}

function hookInput(overrides = {}) {
  return {
    session_id: "gemini-session-1",
    transcript_path: "",
    cwd: "/tmp/work",
    hook_event_name: "BeforeAgent",
    prompt: "Current turn",
    ...overrides
  };
}

function geminiJsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function runBrief(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, "brief", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function modeFixture() {
  const root = tmp();
  const homePath = path.join(root, "home");
  const aiosPath = path.join(root, "aios");
  const projectPath = path.join(root, "client-work", "alpha");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(path.join(homePath, ".dotaios"), { recursive: true });
  fs.mkdirSync(path.join(aiosPath, "projects", "alpha"), { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(aiosPath, "aios.json"), '{"schema_version":"1.2.0"}\n');
  fs.writeFileSync(path.join(aiosPath, "projects", "alpha", "README.md"), [
    "---",
    "id: project-alpha-001",
    "project: alpha",
    "status: active",
    "---",
    "# Alpha",
    "",
    "ALPHA_PROJECT_ONLY_CANARY"
  ].join("\n"));
  fs.writeFileSync(path.join(homePath, ".dotaios", "projects.json"), JSON.stringify({
    version: 1,
    paths: { "project-alpha-001": projectPath }
  }));
  return { root, homePath, aiosPath, projectPath, elsewhere };
}

test("Gemini first-message reader derives the session lock from the host transcript", async () => {
  const root = tmp();
  const transcriptPath = path.join(root, "session.json");
  fs.writeFileSync(transcriptPath, JSON.stringify({
    sessionId: "gemini-session-1",
    messages: [
      { type: "user", content: [{ text: "Private chat — do not use memory" }] },
      { type: "gemini", content: [{ text: "Okay" }] },
      { type: "user", content: [{ text: "Current unrelated turn" }] }
    ]
  }));

  assert.equal(
    await readGeminiFirstUserMessage(hookInput({ transcript_path: transcriptPath })),
    "Private chat — do not use memory"
  );
});

test("Gemini first-message reader uses the current prompt from a new empty host transcript", async () => {
  const root = tmp();
  const transcriptPath = path.join(root, "session.json");
  fs.writeFileSync(transcriptPath, JSON.stringify({ sessionId: "gemini-session-1", messages: [] }));

  assert.equal(
    await readGeminiFirstUserMessage(hookInput({
      transcript_path: transcriptPath,
      prompt: "Only this project please"
    })),
    "Only this project please"
  );
});

test("Gemini first-message reader supports current JSONL transcripts and resumed turns", async () => {
  const root = tmp();
  const transcriptPath = path.join(root, "session.jsonl");
  fs.writeFileSync(transcriptPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash", startTime: "2026-08-14T00:00:00.000Z" },
    { id: "user-1", timestamp: "2026-08-14T00:00:01.000Z", type: "user", content: [{ text: "Private chat — keep this session off" }] },
    { id: "gemini-1", timestamp: "2026-08-14T00:00:02.000Z", type: "gemini", content: [{ text: "Okay" }] },
    { id: "user-2", timestamp: "2026-08-14T00:00:03.000Z", type: "user", content: "Current resumed turn" }
  ));

  assert.equal(
    await readGeminiFirstUserMessage(hookInput({ transcript_path: transcriptPath })),
    "Private chat — keep this session off"
  );
});

test("Gemini first-message reader keeps the original session lock across JSONL rewind and checkpoints", async () => {
  const root = tmp();
  const rewoundPath = path.join(root, "rewound.jsonl");
  fs.writeFileSync(rewoundPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash" },
    { id: "private-user", type: "user", content: [{ text: "Private chat — discarded branch" }] },
    { id: "discarded-answer", type: "gemini", content: "Okay" },
    { $rewindTo: "private-user" },
    { id: "shared-user", type: "user", content: [{ text: "Use my memory after rewind" }] }
  ));
  assert.equal(
    await readGeminiFirstUserMessage(hookInput({ transcript_path: rewoundPath })),
    "Private chat — discarded branch"
  );

  const checkpointPath = path.join(root, "checkpoint.jsonl");
  fs.writeFileSync(checkpointPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash" },
    { id: "old-private", type: "user", content: "Private chat — replaced checkpoint" },
    { $set: { messages: [{ id: "kept-project", type: "user", content: [{ text: "Only this project after checkpoint" }] }] } }
  ));
  assert.equal(
    await readGeminiFirstUserMessage(hookInput({ transcript_path: checkpointPath })),
    "Private chat — replaced checkpoint"
  );

  const checkpointOnlyPath = path.join(root, "checkpoint-only.jsonl");
  fs.writeFileSync(checkpointOnlyPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash" },
    { $set: { messages: [{ id: "kept-project", type: "user", content: [{ text: "Only this project from initial checkpoint" }] }] } }
  ));
  assert.equal(
    await readGeminiFirstUserMessage(hookInput({ transcript_path: checkpointOnlyPath })),
    "Only this project from initial checkpoint"
  );
});

test("Gemini first-message reader rejects malformed and mixed-session JSONL", async () => {
  const root = tmp();
  const malformedPath = path.join(root, "malformed.jsonl");
  fs.writeFileSync(malformedPath, `${JSON.stringify({ sessionId: "gemini-session-1", projectHash: "project-hash" })}\n{broken\n`);
  await assert.rejects(
    () => readGeminiFirstUserMessage(hookInput({ transcript_path: malformedPath })),
    /valid JSON|JSONL|malformed/i
  );

  const mixedPath = path.join(root, "mixed.jsonl");
  fs.writeFileSync(mixedPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash" },
    { id: "user-1", type: "user", content: "Use my memory" },
    { $set: { sessionId: "another-session" } }
  ));
  await assert.rejects(
    () => readGeminiFirstUserMessage(hookInput({ transcript_path: mixedPath })),
    /does not belong|session/i
  );
});

test("Gemini first-message reader fails closed for missing or relative transcript evidence", async () => {
  const root = tmp();
  await assert.rejects(
    () => readGeminiFirstUserMessage(hookInput({ transcript_path: path.join(root, "missing.json") })),
    /could not verify|missing|ENOENT/i
  );
  await assert.rejects(
    () => readGeminiFirstUserMessage(hookInput({ transcript_path: "relative-session.json" })),
    /absolute/i
  );
  await assert.rejects(
    () => readGeminiFirstUserMessage(hookInput({
      transcript_path: path.join(root, "missing-private.json"),
      prompt: "Private chat now"
    })),
    /could not verify|missing/i
  );
});

test("Gemini first-message reader fails before opening a transcript when no-follow reads are unavailable", async () => {
  const root = tmp();
  const transcriptPath = path.join(root, "session.json");
  fs.writeFileSync(transcriptPath, JSON.stringify({ sessionId: "gemini-session-1", messages: [] }));
  let openCalls = 0;
  await assert.rejects(
    () => readGeminiFirstUserMessage(hookInput({ transcript_path: transcriptPath }), {
      noFollowFlag: 0,
      fileSystem: {
        lstat: (...args) => fsPromises.lstat(...args),
        open: async (...args) => {
          openCalls += 1;
          return fsPromises.open(...args);
        }
      }
    }),
    /no-follow/i
  );
  assert.equal(openCalls, 0);
});

test("Gemini hook keeps a Private chat session Off without opening DotAIOS", () => {
  const root = tmp();
  const missingAios = path.join(root, "must-stay-missing");
  const transcriptPath = path.join(root, "session.json");
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const npxSentinel = path.join(root, "npx-was-called");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npx"),
    `#!/usr/bin/env bash\ntouch ${JSON.stringify(npxSentinel)}\nprintf '%s\\n' '{}'\n`,
    { mode: 0o700 }
  );
  fs.writeFileSync(transcriptPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash" },
    { id: "user-1", type: "user", content: [{ text: "Private chat: taxes" }] }
  ));
  fs.writeFileSync(scriptPath, buildGeminiHookScript(missingAios), { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify(hookInput({
      transcript_path: transcriptPath,
      prompt: "Second turn must remain private"
    })),
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /^Memory: Off\b/);
  assert.match(output.hookSpecificOutput.additionalContext, /AI app may still keep its own conversation history/i);
  assert.match(output.systemMessage, /^Memory: Off\b/);
  assert.equal(output.hookSpecificOutput.hookEventName, "BeforeAgent");
  assert.equal(fs.existsSync(missingAios), false);
  assert.equal(fs.existsSync(npxSentinel), false);
});

test("Gemini v2 hook is safe while older SessionStart settings still point at it", () => {
  const root = tmp();
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "npx"), [
    "#!/usr/bin/env bash",
    "shift 3",
    `exec ${process.execPath} ${cliPath} \"$@\"`
  ].join("\n"), { mode: 0o700 });
  fs.writeFileSync(scriptPath, buildGeminiHookScript(path.join(root, "missing-aios")), { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "gemini-session-1",
      transcript_path: "",
      cwd: root,
      hook_event_name: "SessionStart"
    }),
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.notEqual(output.continue, false);
  assert.match(output.systemMessage, /Memory: Closed|update.*incomplete/i);
  assert.equal(fs.existsSync(path.join(root, "missing-aios")), false);
});

test("Gemini generated hook routes Shared through the hidden audited hook seam", () => {
  const { homePath, aiosPath, elsewhere } = modeFixture();
  const root = tmp();
  const transcriptPath = path.join(root, "session.json");
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(transcriptPath, JSON.stringify({ sessionId: "gemini-session-1", messages: [] }));
  fs.writeFileSync(path.join(binDir, "npx"), [
    "#!/usr/bin/env bash",
    "shift 3",
    `exec ${process.execPath} ${cliPath} \"$@\"`
  ].join("\n"), { mode: 0o700 });
  fs.writeFileSync(scriptPath, buildGeminiHookScript(aiosPath), { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify(hookInput({
      transcript_path: transcriptPath,
      cwd: elsewhere,
      prompt: "Help me continue"
    })),
    env: { ...process.env, HOME: homePath, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.systemMessage, "Memory: Shared");
  assert.equal(output.dotaiosMemory.mode, "shared");
  assert.match(output.hookSpecificOutput.additionalContext, /^Memory: Shared\b/);
});

test("Gemini hook emits one valid JSON object when the pinned brief fails", () => {
  const root = tmp();
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npx"),
    "#!/usr/bin/env bash\necho 'brief failed' >&2\nexit 9\n",
    { mode: 0o700 }
  );
  fs.writeFileSync(scriptPath, buildGeminiHookScript(path.join(root, "aios")), { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify(hookInput({
      transcript_path: path.join(root, "first-turn-not-written-yet.json"),
      prompt: "Use my memory"
    })),
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.stopReason, /could not load memory safely/i);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("Gemini hook brief defaults attached folders to This project and other folders to Shared", () => {
  const { homePath, aiosPath, projectPath, elsewhere } = modeFixture();
  const env = { HOME: homePath };

  const attached = runBrief([
    "--compact", "--json", "--path", aiosPath,
    "--first-message", "Help me continue", "--cwd", projectPath
  ], env);
  assert.equal(attached.status, 0, attached.stderr);
  const attachedOutput = JSON.parse(attached.stdout);
  assert.equal(attachedOutput.systemMessage, "Memory: This project");
  assert.deepEqual(attachedOutput.dotaiosMemory, {
    mode: "project",
    project: "project-alpha-001"
  });
  assert.match(attachedOutput.hookSpecificOutput.additionalContext, /^Memory: This project\b/);
  assert.match(attachedOutput.hookSpecificOutput.additionalContext, /ALPHA_PROJECT_ONLY_CANARY/);

  const outside = runBrief([
    "--compact", "--json", "--path", aiosPath,
    "--first-message", "Help me continue", "--cwd", elsewhere
  ], env);
  assert.equal(outside.status, 0, outside.stderr);
  const outsideOutput = JSON.parse(outside.stdout);
  assert.equal(outsideOutput.systemMessage, "Memory: Shared");
  assert.deepEqual(outsideOutput.dotaiosMemory, {
    mode: "shared",
    project: null
  });
});

test("Gemini generated hook rejects a malformed successful child envelope", () => {
  const root = tmp();
  const transcriptPath = path.join(root, "session.json");
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(transcriptPath, JSON.stringify({ sessionId: "gemini-session-1", messages: [] }));
  fs.writeFileSync(path.join(binDir, "npx"), "#!/usr/bin/env bash\nprintf '%s\\n' '{}'\n", { mode: 0o700 });
  fs.writeFileSync(scriptPath, buildGeminiHookScript(path.join(root, "aios")), { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify(hookInput({ transcript_path: transcriptPath, prompt: "Use my memory" })),
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.systemMessage, /left memory closed|could not load memory safely/i);
});

test("Gemini generated hook self-heals through the pinned CLI when its install cache disappears", () => {
  const root = tmp();
  const missingAios = path.join(root, "must-stay-missing");
  const transcriptPath = path.join(root, "session.jsonl");
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const npxSentinel = path.join(root, "npx-was-called");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(transcriptPath, geminiJsonl(
    { sessionId: "gemini-session-1", projectHash: "project-hash" },
    { id: "user-1", type: "user", content: "Private chat after cache cleanup" }
  ));
  fs.writeFileSync(path.join(binDir, "npx"), [
    "#!/usr/bin/env bash",
    `touch ${JSON.stringify(npxSentinel)}`,
    "shift 3",
    `exec ${process.execPath} ${cliPath} "$@"`
  ].join("\n"), { mode: 0o700 });

  let script = buildGeminiHookScript(missingAios);
  const encodedModule = /^# dotaios-hook-module-base64: (.+)$/m.exec(script)?.[1];
  assert.ok(encodedModule, "generated hook records its classifier module");
  const moduleUrl = Buffer.from(encodedModule, "base64").toString("utf8");
  const removedModuleUrl = pathToFileURL(path.join(root, "removed-npx-cache", "gemini-memory-hook.mjs")).href;
  script = script.replace(moduleUrl, removedModuleUrl);
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify(hookInput({
      transcript_path: transcriptPath,
      prompt: "Current turn remains private"
    })),
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /^Memory: Off\b/);
  assert.equal(fs.existsSync(npxSentinel), true);
  assert.equal(fs.existsSync(missingAios), false);
});

test("Gemini generated hook closes memory when an established Private prompt has no transcript evidence", () => {
  const root = tmp();
  const missingAios = path.join(root, "must-stay-missing");
  const scriptPath = path.join(root, "dotaios-context-hook.sh");
  const npxSentinel = path.join(root, "npx-was-called");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "npx"), `#!/usr/bin/env bash\ntouch ${JSON.stringify(npxSentinel)}\n`, { mode: 0o700 });
  fs.writeFileSync(scriptPath, buildGeminiHookScript(missingAios), { mode: 0o700 });

  const result = spawnSync(scriptPath, [], {
    encoding: "utf8",
    input: JSON.stringify(hookInput({
      transcript_path: path.join(root, "deleted-session.json"),
      prompt: "Private chat now"
    })),
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.systemMessage, /^Memory: Closed\b/);
  assert.doesNotMatch(output.systemMessage, /^Memory: Off\b/);
  assert.equal(fs.existsSync(missingAios), false);
  assert.equal(fs.existsSync(npxSentinel), false);
});

test("Gemini hook brief honors explicit Shared and fails closed when This project is unattached", () => {
  const { homePath, aiosPath, projectPath, elsewhere } = modeFixture();
  const env = { HOME: homePath };

  const shared = runBrief([
    "--compact", "--json", "--path", aiosPath,
    "--first-message", "Use my memory for this", "--cwd", projectPath
  ], env);
  assert.equal(shared.status, 0, shared.stderr);
  assert.deepEqual(JSON.parse(shared.stdout).dotaiosMemory, {
    mode: "shared",
    project: null
  });

  const unattached = runBrief([
    "--compact", "--json", "--path", aiosPath,
    "--first-message", "Only this project please", "--cwd", elsewhere
  ], env);
  assert.notEqual(unattached.status, 0);
  assert.match(unattached.stderr, /project selector is required|This project memory/i);
  assert.equal(unattached.stdout, "");
});
