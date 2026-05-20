import test from "node:test";
import assert from "node:assert/strict";
import { syncCommand } from "../../packages/cli/src/commands/sync.mjs";

test("syncCommand with --help prints usage", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await syncCommand(["--help"]);
  } finally { console.log = orig; }
  assert.ok(logs.join("\n").includes("dotaios sync"));
  assert.ok(logs.join("\n").includes("setup"));
  assert.ok(logs.join("\n").includes("tick"));
  assert.ok(logs.join("\n").includes("status"));
});

test("syncCommand with unknown subcommand sets exit code 1", async () => {
  const errors = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => errors.push(a.join(" "));
  console.log = () => {};
  try {
    await syncCommand(["frobnicate"]);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  assert.equal(process.exitCode, 1);
  assert.ok(errors.join("\n").includes("Unknown sync subcommand"));
  process.exitCode = 0; // reset for other tests
});
