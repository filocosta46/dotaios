import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  heartbeatPlistPath,
  heartbeatUnitDir,
  dotaiosDir
} from "../../../core/src/paths.mjs";

const LABEL = "io.dotaios.sync";
const INTERVAL_SEC = 300;

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderLaunchAgentPlist({ label, binary, args, intervalSec, stdoutPath, stderrPath }) {
  const argsXml = [binary, ...args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>StartInterval</key>
  <integer>${intervalSec}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stderr }));
    child.on("error", (err) => resolve({ code: -1, stderr: err.message }));
  });
}

export async function installMacHeartbeat({
  binary,
  plistPath = heartbeatPlistPath(),
  logsDir = path.join(dotaiosDir(), "logs"),
  exec = runCmd
} = {}) {
  await ensureDir(path.dirname(plistPath));
  await ensureDir(logsDir);
  const plist = renderLaunchAgentPlist({
    label: LABEL,
    binary,
    args: ["sync", "tick"],
    intervalSec: INTERVAL_SEC,
    stdoutPath: path.join(logsDir, "sync.out.log"),
    stderrPath: path.join(logsDir, "sync.err.log")
  });
  await fs.writeFile(plistPath, plist);
  // bootstrap (load); a non-zero exit when the agent is ALREADY loaded
  // (re-running setup) is benign — launchctl signals this with exit code 5
  // and/or an "already" message that varies by macOS version. Any other
  // non-zero code means the heartbeat never loaded and must fail loudly.
  const result = await exec("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
  if (result.code !== 0) {
    const alreadyLoaded = result.code === 5 || /already/i.test(result.stderr || "");
    if (!alreadyLoaded) {
      throw new Error(`launchctl bootstrap failed (code ${result.code}): ${(result.stderr || "").trim()}`);
    }
  }
}

export async function removeMacHeartbeat({
  plistPath = heartbeatPlistPath(),
  exec = runCmd
} = {}) {
  // bootout failure is intentionally ignored: removal is best-effort
  // (an agent that was never loaded returns non-zero, and the user is
  // tearing sync down regardless). The plist file removal below is
  // unconditional so the unit never lingers on disk.
  await exec("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath]);
  await fs.rm(plistPath, { force: true });
}

// Stubs filled in by Tasks 9 and 10
export async function installLinuxHeartbeat() {
  throw new Error("not implemented yet");
}
export async function removeLinuxHeartbeat() {
  throw new Error("not implemented yet");
}
export async function installWindowsHeartbeat() {
  throw new Error("not implemented yet");
}
export async function removeWindowsHeartbeat() {
  throw new Error("not implemented yet");
}

export async function installHeartbeat({ binary }) {
  if (process.platform === "darwin") return installMacHeartbeat({ binary });
  if (process.platform === "linux") return installLinuxHeartbeat({ binary });
  if (process.platform === "win32") return installWindowsHeartbeat({ binary });
  throw new Error(`unsupported platform: ${process.platform}`);
}

export async function removeHeartbeat() {
  if (process.platform === "darwin") return removeMacHeartbeat();
  if (process.platform === "linux") return removeLinuxHeartbeat();
  if (process.platform === "win32") return removeWindowsHeartbeat();
  throw new Error(`unsupported platform: ${process.platform}`);
}
