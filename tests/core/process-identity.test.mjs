import test from "node:test";
import assert from "node:assert/strict";
import {
  processBirthToken,
  processRecordIsAlive
} from "../../packages/core/src/process-identity.mjs";

test("process birth token reads a bounded OS identity", () => {
  const token = processBirthToken(42, {
    platform: "linux",
    spawn: () => ({ status: 0, stdout: "Mon Aug  5 12:00:00 2026\n" })
  });
  assert.equal(token, "Mon Aug  5 12:00:00 2026");
});

test("process birth token uses a non-interactive PowerShell start time on Windows", () => {
  let invocation = null;
  const token = processBirthToken(42, {
    platform: "win32",
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "2026-08-05T12:00:00.0000000Z\r\n" };
    }
  });

  assert.equal(token, "2026-08-05T12:00:00.0000000Z");
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
  assert.match(invocation.args.at(-1), /Get-Process -Id 42/);
  assert.equal(invocation.options.timeout, 1_000);
});

test("process identity distinguishes a reused PID from the original owner", () => {
  assert.equal(processRecordIsAlive({
    pid: 42,
    process_started_at: "old-birth"
  }, {
    kill: () => {},
    readBirthToken: () => "new-birth"
  }), false);
  assert.equal(processRecordIsAlive({
    pid: 42,
    process_started_at: "same-birth"
  }, {
    kill: () => {},
    readBirthToken: () => "same-birth"
  }), true);
});

test("process identity fails closed when birth time cannot be inspected", () => {
  assert.equal(processRecordIsAlive({
    pid: 42,
    process_started_at: "recorded-birth"
  }, {
    kill: () => {},
    readBirthToken: () => null
  }), true);
});
