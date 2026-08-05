import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectCatalog } from "../../../core/src/projects.mjs";
import {
  assertMirrorContentSafe,
  nestedRepoMessage
} from "./mirror-content-policy.mjs";

export { nestedRepoMessage } from "./mirror-content-policy.mjs";

// Strip an embedded credential (https://x-access-token:TOKEN@host) from any
// string before it reaches an error message or log. git echoes the full
// remote URL on auth/network failures.
function redactToken(text) {
  return String(text).replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

// Remove any embedded credential from a remote URL, leaving the plain https URL.
export function stripEmbeddedCredential(url) {
  return String(url).replace(/\/\/[^@/]+@/, "//");
}

// Per-invocation credential helper: git calls it with the operation ("get")
// and we answer from an env var. Passed via `-c` so it NEVER persists in
// .git/config, and the token travels in the environment, never in argv or on
// disk. An empty helper first clears any inherited global helper.
const CREDENTIAL_HELPER =
  '!f() { ' +
  'test "$1" = get || exit 0; ' +
  'protocol= host= path=; ' +
  'while IFS= read -r line; do ' +
  'case "$line" in ' +
  'protocol=*) protocol=${line#protocol=} ;; ' +
  'host=*) host=${line#host=} ;; ' +
  'path=*) path=${line#path=} ;; ' +
  'esac; ' +
  'done; ' +
  'test "$protocol" = https || exit 0; ' +
  'test "$host" = github.com || exit 0; ' +
  'test "$path" = "$DOTAIOS_SYNC_REPO_PATH" || exit 0; ' +
  'printf "username=x-access-token\\npassword=%s\\n" "$DOTAIOS_SYNC_TOKEN"; ' +
  '}; f "$@"';

export function defaultSpawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// A non-technical user's machine often has no global git identity. Without one
// `git commit` (and `git rebase`) fail with "Author identity unknown". Stamp a
// DotAIOS identity into every git invocation so sync never depends on the
// user's global git config. These env vars override user.name/user.email.
const SYNC_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "DotAIOS Sync",
  GIT_AUTHOR_EMAIL: "sync@dotaios.local",
  GIT_COMMITTER_NAME: "DotAIOS Sync",
  GIT_COMMITTER_EMAIL: "sync@dotaios.local"
};

// Parse `git status --porcelain -z` output into the list of paths to stage.
// Each entry is "XY <path>" NUL-separated; renames/copies (X = R or C) carry a
// second NUL-separated field with the source path, which we drop — staging the
// destination path is enough for git to record the rename. Empty input -> [].
export function parsePorcelainZ(stdout) {
  if (!stdout) return [];
  const fields = stdout.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    paths.push(path);
    const code = status[0];
    // R/C entries are followed by the original path in its own NUL field.
    if (code === "R" || code === "C") i += 1;
  }
  return paths;
}

const MIRROR_HOOKS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "hooks");

export function sanitizedGitEnvironment(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_") && key !== "DOTAIOS_SYNC_TOKEN") clean[key] = value;
  }
  return { ...clean, ...SYNC_GIT_IDENTITY };
}

export function parseUrlRewriteRules(output) {
  return String(output || "").split("\0").flatMap((entry) => {
    if (!entry) return [];
    const newline = entry.indexOf("\n");
    if (newline === -1) return [];
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1);
    const match = key.match(/^url\.(.*)\.(insteadof|pushinsteadof)$/i);
    return match && value
      ? [{ replacement: match[1], prefix: value, kind: match[2].toLowerCase() }]
      : [];
  });
}

export function rewrittenDestination(destination, operation, rules) {
  const preferredKind = operation === "push" ? "pushinsteadof" : "insteadof";
  let candidates = rules.filter((rule) => rule.kind === preferredKind && destination.startsWith(rule.prefix));
  if (operation === "push" && candidates.length === 0) {
    candidates = rules.filter((rule) => rule.kind === "insteadof" && destination.startsWith(rule.prefix));
  }
  if (candidates.length === 0) return destination;
  const longest = Math.max(...candidates.map((rule) => rule.prefix.length));
  const effective = new Set(candidates
    .filter((rule) => rule.prefix.length === longest)
    .map((rule) => rule.replacement + destination.slice(rule.prefix.length)));
  return effective.size === 1 ? [...effective][0] : null;
}

