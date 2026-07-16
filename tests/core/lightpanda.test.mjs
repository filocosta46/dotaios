import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { lightpandaPlatformBinary, downloadLightpanda, resolveLightpanda } from "../../packages/core/src/lightpanda.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

test("downloadLightpanda atomically installs a verified binary and chmods +x on unix", { skip: process.platform === "win32" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-dl-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  try {
    const result = await downloadLightpanda({
      fetchImpl: makeFakeFetch({ body: "BINARY" }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux",
      confirmed: true,
      expectedSha256: sha256("BINARY")
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
      fetchImpl: makeFakeFetch({ status: 404 }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux",
      confirmed: true
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
      fetchImpl: async () => { throw new Error("ECONNRESET"); },
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux",
      confirmed: true
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ECONNRESET/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda returns { ok:false, reason:'unsupported-platform' } when platformBinary null", async () => {
  const result = await downloadLightpanda({
    fetchImpl: makeFakeFetch(),
    destBinPath: path.join(os.tmpdir(), "noop"),
    platformBinary: null
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported-platform");
});

test("downloadLightpanda does not fetch without explicit confirmation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-consent-"));
  const destBinPath = path.join(tmp, "bin", "lightpanda");
  let fetched = false;
  try {
    const result = await downloadLightpanda({
      fetchImpl: async () => {
        fetched = true;
        return makeFakeFetch()();
      },
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux"
    });

    assert.deepEqual(result, { ok: false, reason: "confirmation-required" });
    assert.equal(fetched, false);
    await assert.rejects(() => fs.access(destBinPath));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("downloadLightpanda rejects a bad checksum without replacing the destination or leaving a temp file", { skip: process.platform === "win32" }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-checksum-"));
  const destDir = path.join(tmp, "bin");
  const destBinPath = path.join(destDir, "lightpanda");
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(destBinPath, "ORIGINAL", { mode: 0o600 });

  try {
    const result = await downloadLightpanda({
      fetchImpl: makeFakeFetch({ body: "TAMPERED" }),
      destBinPath,
      platformBinary: "lightpanda-x86_64-linux",
      force: true,
      confirmed: true,
      expectedSha256: sha256("EXPECTED")
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "checksum-mismatch");
    assert.equal(await fs.readFile(destBinPath, "utf8"), "ORIGINAL");
    const stat = await fs.stat(destBinPath);
    assert.equal(stat.mode & 0o111, 0, "unverified destination must not become executable");
    assert.deepEqual(await fs.readdir(destDir), ["lightpanda"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveLightpanda returns local bin path when it exists and is executable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-lp-res-"));
  const localBin = path.join(tmp, "lightpanda");
  await fs.writeFile(localBin, "#!/bin/sh\necho fake");
  await fs.chmod(localBin, 0o755);
  try {
    const result = await resolveLightpanda({
      localBinPath: localBin,
      whichImpl: () => null
    });
    assert.equal(result, localBin);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("resolveLightpanda falls back to PATH when local missing", async () => {
  const result = await resolveLightpanda({
    localBinPath: "/nonexistent/lightpanda",
    whichImpl: () => "/usr/local/bin/lightpanda"
  });
  assert.equal(result, "/usr/local/bin/lightpanda");
});

test("resolveLightpanda returns null when neither local nor PATH has it", async () => {
  const result = await resolveLightpanda({
    localBinPath: "/nonexistent/lightpanda",
    whichImpl: () => null
  });
  assert.equal(result, null);
});
