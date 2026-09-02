import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { classifyProjectRemote } from "./project-workspaces.mjs";

const execFileAsync = promisify(execFile);
const GIT_INSPECTION_TIMEOUT_MS = 5000;
const SAFE_LOCAL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

/** Read one authoritative local Git remote without consulting inherited Git config. */
export async function inspectAuthoritativeProjectRemote(projectPath, options = {}) {
  const runGit = options.execFileAsync || execFileAsync;
  let origin;
  try {
    origin = await readLocalFetchRemote(projectPath, "origin", runGit);
  } catch (error) {
    if (!await proveNonGitDirectory(projectPath, runGit)) throw error;
    return null;
  }
  let remote = origin.url;
  if (!origin.present) {
    const rawFetchKeys = await gitConfig(
      projectPath,
      ["config", "--local", "--no-includes", "--name-only", "--get-regexp", "^remote\\..*\\.fetch$"],
      runGit
    );
    const remotes = [...new Set(String(rawFetchKeys || "")
      .split(/\r?\n/)
      .map((value) => /^remote\.(.+)\.fetch$/.exec(value.trim())?.[1] || null)
      .filter((value) => value && value !== "origin"))];
    if (remotes.length === 0) return null;
    if (remotes.length !== 1 || !SAFE_LOCAL_NAME_RE.test(remotes[0])) {
      throw new Error("A unique authoritative local Git remote is required.");
    }
    const fallback = await readLocalFetchRemote(projectPath, remotes[0], runGit);
    if (!fallback.present || !fallback.url) {
      throw new Error("A unique authoritative local Git remote is required.");
    }
    remote = fallback.url;
  }
  if (!remote) throw new Error("The authoritative local Git remote is incomplete.");
  const classified = classifyProjectRemote(remote);
  if (!classified.safe) throw new Error("The live local Git remote is unsafe.");
  return classified.canonicalUrl;
}

async function readLocalFetchRemote(projectPath, remoteName, runGit) {
  if (!SAFE_LOCAL_NAME_RE.test(remoteName)) return { present: false, url: null };
  const escapedName = remoteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rawConfig = await gitConfig(
    projectPath,
    [
      "config", "--local", "--no-includes", "--null", "--get-regexp",
      `^remote\\.${escapedName}\\.(url|fetch)$`
    ],
    runGit
  );
  const { urls, fetches } = remoteConfigValues(rawConfig, remoteName);
  const present = urls.length > 0 || fetches.length > 0;
  if (!present) return { present: false, url: null };
  if (urls.length !== 1 || !fetches.some(safeFetchRefspec)) {
    throw new Error("The authoritative local Git remote is incomplete.");
  }
  return { present: true, url: urls[0] };
}

function remoteConfigValues(value, remoteName) {
  const urls = [];
  const fetches = [];
  for (const record of String(value || "").split("\0")) {
    const separator = record.indexOf("\n");
    if (separator < 0) continue;
    const key = record.slice(0, separator);
    const configValue = record.slice(separator + 1).trim();
    if (!configValue) continue;
    if (key === `remote.${remoteName}.url`) urls.push(configValue);
    else if (key === `remote.${remoteName}.fetch`) fetches.push(configValue);
  }
  return { urls, fetches };
}

function safeFetchRefspec(value) {
  return value.length <= 2048
    && !/[\p{Cc}\uD800-\uDFFF]/u.test(value)
    && /^\+?refs\/[^:\s]+(?::refs\/[^\s]+)?$/.test(value);
}

async function gitConfig(projectPath, args, runGit) {
  try {
    const { stdout, stderr } = await runGit(
      "git",
      ["-C", projectPath, ...args],
      {
        encoding: "utf8",
        env: sanitizedGitEnvironment(),
        timeout: GIT_INSPECTION_TIMEOUT_MS,
        killSignal: "SIGTERM"
      }
    );
    const value = String(stdout || "").trim();
    if (!value || String(stderr || "").trim() !== "") {
      throw new Error("Local Git inspection returned an invalid success result.");
    }
    return value;
  } catch (error) {
    if (
      error?.code === 1
      && error?.killed !== true
      && error?.signal == null
      && String(error?.stdout || "").trim() === ""
      && String(error?.stderr || "").trim() === ""
    ) return null;
    throw error;
  }
}

async function proveNonGitDirectory(projectPath, runGit) {
  try {
    const { stdout, stderr } = await runGit(
      "git",
      ["-C", projectPath, "rev-parse", "--is-inside-work-tree"],
      {
        encoding: "utf8",
        env: sanitizedGitEnvironment(),
        timeout: GIT_INSPECTION_TIMEOUT_MS,
        killSignal: "SIGTERM"
      }
    );
    const state = String(stdout || "").trim();
    if ((state === "true" || state === "false") && String(stderr || "").trim() === "") {
      return false;
    }
    throw new Error("Local Git repository probe returned an invalid success result.");
  } catch (error) {
    if (
      error?.code === 128
      && error?.killed !== true
      && error?.signal == null
      && String(error?.stdout || "").trim() === ""
      && /^fatal: not a git repository \(or any of the parent directories\): \.git$/u.test(
        String(error?.stderr || "").trim()
      )
    ) return true;
    throw error;
  }
}

function sanitizedGitEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
    ),
    LANG: "C",
    LANGUAGE: "C",
    LC_ALL: "C"
  };
}
