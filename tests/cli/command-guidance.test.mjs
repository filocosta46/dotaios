import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeTerminalText,
  guidanceShellLabel,
  renderGuidanceCommand,
  visibleTerminalText
} from "../../packages/cli/src/lib/command-guidance.mjs";

test("guidance renders a copyable POSIX command for a path with shell metacharacters", () => {
  const command = renderGuidanceCommand("npx dotaios@2.0.11 upgrade", {
    targetPath: "/tmp/a b'c & | % ! ^",
    defaultPath: "/tmp/default",
    platform: "darwin"
  });

  assert.equal(
    command,
    "npx dotaios@2.0.11 upgrade --path '/tmp/a b'\\''c & | % ! ^'"
  );
  assert.equal(guidanceShellLabel("darwin"), "POSIX shell");
  assert.match(command, /^npx /);
});

test("guidance renders PowerShell quoting instead of cmd.exe-injectable POSIX quotes", () => {
  const command = renderGuidanceCommand("npx dotaios@2.0.11 upgrade", {
    targetPath: "C:\\A B's & | % ! ^",
    defaultPath: "C:\\default",
    platform: "win32"
  });

  assert.equal(
    command,
    "npx dotaios@2.0.11 upgrade --path 'C:\\A B''s & | % ! ^'"
  );
  assert.equal(guidanceShellLabel("win32"), "PowerShell");
  assert.match(command, /^npx /);
});

test("guidance omits --path for the default target", () => {
  assert.equal(renderGuidanceCommand("npx dotaios@2.0.11 upgrade", {
    targetPath: "/tmp/default",
    defaultPath: "/tmp/default",
    platform: "linux"
  }), "npx dotaios@2.0.11 upgrade");
});

test("guidance rejects terminal controls and preview text makes them visible", () => {
  for (const unsafePath of [
    "/tmp/line\nbreak",
    "/tmp/\u001b[2J",
    "/tmp/\u001b]0;spoof",
    "/tmp/\u0085c1",
    "/tmp/line\u2028separator",
    "/tmp/paragraph\u2029separator",
    "/tmp/\u202Ertl"
  ]) {
    assert.throws(() => renderGuidanceCommand("npx dotaios@2.0.11 upgrade", {
      targetPath: unsafePath,
      defaultPath: "/tmp/default",
      platform: "darwin"
    }), /unsafe terminal character U\+/i);
  }

  assert.equal(visibleTerminalText("line\n\u001b]0;spoof\u202E"), "line\\n\\u001B]0;spoof\\u202E");
  assert.throws(
    () => assertSafeTerminalText("/tmp/attacker\u001b[2Jpayload", "AIOS path"),
    (error) => {
      assert.match(error.message, /U\+001B/);
      assert.doesNotMatch(error.message, /attacker|payload/);
      return true;
    }
  );
});
