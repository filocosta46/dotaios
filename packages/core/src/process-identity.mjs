import { spawnSync } from "node:child_process";

/** Return a stable OS-reported birth token for a live process when available. */
export function processBirthToken(pid, {
  platform = process.platform,
  spawn = spawnSync
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const [command, args] = platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')`
          ]
        ]
      : ["ps", ["-o", "lstart=", "-p", String(pid)]];
    const result = spawn(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000
    });
    const token = result?.status === 0 ? String(result.stdout || "").trim() : "";
    return token && token.length <= 256 ? token : null;
  } catch {
    return null;
  }
}

/**
 * A PID alone is not an identity because operating systems reuse it. When a
 * record has a birth token, require the current process with that PID to have
 * the same token. If the platform cannot read birth time, fail closed and
 * continue treating a demonstrably live PID as the owner.
 */
export function processRecordIsAlive(record, {
  kill = process.kill.bind(process),
  readBirthToken = processBirthToken
} = {}) {
  const pid = record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
  }
  if (typeof record.process_started_at === "string" && record.process_started_at) {
    const current = readBirthToken(pid);
    if (current && current !== record.process_started_at) return false;
  }
  return true;
}
