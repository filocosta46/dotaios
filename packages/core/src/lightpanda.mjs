const PLATFORM_BINARIES = {
  "darwin:arm64": "lightpanda-aarch64-macos",
  "darwin:x64": "lightpanda-x86_64-macos",
  "linux:arm64": "lightpanda-aarch64-linux",
  "linux:x64": "lightpanda-x86_64-linux"
};

export function lightpandaPlatformBinary({ platform = process.platform, arch = process.arch } = {}) {
  return PLATFORM_BINARIES[`${platform}:${arch}`] ?? null;
}
