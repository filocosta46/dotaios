import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lightpandaBinPath } from "./paths.mjs";

const PLATFORM_BINARIES = Object.freeze({
  "darwin:arm64": "lightpanda-aarch64-macos",
  "darwin:x64": "lightpanda-x86_64-macos",
  "linux:arm64": "lightpanda-aarch64-linux",
  "linux:x64": "lightpanda-x86_64-linux"
});

export function lightpandaPlatformBinary({ platform = process.platform, arch = process.arch } = {}) {
  return PLATFORM_BINARIES[`${platform}:${arch}`] ?? null;
}

// Pinned to a stable tag. `releases/latest/download/` redirects to the
// `nightly` tag for this repo, which has historically shipped broken builds
// (silent startup hangs on macOS arm64). Bump intentionally after smoke test.
export const LIGHTPANDA_VERSION = "0.3.0";
const RELEASE_BASE = `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}`;
const LIGHTPANDA_SHA256 = Object.freeze({
  "lightpanda-aarch64-linux": "66b06ce2cc067437245934a0782d574691dee63ee1c2cdc7e949b2efce9764c0",
  "lightpanda-aarch64-macos": "4ca3897a1547c9b3b843a0a921c2b4d044afb3ad4914091a845ac608fe1cb047",
  "lightpanda-x86_64-linux": "256f8dcb45676c53c26a2e5a40a9a60d844feb387d7f43c20925982fa2be723a",
  "lightpanda-x86_64-macos": "8267ad21feff114619a60fd7b1cd23440f1d5e443a09aabdadb27c5179b0f347"
});

export function lightpandaExpectedSha256(platformBinary) {
  return LIGHTPANDA_SHA256[platformBinary] || null;
}

export async function downloadLightpanda({
  fetchImpl = globalThis.fetch,
  destBinPath = lightpandaBinPath(),
  platformBinary = lightpandaPlatformBinary(),
  force = false,
  confirmed = false,
  expectedSha256 = lightpandaExpectedSha256(platformBinary)
} = {}) {
  if (!platformBinary) {
    return { ok: false, reason: "unsupported-platform" };
  }

  if (!force) {
    try {
      await fs.access(destBinPath, fs.constants.X_OK);
      return { ok: true, path: destBinPath, alreadyInstalled: true };
    } catch {
      // A missing or non-executable destination may be replaced after consent.
    }
  }

  if (!confirmed) {
    return { ok: false, reason: "confirmation-required" };
  }

  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 || "")) {
    return { ok: false, reason: "missing-checksum" };
  }

  const url = `${RELEASE_BASE}/${platformBinary}`;
  const tempPath = path.join(
    path.dirname(destBinPath),
    `.${path.basename(destBinPath)}.${process.pid}.${randomUUID()}.download`
  );
  let installed = false;
  console.log(`Installing verified Lightpanda ${LIGHTPANDA_VERSION} for web browsing...`);

  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText || ""}`.trim() };
    }
    await fs.mkdir(path.dirname(destBinPath), { recursive: true });
    await writeDownloadToFile(response, tempPath);

    const actualSha256 = await sha256File(tempPath);
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      return {
        ok: false,
        reason: "checksum-mismatch",
        expectedSha256: expectedSha256.toLowerCase(),
        actualSha256
      };
    }

    if (process.platform !== "win32") {
      await fs.chmod(tempPath, 0o755);
    }
    await fs.rename(tempPath, destBinPath);
    installed = true;
    console.log(`Installed verified Lightpanda at ${destBinPath}`);
    return { ok: true, path: destBinPath };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  } finally {
    if (!installed) await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function writeDownloadToFile(response, filePath) {
  if (response.body && typeof response.body.getReader === "function") {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(filePath, { flags: "wx", mode: 0o600 })
    );
    return;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

let _cachedWhich = null;
function defaultWhich() {
  if (_cachedWhich !== null) return _cachedWhich || null;
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(cmd, ["lightpanda"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    _cachedWhich = "";
    return null;
  }
  const first = (result.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  _cachedWhich = first || "";
  return first || null;
}

export async function resolveLightpanda({
  localBinPath = lightpandaBinPath(),
  whichImpl = defaultWhich
} = {}) {
  try {
    await fs.access(localBinPath, fs.constants.X_OK);
    return localBinPath;
  } catch {
    // not present or not executable, try PATH
  }
  const fromPath = whichImpl();
  return fromPath || null;
}
