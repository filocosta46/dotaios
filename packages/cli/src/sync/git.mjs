import { spawn } from "node:child_process";

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
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$DOTAIOS_SYNC_TOKEN"; }; f';

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

// Git records a directory that contains its own `.git` as a *gitlink* — index
// mode 160000, a bare commit pointer — and it does so with a warning on stderr
// and an exit code of 0. Nothing about that is visible to a caller that only
// checks the exit code, so the commit succeeds, the push succeeds, and a clone
// of the mirror contains an empty directory where the user's project should be.
// Worse, `git status` is then clean, so no later run can notice either.
//
// Parse `git ls-files -s` ("<mode> <object> <stage>\t<path>") and report every
// gitlink so the caller can refuse before anything is committed.
export function findGitlinks(lsFilesStdout) {
  if (!lsFilesStdout) return [];
  const paths = [];
  for (const line of lsFilesStdout.split("\n")) {
    if (!line.startsWith("160000 ")) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const path = line.slice(tab + 1).trim();
    if (path) paths.push(path);
  }
  return paths;
}

export function nestedRepoMessage(paths) {
  const list = paths.map((p) => `  ${p}`).join("\n");
  return [
    paths.length === 1
      ? "Cannot sync: a project inside your AIOS folder has its own Git repository."
      : "Cannot sync: some projects inside your AIOS folder have their own Git repository.",
    "",
    list,
    "",
    "Git would store only a pointer, not the files. The push would look like it",
    "worked while none of that code actually reached the mirror — and a copy of",
    "your folder on another machine would find those directories empty.",
    "",
    "Nothing was committed. Your files have not been changed.",
    "",
    "Move the project outside your AIOS folder and register it instead:",
    "  dotaios project add <path-to-project>",
    "",
    "The project keeps its own Git history and its own remote; DotAIOS records",
    "where it lives so it can be restored on your other machines."
  ].join("\n");
}

export function createGit({ cwd, spawnImpl = defaultSpawn, env = process.env, accessToken = null } = {}) {
  const gitEnv = accessToken
    ? { ...env, ...SYNC_GIT_IDENTITY, DOTAIOS_SYNC_TOKEN: accessToken }
    : { ...env, ...SYNC_GIT_IDENTITY };
  // Authenticate network ops via the inline helper instead of a token-in-URL
  // remote. Empty-then-set clears any inherited global helper first.
  const credArgs = accessToken
    ? ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`]
    : [];

  function run(args) {
    return spawnImpl("git", args, { cwd, env: gitEnv });
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
    async currentBranch() {
      const { code, stdout } = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (code !== 0) return null;
      const branch = stdout.trim();
      return branch || null;
    },

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
      // `git add` exits 0 for a nested repository, so the exit code above proves
      // nothing about what actually landed in the index. Inspect the index
      // itself before any commit can be built from it.
      const indexed = await run(["ls-files", "-s"]);
      const gitlinks = findGitlinks(indexed.stdout);
      if (gitlinks.length > 0) {
        // Unstage only what we just staged, returning the index to the state we
        // found it in. `git rm --cached` is not usable here: it errors when the
        // staged content differs from HEAD.
        await run(["reset", "--quiet", "--", ...paths]);
        throw new Error(nestedRepoMessage(gitlinks));
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
      // The tick guard ensures this is the exact local main checkout, so the
      // checked-out HEAD is the one mirrored by this push.
      await ensurePlainRemote();
      const { code, stderr } = await run([...credArgs, "push", "origin", `HEAD:${branch}`]);
      if (code !== 0) throw new Error(`git push failed: ${redactToken(stderr.trim())}`);
    },

    async fetch() {
      await ensurePlainRemote();
      const { code, stderr } = await run([...credArgs, "fetch", "origin"]);
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
      await ensurePlainRemote();
      const { code, stdout, stderr } = await run([...credArgs, "ls-remote", "origin", ref]);
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