export function createGit({
  cwd,
  spawnImpl = defaultSpawn,
  env = process.env,
  accessToken = null,
  expectedRepoFullName = null,
  filesystem = fs
} = {}) {
  const gitEnv = sanitizedGitEnvironment(env);
  // Authenticate network ops via the inline helper instead of a token-in-URL
  // remote. Empty-then-set clears any inherited global helper first.
  const credArgs = accessToken
    ? [
        "-c", "credential.helper=",
        "-c", "credential.useHttpPath=true",
        "-c", `credential.helper=${CREDENTIAL_HELPER}`
      ]
    : [];

  function run(args, { indexFile, credentialed = false } = {}) {
    const commandEnv = {
      ...gitEnv,
      ...(indexFile && { GIT_INDEX_FILE: indexFile }),
      ...(credentialed && accessToken && {
        DOTAIOS_SYNC_TOKEN: accessToken,
        DOTAIOS_SYNC_REPO_PATH: `${expectedRepoFullName}.git`
      })
    };
    return spawnImpl("git", args, { cwd, env: commandEnv });
  }

  function networkDestination() {
    if (!accessToken) return "origin";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepoFullName || "")) {
      throw new Error("sync repository identity is unavailable; refusing credentialed Git access");
    }
    return `https://github.com/${expectedRepoFullName}.git`;
  }

  async function readUrlRewriteRules() {
    const configured = await run([
      "config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"
    ]);
    if (configured.code !== 0 && configured.code !== 1) {
      throw new Error(
        `could not inspect effective Git configuration; refusing credentialed Git access: ${redactToken(configured.stderr.trim()) || `git config exited ${configured.code}`}`
      );
    }
    return parseUrlRewriteRules(configured.stdout);
  }

  async function preflightCredentialedNetwork(operation) {
    const destination = networkDestination();
    const effective = rewrittenDestination(destination, operation, await readUrlRewriteRules());
    if (effective !== destination) {
      throw new Error(
        `effective Git URL rewrite changes the ${operation} destination; refusing credentialed Git access before contacting the network`
      );
    }
    return destination;
  }

  async function runCredentialedNetwork(args) {
    const disabledHooksPath = await filesystem.mkdtemp(
      path.join(os.tmpdir(), "dotaios-disabled-hooks-")
    );
    try {
      return await run(
        [...credArgs, "-c", `core.hooksPath=${disabledHooksPath}`, ...args],
        { credentialed: true }
      );
    } finally {
      await filesystem.rm(disabledHooksPath, { recursive: true, force: true });
    }
  }

  // Heal a legacy token-embedded remote (older installs stored the credential
  // in the URL) down to the plain URL before any network op, so the token
  // stops living in .git/config. Local, cheap, idempotent.
  async function ensurePlainRemote() {
    if (!accessToken) return;
    const { code, stdout } = await run(["remote", "get-url", "origin"]);
    if (code !== 0) return;
    const current = stdout.trim();
    const plain = stripEmbeddedCredential(current);
    if (plain !== current) {
      await run(["remote", "set-url", "origin", plain]);
    }
  }

  return {
    async isRepositoryRoot() {
      const topLevel = await run(["rev-parse", "--show-toplevel"]);
      if (topLevel.code !== 0 || !topLevel.stdout.trim()) return false;
      try {
        const [actualRoot, expectedRoot] = await Promise.all([
          filesystem.realpath(topLevel.stdout.trim()),
          filesystem.realpath(cwd)
        ]);
        return actualRoot === expectedRoot;
      } catch {
        return false;
      }
    },

    async currentBranch() {
      const { code, stdout } = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (code !== 0) return null;
      const branch = stdout.trim();
      return branch || null;
    },

    async originUrl() {
      const { code, stdout, stderr } = await run(["remote", "get-url", "origin"]);
      if (code !== 0) {
        throw new Error(`could not read Git origin: ${redactToken(stderr.trim()) || `git remote exited ${code}`}`);
      }
      return stdout.trim();
    },

    async dirty() {
      const { stdout } = await run(["status", "--porcelain"]);
      return stdout.trim().length > 0;
    },

    async validateMirrorContent({ outerGit = true } = {}) {
      let workspacesRootIgnored = null;
      let indexedEntries = "";
      if (outerGit) {
        const ignored = await run(["check-ignore", "--no-index", "-q", "--", "workspaces/"]);
        if (ignored.code !== 0 && ignored.code !== 1) {
          throw new Error(
            `git ignore inspection failed: ${redactToken(ignored.stderr.trim()) || `git check-ignore exited ${ignored.code}`}`
          );
        }
        workspacesRootIgnored = ignored.code === 0;
        const indexed = await run(["ls-files", "-s", "-z"]);
        if (indexed.code !== 0) {
          throw new Error(
            `git index inspection failed: ${redactToken(indexed.stderr.trim()) || `git ls-files exited ${indexed.code}`}`
          );
        }
        indexedEntries = indexed.stdout;
      }
      const projectCatalog = await readProjectCatalog({ aiosPath: cwd, fs: filesystem });
      await assertMirrorContentSafe({
        root: cwd,
        changedPaths: [],
        indexedEntries,
        workspacesRootIgnored,
        inspectWholeTree: true,
        projectCatalog,
        inspectWorkspaceRepository: async (workspacePath) => {
          const [topLevel, head, origin] = await Promise.all([
            run(["-C", workspacePath, "rev-parse", "--show-toplevel"]),
            run(["-C", workspacePath, "rev-parse", "--verify", "HEAD"]),
            run(["-C", workspacePath, "remote", "get-url", "origin"])
          ]);
          return {
            topLevelPath: topLevel.code === 0 ? topLevel.stdout.trim() : null,
            head: head.code === 0 && /^[0-9a-f]{40,64}$/i.test(head.stdout.trim())
              ? head.stdout.trim()
              : null,
            remoteUrl: origin.code === 0 ? origin.stdout.trim() : null
          };
        },
        filesystem
      });
    },

    // Stage every changed path explicitly (never `git add -A`), then commit.
    // Enumerating the changed paths from `git status --porcelain -z` lets us add
    // each one by name, which keeps the commit surface explicit and lets a future
    // caller filter paths (skip large files, secrets, etc.). Deletions and
    // renames are staged by naming the destination path. Returns null when there
    // is nothing to commit.
    async commitAll(message) {
      const { stdout } = await run(["status", "--porcelain", "-z"]);
      const paths = parsePorcelainZ(stdout);
      if (paths.length === 0) return null;
      const indexed = await run(["ls-files", "-s", "-z"]);
      if (indexed.code !== 0) {
        throw new Error(
          `git index inspection failed: ${redactToken(indexed.stderr.trim()) || `git ls-files exited ${indexed.code}`}`
        );
      }
      await assertMirrorContentSafe({
        root: cwd,
        changedPaths: paths,
        indexedEntries: indexed.stdout,
        filesystem
      });
      const addResult = await run(["add", "--", ...paths]);
      if (addResult.code !== 0) {
        throw new Error(`git add failed: ${redactToken(addResult.stderr.trim())}`);
      }
      const commit = await run([
        "-c", `core.hooksPath=${MIRROR_HOOKS_PATH}`,
        "-c", "commit.gpgSign=false",
        "commit", "-a", "-m", message
      ]);
      if (commit.code !== 0) {
        throw new Error(`git commit failed: ${redactToken(commit.stderr.trim())}`);
      }
      const sha = await run(["rev-parse", "HEAD"]);
      if (sha.code !== 0 || !sha.stdout.trim()) {
        throw new Error(
          `git commit identity failed: ${redactToken(sha.stderr.trim()) || `git rev-parse exited ${sha.code}`}`
        );
      }
      return sha.stdout.trim();
    },

    async push(branch = "main") {
      // Push the checked-out commit, not a possibly unrelated local branch.
      // The tick guard ensures this is the exact local main checkout, so the
      // checked-out HEAD is the one mirrored by this push.
      const destination = accessToken
        ? await preflightCredentialedNetwork("push")
        : networkDestination();
      await ensurePlainRemote();
      const { code, stderr } = accessToken
        ? await runCredentialedNetwork(["push", destination, `HEAD:${branch}`])
        : await run(["push", destination, `HEAD:${branch}`]);
      if (code !== 0) throw new Error(`git push failed: ${redactToken(stderr.trim())}`);
    },

    async fetch(branch = "main") {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const destination = accessToken
        ? await preflightCredentialedNetwork("fetch")
        : networkDestination();
      await ensurePlainRemote();
      const fetchArgs = ["fetch", destination, `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
      const { code, stderr } = accessToken
        ? await runCredentialedNetwork(fetchArgs)
        : await run(["fetch", destination]);
      if (code !== 0) throw new Error(`git fetch failed: ${redactToken(stderr.trim())}`);
    },

    // Read the sync branch directly from the remote. This is deliberately
    // separate from fetch/rebase: `sync status` must be able to verify the
    // cached push receipt without changing the checkout or refs.
    async remoteHead(branch = "main") {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const ref = `refs/heads/${branch}`;
      const destination = accessToken
        ? await preflightCredentialedNetwork("fetch")
        : networkDestination();
      await ensurePlainRemote();
      const { code, stdout, stderr } = accessToken
        ? await runCredentialedNetwork(["ls-remote", destination, ref])
        : await run(["ls-remote", destination, ref]);
      if (code !== 0) {
        throw new Error(`git ls-remote failed: ${redactToken(stderr.trim())}`);
      }
      const [sha, returnedRef] = stdout.trim().split(/\s+/);
      if (!/^[0-9a-f]{40}$/i.test(sha || "") || returnedRef !== ref) {
        throw new Error("git ls-remote returned no valid sync branch ref");
      }
      return sha;
    },

    // Pull by rebasing local commits on top of origin. Local changes must be
    // committed before calling this — rebase refuses to run on a dirty tree.
    // Returns "up-to-date" (origin had nothing new), "rebased" (local commits
    // replayed cleanly on top of origin), or "conflict" (a real same-file
    // clash. The failed rebase is aborted so the tree is left untouched and
    // the caller can stop safely).
    async remoteState(branch = "main", { lastPushSha = null } = {}) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const destination = accessToken
        ? await preflightCredentialedNetwork("fetch")
        : networkDestination();
      await ensurePlainRemote();
      const result = accessToken
        ? await runCredentialedNetwork(["ls-remote", destination])
        : await run(["ls-remote", destination]);
      if (result.code !== 0) {
        throw new Error(`git ls-remote failed: ${redactToken(result.stderr.trim())}`);
      }
      const refs = result.stdout.split("\n").flatMap((line) => {
        const [sha, ref] = line.trim().split(/\s+/);
        return /^[0-9a-f]{40}$/i.test(sha || "") && ref ? [{ sha, ref }] : [];
      });
      const main = refs.find((entry) => entry.ref === `refs/heads/${branch}`);
      if (main) return { kind: "main-present", sha: main.sha };
      if (refs.length === 0 && !lastPushSha) return { kind: "never-pushed-empty" };
      return { kind: "unexpected-main-absent", refs: refs.map((entry) => entry.ref) };
    },

    async pullRebase(branch = "main", { lastPushSha = null } = {}) {
      const remote = await this.remoteState(branch, { lastPushSha });
      if (remote.kind === "never-pushed-empty") return "empty";
      if (remote.kind === "unexpected-main-absent") {
        throw new Error(
          remote.refs.length > 0
            ? `remote ${branch} is unexpectedly missing while other refs exist`
            : `remote ${branch} is unexpectedly missing after DotAIOS previously pushed it`
        );
      }
      await this.fetch(branch);
      const behind = parseInt(
        (await run(["rev-list", "--count", `HEAD..origin/${branch}`])).stdout.trim(),
        10
      );
      if (behind === 0) return "up-to-date";
      const rebase = await run(["rebase", `origin/${branch}`]);
      if (rebase.code !== 0) {
        // Abort so the working tree is restored to the pre-rebase state.
        // Best-effort: ignore the abort's own exit code.
        await run(["rebase", "--abort"]);
        return "conflict";
      }
      return "rebased";
    },

    async currentSha() {
      return (await run(["rev-parse", "HEAD"])).stdout.trim();
    },

    async isAncestor(ancestor, descendant = "HEAD") {
      if (!/^[0-9a-f]{40}$/i.test(ancestor || "")) {
        throw new Error("invalid Git commit receipt");
      }
      const result = await run(["merge-base", "--is-ancestor", ancestor, descendant]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new Error(
        `could not verify local Git ancestry: ${redactToken(result.stderr.trim()) || `git merge-base exited ${result.code}`}`
      );
    },

    async hasUnpushedCommits(branch = "main") {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) {
        throw new Error("invalid sync branch");
      }
      const result = await run(["rev-list", "--count", `origin/${branch}..HEAD`]);
      const count = Number.parseInt(result.stdout.trim(), 10);
      if (result.code !== 0 || !Number.isInteger(count) || count < 0) {
        throw new Error(
          `could not inspect unpushed Git commits: ${redactToken(result.stderr.trim()) || `git rev-list exited ${result.code}`}`
        );
      }
      return count > 0;
    },

    async init() {
      const { code, stderr } = await run(["init", "-b", "main"]);
      if (code !== 0) throw new Error(`git init failed: ${redactToken(stderr.trim())}`);
    },

    async addRemote(url) {
      // Never persist a credential in .git/config — store the plain URL and let
      // the inline credential helper authenticate network ops.
      const plain = stripEmbeddedCredential(url);
      // idempotent: remove first if exists
      await run(["remote", "remove", "origin"]); // ignore exit code
      const { code, stderr } = await run(["remote", "add", "origin", plain]);
      if (code !== 0) throw new Error(`git remote add failed: ${redactToken(stderr.trim())}`);
    },

    raw: run
  };
}
