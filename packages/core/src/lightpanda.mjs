import fs from "node:fs/promises";
import path from "node:path";
import { lightpandaBinPath } from "./paths.mjs";

const PLATFORM_BINARIES = {
  "darwin:arm64": "lightpanda-aarch64-macos",
  "darwin:x64": "lightpanda-x86_64-macos",
  "linux:arm64": "lightpanda-aarch64-linux",
  "linux:x64": "lightpanda-x86_64-linux"
};

export function lightpandaPlatformBinary({ platform = process.platform, arch = process.arch } = {}) {
  return PLATFORM_BINARIES[`${platform}:${arch}`] ?? null;
}

const RELEASE_BASE = "https://github.com/lightpanda-io/browser/releases/latest/download";

export async function downloadLightpanda({
  silent = false,
  fetchImpl = globalThis.fetch,
  destBinPath = lightpandaBinPath(),
  platformBinary = lightpandaPlatformBinary()
} = {}) {
  if (!platformBinary) {
    return { ok: false, reason: "unsupported-platform" };
  }

  const url = `${RELEASE_BASE}/${platformBinary}`;
  if (!silent) console.log(`⬇  Installing Lightpanda for web browsing...`);

  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText || ""}`.trim() };
    }
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(destBinPath), { recursive: true });
    await fs.writeFile(destBinPath, buf);
    if (process.platform !== "win32") {
      await fs.chmod(destBinPath, 0o755);
    }
    if (!silent) console.log(`   Installed Lightpanda → ${destBinPath}`);
    return { ok: true, path: destBinPath };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}
