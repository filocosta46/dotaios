import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lightpandaPlatformBinary, downloadLightpanda } from "../../packages/core/src/lightpanda.mjs";

function makeFakeFetch({ status = 200, body = "FAKE_BINARY_BYTES" } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "ERR",
    arrayBuffer: async () => new TextEncoder().encode(body).buffer
  });
}

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

test("downloadLightpanda writes binary to destBinPath and chmods +x on unix", { skip: process.platform === "win32" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      silent: true,
      fetchImpl: makeFakeFetch({ body: "BINARY" }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });
    assert.equal(result.ok, true);
    const written = await fs.readFile(destBinPath, "utf8");
    assert.equal(written, "BINARY");
    const stat = await fs.stat(destBinPath);
    assert.ok((stat.mode & 0o111) !== 0, "executable bit should be set");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason } on HTTP error without throwing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      silent: true,
      fetchImpl: makeFakeFetch({ status: 404 }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /404/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason } on network error without throwing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      silent: true,
      fetchImpl: async () => { throw new Error("ECONNRESET"); },
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ECONNRESET/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason:'unsupported-platform' } when platformBinary null", async () => {
  const result = await downloadLightpanda({
    silent: true,
    fetchImpl: makeFakeFetch(),
    destBinPath: path.join(os.tmpdir(), "noop"),
    platformBinary: null
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-platform");
});
