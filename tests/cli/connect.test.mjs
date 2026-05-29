import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  shSingleQuote,
  buildGeminiHookScript
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
