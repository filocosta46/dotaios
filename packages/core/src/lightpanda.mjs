import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
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

const RELEASE_BASE = "https://github.com/lightpanda-io/browser/releases/latest/download";

export async function downloadLightpanda({
  silent = false,
  fetchImpl = globalThis.fetch,
  destBinPath = lightpandaBinPath(),
  platformBinary = lightpandaPlatformBinary(),
  force = false
} = {}) {
  if (!platformBinary) {
    return { ok: false, reason: "unsupported-platform" };
  }

  if (!force) {
    try {
      await fs.access(destBinPath, fs.constants.X_OK);
      if (!silent) console.log(`   Lightpanda already installed at ${destBinPath}`);
      return { ok: true, path: destBinPath, alreadyInstalled: true };
    } catch {
      // not present or not executable — proceed with download
    }
  }

  const url = `${RELEASE_BASE}/${platformBinary}`;
  if (!silent) console.log(`⬇  Installing Lightpanda for web browsing...`);

  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText || ""}`.trim() };
    }
    await fs.mkdir(path.dirname(destBinPath), { recursive: true });
    if (response.body && typeof response.body.getReader === "function") {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destBinPath));
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(destBinPath, buf);
    }
    if (process.platform !== "win32") {
      await fs.chmod(destBinPath, 0o755);
    }
    if (!silent) console.log(`   Installed Lightpanda → ${destBinPath}`);
    return { ok: true, path: destBinPath };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
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
