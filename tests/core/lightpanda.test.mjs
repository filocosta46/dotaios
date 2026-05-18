import test from "node:test";
import assert from "node:assert/strict";
import { lightpandaPlatformBinary } from "../../packages/core/src/lightpanda.mjs";

test("lightpandaPlatformBinary maps darwin+arm64 to aarch64-macos", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "darwin", arch: "arm64" }), "lightpanda-aarch64-macos");
});

test("lightpandaPlatformBinary maps darwin+x64 to x86_64-macos", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "darwin", arch: "x64" }), "lightpanda-x86_64-macos");
});

test("lightpandaPlatformBinary maps linux+arm64 to aarch64-linux", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "linux", arch: "arm64" }), "lightpanda-aarch64-linux");
});

test("lightpandaPlatformBinary maps linux+x64 to x86_64-linux", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "linux", arch: "x64" }), "lightpanda-x86_64-linux");
});

test("lightpandaPlatformBinary returns null on win32", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "win32", arch: "x64" }), null);
});

test("lightpandaPlatformBinary returns null on unknown platform/arch", () => {
  assert.equal(lightpandaPlatformBinary({ platform: "linux", arch: "ppc64" }), null);
  assert.equal(lightpandaPlatformBinary({ platform: "freebsd", arch: "x64" }), null);
});

test("lightpandaPlatformBinary defaults to current process when no arg", () => {
  const out = lightpandaPlatformBinary();
  if (process.platform === "win32") assert.equal(out, null);
  else assert.match(out, /^lightpanda-/);
});
