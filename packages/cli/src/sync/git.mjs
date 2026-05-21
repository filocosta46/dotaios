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

export function createGit({ cwd, spawnImpl = defaultSpawn, env = process.env } = {}) {
  function run(args) {
    return spawnImpl("git", args, { cwd, env });
  }

  return {
    async dirty() {
      const { stdout } = await run(["status", "--porcelain"]);
      return stdout.trim().length > 0;
    },

    async commitAll(message) {
      await run(["add", "-A"]);
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
      const { code, stderr } = await run(["push", "origin", branch]);
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
