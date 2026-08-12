import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";

export const GWS_READ_ONLY_SERVICES = Object.freeze(["gmail", "calendar", "drive"]);
export const GWS_READ_ONLY_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly"
]);

export function gwsReadOnlyLoginArgs() {
  return ["--readonly", "--services", GWS_READ_ONLY_SERVICES.join(",")];
}

export function gwsReadOnlyLoginCommand() {
  return ["gws", "auth", "login", ...gwsReadOnlyLoginArgs()].join(" ");
}

export function safeGwsVersion(value = "") {
  const match = String(value).match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] || null;
}

export function resolveAiosTarget(value) {
  return path.resolve(expandHome(value || defaultAiosPath()));
}

export async function assertAiosFolder(target) {
  try {
    await fs.access(path.join(target, "aios.json"));
  } catch {
    throw new Error(`No AIOS folder found at ${target}. Run dotaios init first, or pass --path.`);
  }
}

export async function resolveGwsBinary(explicitPath) {
  if (explicitPath) {
    return await isExecutable(explicitPath) ? path.resolve(expandHome(explicitPath)) : null;
  }

  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "gws");
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

export async function resolveBinary(name) {
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

export async function hasGoogleConnection(target) {
  try {
    await fs.access(path.join(target, "connections", "apis", "google-workspace.md"));
    return true;
  } catch {
    return false;
  }
}

export function runGws(gwsBin, args) {
  return spawnSync(gwsBin, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 15000
  });
}

export function printCaptured(result) {
  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  if (stdout) console.log(stdout);
  if (stderr) console.log(stderr);
}

export function firstLine(value = "") {
  return value.trim().split("\n").find(Boolean) || "";
}

export function assessGwsAuth(result) {
  if (result.status !== 0) {
    return {
      ready: false,
      summary: firstLine(result.stderr) || firstLine(result.stdout) || "gws auth status failed"
    };
  }

  const details = parseJsonObject(result.stdout);
  if (details) {
    if (details.encryption_error || details.encryption_valid === false) {
      return {
        ready: false,
        summary: details.encryption_error || "gws credentials could not be decrypted"
      };
    }

    if (details.client_config_exists === false) {
      return {
        ready: false,
        summary: "gws client config is missing"
      };
    }

    if (
      details.encrypted_credentials_exists === false &&
      details.plain_credentials_exists === false &&
      details.token_cache_exists === false
    ) {
      return {
        ready: false,
        summary: "gws credentials are missing"
      };
    }

    return {
      ready: true,
      summary: `auth_method: ${details.auth_method || "unknown"}`
    };
  }

  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  if (text.includes("not authenticated")) {
    return { ready: false, summary: "gws is not authenticated" };
  }

  return {
    ready: true,
    summary: firstLine(result.stdout) || "gws auth status ok"
  };
}

function parseJsonObject(value = "") {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function isExecutable(filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
