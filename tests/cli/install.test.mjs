import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeSubdir } from "../../packages/cli/src/commands/install.mjs";

test("assertSafeSubdir allows a plain relative subdirectory", () => {
  assert.doesNotThrow(() => assertSafeSubdir("plugins/hello-memory"));
  assert.doesNotThrow(() => assertSafeSubdir(null));
  assert.doesNotThrow(() => assertSafeSubdir(undefined));
});

test("assertSafeSubdir rejects parent-directory traversal", () => {
  // A compromised market registry entry could set subdir to escape the clone
  // dir and pull files from anywhere on disk into the (synced) vault.
  assert.throws(() => assertSafeSubdir("../etc"), /\.\./);
  assert.throws(() => assertSafeSubdir("a/../../b"), /\.\./);
  assert.throws(() => assertSafeSubdir("nested/../../escape"), /\.\./);
});

test("assertSafeSubdir rejects absolute paths", () => {
  assert.throws(() => assertSafeSubdir("/etc/passwd"), /relative/);
});
