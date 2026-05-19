import { spawn } from "node:child_process";

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
        throw new Error(`git commit failed: ${commit.stderr.trim()}`);
      }
      const sha = await run(["rev-parse", "HEAD"]);
      return sha.stdout.trim();
    },

    async push(branch = "main") {
      const { code, stderr } = await run(["push", "origin", branch]);
      if (code !== 0) throw new Error(`git push failed: ${stderr.trim()}`);
    },

    async fetch() {
      const { code, stderr } = await run(["fetch", "origin"]);
      if (code !== 0) throw new Error(`git fetch failed: ${stderr.trim()}`);
    },

    async ffPull(branch = "main") {
      await this.fetch();
      const ahead = parseInt((await run(["rev-list", "--count", `HEAD..origin/${branch}`])).stdout.trim(), 10);
      if (ahead === 0) return "up-to-date";
      const behind = parseInt((await run(["rev-list", "--count", `origin/${branch}..HEAD`])).stdout.trim(), 10);
      if (behind > 0) return "diverged";
      const { code, stderr } = await run(["merge", "--ff-only", `origin/${branch}`]);
      if (code !== 0) throw new Error(`ff merge failed: ${stderr.trim()}`);
      return "fast-forwarded";
    },

    async currentSha() {
      return (await run(["rev-parse", "HEAD"])).stdout.trim();
    },

    async branchFromSha(branchName, sha) {
      const { code, stderr } = await run(["branch", branchName, sha]);
      if (code !== 0) throw new Error(`git branch failed: ${stderr.trim()}`);
    },

    async hardResetToOrigin(branch = "main") {
      const { code, stderr } = await run(["reset", "--hard", `origin/${branch}`]);
      if (code !== 0) throw new Error(`git reset failed: ${stderr.trim()}`);
    },

    async init() {
      const { code, stderr } = await run(["init", "-b", "main"]);
      if (code !== 0) throw new Error(`git init failed: ${stderr.trim()}`);
    },

    async addRemote(url) {
      // idempotent: remove first if exists
      await run(["remote", "remove", "origin"]); // ignore exit code
      const { code, stderr } = await run(["remote", "add", "origin", url]);
      if (code !== 0) throw new Error(`git remote add failed: ${stderr.trim()}`);
    },

    raw: run
  };
}
