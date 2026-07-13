import { spawn } from "node:child_process";

// Strip an embedded credential (https://x-access-token:TOKEN@host) from any
// string before it reaches an error message or log. git echoes the full
// remote URL on auth/network failures.
function redactToken(text) {
  return String(text).replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

function defaultSpawn(cmd, args, opts) {
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

export function createGit({ cwd, spawnImpl = defaultSpawn, env = process.env } = {}) {
  const gitEnv = { ...env, ...SYNC_GIT_IDENTITY };
  function run(args) {
    return spawnImpl("git", args, { cwd, env: gitEnv });
  }

  return {
    async dirty() {
      const { stdout } = await run(["status", "--porcelain"]);
      return stdout.trim().length > 0;
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
      const addResult = await run(["add", "--", ...paths]);
      if (addResult.code !== 0) {
        throw new Error(`git add failed: ${redactToken(addResult.stderr.trim())}`);
      }
      const staged = await run(["diff", "--cached", "--quiet"]);
      if (staged.code === 0) return null;
      const commit = await run(["commit", "-m", message]);
      if (commit.code !== 0) {
        throw new Error(`git commit failed: ${redactToken(commit.stderr.trim())}`);
      }
      const sha = await run(["rev-parse", "HEAD"]);
      return sha.stdout.trim();
    },

    async push(branch = "main") {
      // Push the checked-out commit, not a possibly unrelated local branch.
      // Sync can run from a feature branch in a developer checkout; `git push
      // origin main` would silently push the local main ref and leave HEAD
      // unmirrored while the status record claims success.
      const { code, stderr } = await run(["push", "origin", `HEAD:${branch}`]);
      if (code !== 0) throw new Error(`git push failed: ${redactToken(stderr.trim())}`);
    },

    async fetch() {
      const { code, stderr } = await run(["fetch", "origin"]);
      if (code !== 0) throw new Error(`git fetch failed: ${redactToken(stderr.trim())}`);
    },

    // Pull by rebasing local commits on top of origin. Local changes must be
    // committed before calling this — rebase refuses to run on a dirty tree.
    // Returns "up-to-date" (origin had nothing new), "rebased" (local commits
    // replayed cleanly on top of origin), or "conflict" (a real same-file
    // clash — the failed rebase is aborted so the tree is left untouched and
    // the caller falls back to the branch-and-reset escape hatch).
    async pullRebase(branch = "main") {
      await this.fetch();
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

    async branchFromSha(branchName, sha) {
      const { code, stderr } = await run(["branch", branchName, sha]);
      if (code !== 0) throw new Error(`git branch failed: ${redactToken(stderr.trim())}`);
    },

    async hardResetToOrigin(branch = "main") {
      const { code, stderr } = await run(["reset", "--hard", `origin/${branch}`]);
      if (code !== 0) throw new Error(`git reset failed: ${redactToken(stderr.trim())}`);
    },

    async init() {
      const { code, stderr } = await run(["init", "-b", "main"]);
      if (code !== 0) throw new Error(`git init failed: ${redactToken(stderr.trim())}`);
    },

    async addRemote(url) {
      // idempotent: remove first if exists
      await run(["remote", "remove", "origin"]); // ignore exit code
      const { code, stderr } = await run(["remote", "add", "origin", url]);
      if (code !== 0) throw new Error(`git remote add failed: ${redactToken(stderr.trim())}`);
    },

    raw: run
  };
}
