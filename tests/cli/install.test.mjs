import test from "node:test";
import assert from "node:assert/strict";
import { assertLocalInstallSource, assertSafeSubdir } from "../../packages/cli/src/commands/install.mjs";

test("remote plugin sources are refused before any clone or install", () => {
  const remoteSources = [
    "http://example.com/plugin",
    "https://github.com/example/plugin",
    "https://github.com/example/plugin.git",
    "ssh://git@example.com/owner/plugin.git",
    "git+ssh://git@example.com/owner/plugin.git",
    "git://example.com/plugin.git",
    "ftp://example.com/plugin",
    "file:///tmp/plugin",
    "git@example.com:owner/plugin.git"
  ];
  for (const source of remoteSources) {
    assert.throws(
      () => assertLocalInstallSource(source),
      /download or clone it yourself.*inspect.*local folder/i,
      `${source} must be refused before any remote operation`
    );
  }
  assert.doesNotThrow(() => assertLocalInstallSource("./reviewed-plugin"));
});

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
