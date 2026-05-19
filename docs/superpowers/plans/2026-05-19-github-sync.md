# GitHub Sync — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dotaios sync` so a user's `~/aios/` folder mirrors to a private GitHub repo `<username>-aios`, lets phone-side agents (Claude Projects, Claude Code on web, Codex Web, Codex Mobile) read the same memory, and accepts phone-side writes into `memory/inbox/` without ever creating a merge conflict the user has to resolve.

**Architecture:** No long-running daemon. Every `dotaios <anything>` CLI invocation fires a best-effort `sync tick` (push if dirty, fast-forward pull). A 5-minute LaunchAgent / systemd user timer / Windows Scheduled Task ticks the same operation between CLI calls. Setup is device-flow OAuth via a single DotAIOS GitHub App (Filippo registers it once), repo creation is a deep-link to `github.com/new` (one click on GitHub's own UI), token storage is a `0600` file under `~/.dotaios/`. Divergence is resolved by saving local commits to a `local-<ts>` branch then fast-forwarding to origin — no conflict markers ever shown to the user.

**Tech Stack:** Node 20 ESM, zero new npm deps (per `packages/core` constraint), `node:test`, `node:child_process` (`spawnSync` / `spawn`), `node:https`, `node:fs/promises`, `node:crypto`. Shells out to the system `git` binary. GitHub Device Flow REST endpoints (no SDK).

**Conventions:**
- Tests run with `node --test tests/**/*.test.mjs`. All 271 existing tests must stay green.
- ESM only. `node:` built-ins only — no `package.json` dep additions.
- All network/spawn/fs/clock calls take injectable overrides (`fetchImpl`, `spawnImpl`, `now`, `gitImpl`). This is how the lightpanda module already tests; copy that style.
- New files mirror existing convention: CLI commands → `packages/cli/src/commands/<name>.mjs`, helpers → `packages/cli/src/sync/<name>.mjs` (new subdir), tests → `tests/cli/sync_*.test.mjs`.
- Filippo controls publish cadence — never `npm publish` from automation.
- Caveman/style isn't relevant to code. Write normal code + comments.

---

## Background context the engineer needs

DotAIOS = local-first personal memory OS. One folder (`~/aios/`) is the source of truth for who the user is, what they're working on, ingested URLs, etc. AI tools (Claude Code, Codex, Cursor, etc.) read from it via shared files like `AGENTS.md` and `CLAUDE.md`. The ICP is a non-technical daily AI user — never asked to edit JSON, never asked to resolve git conflicts.

This sync feature exists because the user's phone has no access to `~/aios/`. Solution: mirror the folder to a private GitHub repo per user. Phone-side AI agents (Claude on free tier, Codex on Plus+, etc.) link the repo and read the memory. Phone-side writes go into a special `memory/inbox/` folder that a local skill processes on the next desktop session — that's how we avoid ever editing the same file from two devices simultaneously.

**Decisions already made (from spec v2 + 2026-05-19 brainstorm — do not re-debate):**

| # | Decision |
|---|---|
| 1 | OAuth = GitHub Device Flow via single DotAIOS GitHub App (one App for all users) |
| 2 | Repo create = deep-link to `github.com/new?name=<u>-aios&visibility=private` (user clicks "Create" on GitHub's UI). NOT auto-created via API |
| 3 | Sync mechanism = CLI hook (fire on every `dotaios` invocation) + 5-min platform-native heartbeat. NO long-running daemon |
| 4 | First sync tick fires immediately on `sync setup` completion (mirror visible in repo within seconds) |
| 5 | Phone-read primary recommendation = Claude Projects (now free tier as of Feb 2026) with manual "Sync now" tap. Codex Mobile + GitHub Mobile mentioned as alternatives |
| 6 | Phone-write = drops file into `memory/inbox/<ts>-<slug>.md`. Local agent processes via `process-inbox` skill |
| 7 | Conflict policy = `git pull --ff-only`. On divergence: `git branch local-<iso-ts>`, then `git reset --hard origin/main`. Logged to `events.jsonl`. User never sees conflict markers |
| 8 | Token storage = file at `~/.dotaios/sync.json` with mode `0600`. Keychain hardening = future work |
| 9 | App verification (removing the "unverified" banner) = Filippo's job before friend-beta. Not in this plan's scope |

**GitHub App credentials the implementing engineer needs:**
- `GITHUB_APP_CLIENT_ID` — Filippo registers the App at `github.com/settings/apps/new` with name "DotAIOS Sync", permissions `Contents: read/write`, `Metadata: read`. Filippo supplies the public client_id. There is NO client_secret in device flow.
- If Filippo hasn't registered yet at plan-execution time, use the placeholder `Iv23liUNREGISTERED_PLACEHOLDER` and put a TODO in `README.md` so the value gets swapped in before publish. Tests must run without a real client_id (use the injectable `fetchImpl`).

**Rate-limit context to design against** (from spec v2 risks):
- GitHub secondary limits: 80 content-writes/min, 500/hr. Tick enforces a minimum **10-second gap** between pushes to stay clear.
- OAuth token endpoint: 10 tokens/user/app/scope, 10/hr token-creation rate.

---

## File Map

| File | Change |
|---|---|
| `packages/cli/src/commands/sync.mjs` | **New** — dispatches subcommands: `setup`, `tick`, `status`, `logout`, `repo` |
| `packages/cli/src/sync/auth.mjs` | **New** — device flow request + poll, token read/write |
| `packages/cli/src/sync/git.mjs` | **New** — thin async shell-out wrapper around `git` binary |
| `packages/cli/src/sync/repo.mjs` | **New** — deep-link repo create flow, initial mirror push |
| `packages/cli/src/sync/tick.mjs` | **New** — the 200ms push+pull operation, exit on rate-limit gap |
| `packages/cli/src/sync/heartbeat.mjs` | **New** — install/remove launchd / systemd / schtasks |
| `packages/cli/src/sync/inbox.mjs` | **New** — `listInbox()`, `clearInbox()` helpers used by skill |
| `packages/cli/src/lib/sync-hook.mjs` | **New** — fire-and-forget `sync tick` invoked at end of every CLI command |
| `packages/cli/src/commands/setup.mjs` | Modify — add "Connect to GitHub for cross-device access? (Y/n)" prompt; on yes, call `syncSetup()` |
| `packages/cli/src/index.mjs` | Modify — register `sync` command; wire `sync-hook` into post-dispatch path |
| `packages/core/src/paths.mjs` | Modify — add `syncConfigPath()`, `inboxDir()`, `heartbeatPlistPath()`, `heartbeatUnitPaths()` |
| `packages/core/src/sync-config.mjs` | **New** — read/write `~/.dotaios/sync.json` (token, repo url, last tick ts) |
| `templates/sync-gitignore.template` | **New** — 14-line `.gitignore` shipped into user's repo |
| `templates/skills/process-inbox/SKILL.md` | **New** — instructions for the local agent to file inbox entries |
| `templates/AGENTS.md.hbs` | Modify — add inbox-routing rule |
| `README.md` | Modify — new "Cross-device sync" section |
| `tests/cli/sync_auth.test.mjs` | **New** — device flow request/poll happy + error paths |
| `tests/cli/sync_git.test.mjs` | **New** — wrapper unit tests, stubbed `spawn` |
| `tests/cli/sync_tick.test.mjs` | **New** — push when dirty, ff pull, divergence → branch+reset, rate-limit gap |
| `tests/cli/sync_setup.test.mjs` | **New** — orchestration (auth + repo + initial tick + heartbeat install), all stubbed |
| `tests/cli/sync_heartbeat.test.mjs` | **New** — plist/unit/schtasks content generation, install/remove side-effects stubbed |
| `tests/cli/sync_hook.test.mjs` | **New** — hook is best-effort, never throws, never blocks |
| `tests/core/sync-config.test.mjs` | **New** — config read/write, `0600` mode, missing-file path |
| `tests/core/paths.test.mjs` | Modify — add assertions for new paths helpers |

**Total new files:** 18. **Modified files:** 5. **Estimated tasks below:** 18.

---

## Task 1: Path helpers for sync config + inbox + heartbeat artifacts

**Files:**
- Modify: `packages/core/src/paths.mjs`
- Test: `tests/core/paths.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `tests/core/paths.test.mjs` (create file if missing — copy the existing imports pattern from `tests/core/lightpanda.test.mjs`):

```js
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  syncConfigPath,
  inboxDir,
  heartbeatPlistPath,
  heartbeatUnitDir
} from "../../packages/core/src/paths.mjs";

test("syncConfigPath returns ~/.dotaios/sync.json", () => {
  assert.equal(syncConfigPath(), path.join(os.homedir(), ".dotaios", "sync.json"));
});

test("inboxDir returns <aios>/memory/inbox", () => {
  assert.equal(
    inboxDir("/tmp/aios-test"),
    path.join("/tmp/aios-test", "memory", "inbox")
  );
});

test("heartbeatPlistPath returns ~/Library/LaunchAgents/io.dotaios.sync.plist", () => {
  assert.equal(
    heartbeatPlistPath(),
    path.join(os.homedir(), "Library", "LaunchAgents", "io.dotaios.sync.plist")
  );
});

test("heartbeatUnitDir returns ~/.config/systemd/user", () => {
  assert.equal(
    heartbeatUnitDir(),
    path.join(os.homedir(), ".config", "systemd", "user")
  );
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test tests/core/paths.test.mjs`
Expected: 4 failures, "syncConfigPath is not exported" etc.

- [ ] **Step 3: Add helpers to `packages/core/src/paths.mjs`**

Append to `packages/core/src/paths.mjs`:

```js
export function syncConfigPath() {
  return path.join(dotaiosDir(), "sync.json");
}

export function inboxDir(aiosPath = defaultAiosPath()) {
  return path.join(aiosPath, "memory", "inbox");
}

export function heartbeatPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "io.dotaios.sync.plist");
}

export function heartbeatUnitDir() {
  return path.join(os.homedir(), ".config", "systemd", "user");
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test tests/core/paths.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Run full suite, expect 271 → 275 pass**

Run: `node --test tests/**/*.test.mjs`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/paths.mjs tests/core/paths.test.mjs
git commit -m "feat(sync): add path helpers for sync config and inbox"
```

---

## Task 2: Sync config module (read/write `~/.dotaios/sync.json`)

**Files:**
- Create: `packages/core/src/sync-config.mjs`
- Test: `tests/core/sync-config.test.mjs`

The config file shape:
```json
{
  "client_id": "Iv23liXXXXXXXXXXXXX",
  "access_token": "ghu_XXX",
  "username": "filocosta46",
  "repo_url": "https://github.com/filocosta46/filocosta46-aios.git",
  "repo_full_name": "filocosta46/filocosta46-aios",
  "last_tick_at": "2026-05-19T14:32:08.000Z",
  "last_push_sha": "abc123",
  "last_pull_at": "2026-05-19T14:32:08.000Z",
  "last_error": null,
  "installed_at": "2026-05-19T14:00:00.000Z"
}
```

- [ ] **Step 1: Write failing tests**

Create `tests/core/sync-config.test.mjs`:

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readSyncConfig, writeSyncConfig, isSyncEnabled } from "../../packages/core/src/sync-config.mjs";

async function withTmpHome(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-sync-cfg-"));
  const cfg = path.join(tmp, "sync.json");
  try { await fn(cfg, tmp); } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

test("readSyncConfig returns null when file missing", async () => {
  await withTmpHome(async (cfg) => {
    assert.equal(await readSyncConfig(cfg), null);
  });
});

test("writeSyncConfig creates file with 0600 mode", async () => {
  await withTmpHome(async (cfg) => {
    await writeSyncConfig(cfg, { client_id: "abc", access_token: "tok" });
    const stat = await fs.stat(cfg);
    // skip mode assert on win32 — POSIX modes are noise there
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o777, 0o600);
    }
    const data = JSON.parse(await fs.readFile(cfg, "utf8"));
    assert.equal(data.client_id, "abc");
    assert.equal(data.access_token, "tok");
  });
});

test("writeSyncConfig merges with existing values", async () => {
  await withTmpHome(async (cfg) => {
    await writeSyncConfig(cfg, { client_id: "abc", access_token: "tok" });
    await writeSyncConfig(cfg, { last_tick_at: "2026-05-19T00:00:00Z" });
    const data = await readSyncConfig(cfg);
    assert.equal(data.client_id, "abc");
    assert.equal(data.access_token, "tok");
    assert.equal(data.last_tick_at, "2026-05-19T00:00:00Z");
  });
});

test("isSyncEnabled is false when no access_token", async () => {
  await withTmpHome(async (cfg) => {
    assert.equal(await isSyncEnabled(cfg), false);
    await writeSyncConfig(cfg, { client_id: "abc" });
    assert.equal(await isSyncEnabled(cfg), false);
    await writeSyncConfig(cfg, { access_token: "tok" });
    assert.equal(await isSyncEnabled(cfg), true);
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test tests/core/sync-config.test.mjs`
Expected: 4 fail, "Cannot find module sync-config.mjs".

- [ ] **Step 3: Implement `packages/core/src/sync-config.mjs`**

```js
import fs from "node:fs/promises";
import path from "node:path";
import { syncConfigPath } from "./paths.mjs";

export async function readSyncConfig(filePath = syncConfigPath()) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSyncConfig(filePathOrPatch, maybePatch) {
  // overload: writeSyncConfig(patch) or writeSyncConfig(path, patch)
  let filePath, patch;
  if (typeof filePathOrPatch === "string") {
    filePath = filePathOrPatch;
    patch = maybePatch;
  } else {
    filePath = syncConfigPath();
    patch = filePathOrPatch;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = (await readSyncConfig(filePath)) ?? {};
  const merged = { ...existing, ...patch };
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), { mode: 0o600 });

  // re-chmod in case file existed before with looser mode
  if (process.platform !== "win32") {
    await fs.chmod(filePath, 0o600);
  }
  return merged;
}

export async function isSyncEnabled(filePath = syncConfigPath()) {
  const cfg = await readSyncConfig(filePath);
  return Boolean(cfg?.access_token);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test tests/core/sync-config.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sync-config.mjs tests/core/sync-config.test.mjs
git commit -m "feat(sync): add sync-config module with 0600 file storage"
```

---

## Task 3: Git wrapper (`packages/cli/src/sync/git.mjs`)

A thin async wrapper that shells out to the system `git` binary, captures stdout/stderr/code, and exposes helpers `dirty()`, `commitAll()`, `push()`, `fetch()`, `ffPull()`, `currentSha()`, `divergeStatus()`, `branchFromSha()`, `hardResetToOrigin()`.

**Files:**
- Create: `packages/cli/src/sync/git.mjs`
- Test: `tests/cli/sync_git.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/cli/sync_git.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../../packages/cli/src/sync/git.mjs";

function fakeSpawn(plan) {
  // plan: array of { match: RegExp|string, stdout: "", stderr: "", code: 0 }
  return (cmd, args /*, opts */) => {
    const full = [cmd, ...args].join(" ");
    const hit = plan.find((p) =>
      typeof p.match === "string" ? full.includes(p.match) : p.match.test(full)
    );
    if (!hit) throw new Error(`unstubbed git call: ${full}`);
    return Promise.resolve({
      stdout: hit.stdout ?? "",
      stderr: hit.stderr ?? "",
      code: hit.code ?? 0
    });
  };
}

test("dirty() true when porcelain has lines", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{ match: "status --porcelain", stdout: " M file.md\n" }])
  });
  assert.equal(await git.dirty(), true);
});

test("dirty() false when porcelain empty", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([{ match: "status --porcelain", stdout: "" }])
  });
  assert.equal(await git.dirty(), false);
});

test("ffPull() returns 'up-to-date' when origin matches HEAD", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "0\n" }
    ])
  });
  assert.equal(await git.ffPull("main"), "up-to-date");
});

test("ffPull() returns 'fast-forwarded' when remote ahead and merge succeeds", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "3\n" },
      { match: "rev-list --count origin/main..HEAD", stdout: "0\n" },
      { match: "merge --ff-only origin/main", stdout: "" }
    ])
  });
  assert.equal(await git.ffPull("main"), "fast-forwarded");
});

test("ffPull() returns 'diverged' when both ahead", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "fetch", stdout: "" },
      { match: "rev-list --count HEAD..origin/main", stdout: "2\n" },
      { match: "rev-list --count origin/main..HEAD", stdout: "5\n" }
    ])
  });
  assert.equal(await git.ffPull("main"), "diverged");
});

test("commitAll() returns null when nothing staged", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "add -A", stdout: "" },
      { match: "diff --cached --quiet", code: 0 }
    ])
  });
  assert.equal(await git.commitAll("sync"), null);
});

test("commitAll() returns sha when commit made", async () => {
  const git = createGit({
    cwd: "/x",
    spawnImpl: fakeSpawn([
      { match: "add -A", stdout: "" },
      { match: "diff --cached --quiet", code: 1 }, // changes present
      { match: "commit -m", stdout: "" },
      { match: "rev-parse HEAD", stdout: "abc123\n" }
    ])
  });
  assert.equal(await git.commitAll("sync"), "abc123");
});

test("branchFromSha() creates named branch pointing at given sha", async () => {
  const calls = [];
  const git = createGit({
    cwd: "/x",
    spawnImpl: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    }
  });
  await git.branchFromSha("local-2026", "abc123");
  assert.ok(calls.some((c) => c.includes("branch local-2026 abc123")));
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test tests/cli/sync_git.test.mjs`
Expected: 7 fail, "Cannot find module git.mjs".

- [ ] **Step 3: Implement `packages/cli/src/sync/git.mjs`**

```js
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
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test tests/cli/sync_git.test.mjs`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/git.mjs tests/cli/sync_git.test.mjs
git commit -m "feat(sync): add git shell-out wrapper"
```

---

## Task 4: Device flow auth (`packages/cli/src/sync/auth.mjs`)

GitHub Device Flow has two endpoints:
- `POST https://github.com/login/device/code` → returns `device_code`, `user_code`, `verification_uri`, `interval` (seconds to poll), `expires_in` (sec)
- `POST https://github.com/login/oauth/access_token` (poll) → returns `access_token` (`ghu_...`) when user approves, or `{ error: "authorization_pending" }` while waiting, or `{ error: "slow_down" }` to increase interval

We also fetch `GET https://api.github.com/user` with the token to learn the username.

**Files:**
- Create: `packages/cli/src/sync/auth.mjs`
- Test: `tests/cli/sync_auth.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/cli/sync_auth.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { requestDeviceCode, pollForToken, fetchUsername } from "../../packages/cli/src/sync/auth.mjs";

function jsonFetch(routes) {
  return async (url, opts = {}) => {
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`unstubbed fetch: ${url}`);
    let body = hit.body;
    if (typeof body === "function") body = body(opts);
    return {
      ok: hit.status ? hit.status < 400 : true,
      status: hit.status ?? 200,
      json: async () => body
    };
  };
}

test("requestDeviceCode returns parsed payload", async () => {
  const res = await requestDeviceCode({
    clientId: "ID",
    fetchImpl: jsonFetch([{
      match: "login/device/code",
      body: {
        device_code: "DC", user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        interval: 5, expires_in: 900
      }
    }])
  });
  assert.equal(res.userCode, "WDJB-MJHT");
  assert.equal(res.deviceCode, "DC");
  assert.equal(res.intervalSec, 5);
});

test("pollForToken returns token when user approves", async () => {
  let calls = 0;
  const res = await pollForToken({
    clientId: "ID",
    deviceCode: "DC",
    intervalSec: 0, // fast for test
    fetchImpl: jsonFetch([{
      match: "oauth/access_token",
      body: () => {
        calls += 1;
        if (calls < 3) return { error: "authorization_pending" };
        return { access_token: "ghu_TOKEN", token_type: "bearer", scope: "" };
      }
    }]),
    sleep: () => Promise.resolve()
  });
  assert.equal(res.accessToken, "ghu_TOKEN");
});

test("pollForToken respects slow_down by increasing interval", async () => {
  const intervals = [];
  let calls = 0;
  await pollForToken({
    clientId: "ID",
    deviceCode: "DC",
    intervalSec: 5,
    fetchImpl: jsonFetch([{
      match: "oauth/access_token",
      body: () => {
        calls += 1;
        if (calls === 1) return { error: "slow_down", interval: 10 };
        return { access_token: "T" };
      }
    }]),
    sleep: (sec) => { intervals.push(sec); return Promise.resolve(); }
  });
  // After slow_down, the wait should be at least 10s
  assert.ok(intervals.some((s) => s >= 10), `expected a >=10s wait, got ${JSON.stringify(intervals)}`);
});

test("pollForToken throws on expired_token", async () => {
  await assert.rejects(
    pollForToken({
      clientId: "ID",
      deviceCode: "DC",
      intervalSec: 0,
      fetchImpl: jsonFetch([{
        match: "oauth/access_token",
        body: { error: "expired_token" }
      }]),
      sleep: () => Promise.resolve()
    }),
    /expired/
  );
});

test("fetchUsername returns login from /user", async () => {
  const name = await fetchUsername({
    accessToken: "T",
    fetchImpl: jsonFetch([{ match: "/user", body: { login: "filocosta46" } }])
  });
  assert.equal(name, "filocosta46");
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test tests/cli/sync_auth.test.mjs`
Expected: 5 fail.

- [ ] **Step 3: Implement `packages/cli/src/sync/auth.mjs`**

```js
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

const TERMINAL_ERRORS = new Set([
  "expired_token",
  "access_denied",
  "incorrect_device_code",
  "incorrect_client_credentials",
  "unsupported_grant_type"
]);

async function postJson(url, body, { fetchImpl }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

export async function requestDeviceCode({ clientId, fetchImpl = fetch }) {
  const payload = await postJson(DEVICE_CODE_URL, { client_id: clientId }, { fetchImpl });
  if (payload.error) {
    throw new Error(`device code request failed: ${payload.error_description || payload.error}`);
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    intervalSec: payload.interval ?? 5,
    expiresInSec: payload.expires_in ?? 900
  };
}

export async function pollForToken({
  clientId,
  deviceCode,
  intervalSec,
  fetchImpl = fetch,
  sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000)),
  now = () => Date.now(),
  timeoutMs = 15 * 60 * 1000 // 15 min
}) {
  let interval = intervalSec;
  const startedAt = now();
  while (true) {
    if (now() - startedAt > timeoutMs) {
      throw new Error("device code expired before user approved");
    }
    await sleep(interval);
    const res = await postJson(
      TOKEN_URL,
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      },
      { fetchImpl }
    );
    if (res.access_token) {
      return { accessToken: res.access_token, tokenType: res.token_type, scope: res.scope };
    }
    if (res.error === "authorization_pending") continue;
    if (res.error === "slow_down") {
      interval = Math.max(interval + 5, res.interval || interval + 5);
      continue;
    }
    if (TERMINAL_ERRORS.has(res.error)) {
      throw new Error(`device flow error: ${res.error}`);
    }
    throw new Error(`unknown device flow response: ${JSON.stringify(res)}`);
  }
}

export async function fetchUsername({ accessToken, fetchImpl = fetch }) {
  const res = await fetchImpl(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "dotaios-sync"
    }
  });
  const data = await res.json();
  if (!data.login) throw new Error("could not read GitHub username");
  return data.login;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test tests/cli/sync_auth.test.mjs`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/auth.mjs tests/cli/sync_auth.test.mjs
git commit -m "feat(sync): add GitHub device flow auth module"
```

---

## Task 5: Repo deep-link + initial mirror push (`packages/cli/src/sync/repo.mjs`)

This module:
1. Builds the `github.com/new?...` URL for the user to click.
2. Polls `GET https://api.github.com/repos/<user>/<user>-aios` until the repo exists (user has clicked Create).
3. Initializes git in `~/aios/`, writes the `.gitignore` from `templates/sync-gitignore.template`, sets remote, makes the initial commit, pushes.

Authentication for `git push` uses HTTPS with the token embedded in the remote URL (`https://x-access-token:<token>@github.com/<user>/<user>-aios.git`). This is GitHub's documented pattern for tokens.

**Files:**
- Create: `packages/cli/src/sync/repo.mjs`
- Test: `tests/cli/sync_repo.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/cli/sync_repo.test.mjs`:

```js
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateRepoUrl,
  remoteUrlWithToken,
  pollForRepoExists,
  initialMirrorPush
} from "../../packages/cli/src/sync/repo.mjs";

test("buildCreateRepoUrl returns a pre-filled github.com/new URL", () => {
  const url = buildCreateRepoUrl("filocosta46");
  assert.ok(url.startsWith("https://github.com/new?"));
  assert.ok(url.includes("name=filocosta46-aios"));
  assert.ok(url.includes("visibility=private"));
  assert.ok(url.includes("description="));
});

test("remoteUrlWithToken embeds x-access-token", () => {
  const url = remoteUrlWithToken("ghu_T", "filocosta46/filocosta46-aios");
  assert.equal(url, "https://x-access-token:ghu_T@github.com/filocosta46/filocosta46-aios.git");
});

test("pollForRepoExists resolves once API returns 200", async () => {
  let calls = 0;
  const ok = await pollForRepoExists({
    accessToken: "T",
    fullName: "u/u-aios",
    fetchImpl: async () => {
      calls += 1;
      return { ok: calls >= 2, status: calls >= 2 ? 200 : 404, json: async () => ({}) };
    },
    sleep: () => Promise.resolve(),
    timeoutMs: 60_000,
    now: () => 0
  });
  assert.equal(ok, true);
});

test("initialMirrorPush invokes git init, add, commit, push in order", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-mirror-"));
  try {
    await fs.writeFile(path.join(tmp, "hello.md"), "hi");
    const calls = [];
    const fakeGit = {
      init: async () => calls.push("init"),
      addRemote: async (url) => calls.push(`remote:${url}`),
      raw: async (args) => { calls.push(`raw:${args.join(" ")}`); return { stdout: "", stderr: "", code: 0 }; },
      dirty: async () => true,
      commitAll: async (m) => { calls.push(`commit:${m}`); return "deadbeef"; },
      push: async (b) => calls.push(`push:${b}`)
    };
    await initialMirrorPush({
      aiosPath: tmp,
      accessToken: "T",
      fullName: "u/u-aios",
      gitignoreContent: ".env\n",
      git: fakeGit
    });
    assert.deepEqual(
      calls.slice(0, 2),
      ["init", "remote:https://x-access-token:T@github.com/u/u-aios.git"]
    );
    assert.ok(calls.includes("commit:Initial DotAIOS mirror"));
    assert.ok(calls.includes("push:main"));
    const writtenGitignore = await fs.readFile(path.join(tmp, ".gitignore"), "utf8");
    assert.equal(writtenGitignore, ".env\n");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test tests/cli/sync_repo.test.mjs`
Expected: 4 fail.

- [ ] **Step 3: Implement `packages/cli/src/sync/repo.mjs`**

```js
import fs from "node:fs/promises";
import path from "node:path";

const REPO_DESCRIPTION = "DotAIOS personal memory mirror — synced from local ~/aios/. Auto-managed by dotaios.";

export function buildCreateRepoUrl(username) {
  const params = new URLSearchParams({
    name: `${username}-aios`,
    visibility: "private",
    description: REPO_DESCRIPTION
  });
  return `https://github.com/new?${params.toString()}`;
}

export function remoteUrlWithToken(accessToken, fullName) {
  return `https://x-access-token:${accessToken}@github.com/${fullName}.git`;
}

export async function pollForRepoExists({
  accessToken,
  fullName,
  fetchImpl = fetch,
  sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000)),
  now = () => Date.now(),
  intervalSec = 3,
  timeoutMs = 5 * 60 * 1000
}) {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    const res = await fetchImpl(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dotaios-sync"
      }
    });
    if (res.ok) return true;
    await sleep(intervalSec);
  }
  throw new Error(`timed out waiting for repo ${fullName} to be created on GitHub`);
}

export async function initialMirrorPush({
  aiosPath,
  accessToken,
  fullName,
  gitignoreContent,
  git
}) {
  // 1. Write the .gitignore (overwriting if exists).
  await fs.writeFile(path.join(aiosPath, ".gitignore"), gitignoreContent);

  // 2. Init git repo on default branch "main" if not already.
  await git.init();

  // 3. Set remote with token-embedded URL.
  await git.addRemote(remoteUrlWithToken(accessToken, fullName));

  // 4. Add + commit everything.
  await git.commitAll("Initial DotAIOS mirror");

  // 5. Push.
  await git.push("main");
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test tests/cli/sync_repo.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/repo.mjs tests/cli/sync_repo.test.mjs
git commit -m "feat(sync): add repo deep-link + initial mirror push"
```

---

## Task 6: Shipped `.gitignore` template

**Files:**
- Create: `templates/sync-gitignore.template`

- [ ] **Step 1: Create file**

Create `templates/sync-gitignore.template`:

```gitignore
.env
.env.*
*.key
*.pem
*.token
*.credentials
connections/*/credentials.json
connections/*/token.json
license/*.json
.DS_Store
memory/.daemon.*
cache/
tmp/
node_modules/
```

- [ ] **Step 2: Add test that template ships in package**

Append to `tests/core/render.test.mjs` (or create `tests/core/templates.test.mjs` if no fitting file):

```js
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("sync-gitignore.template ships in templates/", async () => {
  const file = path.join(new URL("../..", import.meta.url).pathname, "templates", "sync-gitignore.template");
  const content = await fs.readFile(file, "utf8");
  assert.ok(content.includes(".env"));
  assert.ok(content.includes("*.token"));
  assert.ok(content.includes("node_modules/"));
});
```

- [ ] **Step 3: Run test, expect PASS**

Run: `node --test tests/core/render.test.mjs`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add templates/sync-gitignore.template tests/core/render.test.mjs
git commit -m "feat(sync): ship shielded .gitignore template"
```

---

## Task 7: Tick operation (`packages/cli/src/sync/tick.mjs`)

The single function called by the CLI hook, the heartbeat, and `dotaios sync tick`. Does (in order):

1. Read config. If no token → return `{ skipped: "no-token" }`.
2. Read `last_tick_at`. If less than 10 seconds ago → return `{ skipped: "rate-limit-gap" }` (avoids GitHub secondary limits).
3. `git fetch && git ffPull("main")`.
   - `up-to-date` → no-op
   - `fast-forwarded` → log
   - `diverged` → `git branchFromSha("local-<iso-ts>", currentSha)` then `git hardResetToOrigin("main")`. Log to events.jsonl as `{ type: "sync-diverged", branch }`.
4. If `git.dirty()` → `commitAll("sync: <N> files <iso-ts>")`, `push("main")`.
5. Write `last_tick_at` + `last_push_sha` to config.
6. On any error: write `last_error` to config, log to events.jsonl, return error (do not throw — callers must not crash).

**Files:**
- Create: `packages/cli/src/sync/tick.mjs`
- Test: `tests/cli/sync_tick.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/cli/sync_tick.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { runTick } from "../../packages/cli/src/sync/tick.mjs";

function makeGit({ dirty = false, ffResult = "up-to-date", commitSha = null, calls = [] } = {}) {
  return {
    async dirty() { calls.push("dirty"); return dirty; },
    async commitAll(msg) { calls.push(`commit:${msg.slice(0, 15)}`); return commitSha; },
    async push(b) { calls.push(`push:${b}`); },
    async fetch() { calls.push("fetch"); },
    async ffPull(b) { calls.push(`ffPull:${b}`); return ffResult; },
    async currentSha() { return "sha-current"; },
    async branchFromSha(n, s) { calls.push(`branch:${n}:${s}`); },
    async hardResetToOrigin(b) { calls.push(`reset:${b}`); }
  };
}

test("tick skips when no config", async () => {
  const result = await runTick({
    readConfig: async () => null,
    writeConfig: async () => {},
    makeGit: () => makeGit(),
    appendEvent: async () => {},
    now: () => Date.now()
  });
  assert.equal(result.skipped, "no-token");
});

test("tick skips when within 10s of last tick", async () => {
  const result = await runTick({
    readConfig: async () => ({ access_token: "T", last_tick_at: new Date(1000).toISOString() }),
    writeConfig: async () => {},
    makeGit: () => makeGit(),
    appendEvent: async () => {},
    now: () => 5000 // 4 seconds later
  });
  assert.equal(result.skipped, "rate-limit-gap");
});

test("tick pulls + pushes when dirty and remote up-to-date", async () => {
  const calls = [];
  const result = await runTick({
    readConfig: async () => ({ access_token: "T", last_tick_at: null }),
    writeConfig: async () => {},
    makeGit: () => makeGit({ dirty: true, ffResult: "up-to-date", commitSha: "deadbeef", calls }),
    appendEvent: async () => {},
    now: () => Date.now()
  });
  assert.ok(calls.includes("fetch"));
  assert.ok(calls.includes("ffPull:main"));
  assert.ok(calls.includes("push:main"));
  assert.ok(calls.some((c) => c.startsWith("commit:sync:")));
  assert.equal(result.pushed, true);
});

test("tick branches and resets on divergence, then pushes local work", async () => {
  const calls = [];
  await runTick({
    readConfig: async () => ({ access_token: "T", last_tick_at: null }),
    writeConfig: async () => {},
    makeGit: () => makeGit({ dirty: true, ffResult: "diverged", commitSha: "newsha", calls }),
    appendEvent: async () => {},
    now: () => Date.now()
  });
  assert.ok(calls.some((c) => c.startsWith("branch:local-")));
  assert.ok(calls.includes("reset:main"));
});

test("tick writes last_error on git failure and does not throw", async () => {
  const written = [];
  const failingGit = {
    dirty: async () => true,
    commitAll: async () => "sha",
    push: async () => { throw new Error("network down"); },
    fetch: async () => {},
    ffPull: async () => "up-to-date",
    currentSha: async () => "sha",
    branchFromSha: async () => {},
    hardResetToOrigin: async () => {}
  };
  const result = await runTick({
    readConfig: async () => ({ access_token: "T", last_tick_at: null }),
    writeConfig: async (patch) => written.push(patch),
    makeGit: () => failingGit,
    appendEvent: async () => {},
    now: () => Date.now()
  });
  assert.equal(result.error, "network down");
  assert.ok(written.some((p) => p.last_error?.includes("network down")));
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `node --test tests/cli/sync_tick.test.mjs`
Expected: 5 fail.

- [ ] **Step 3: Implement `packages/cli/src/sync/tick.mjs`**

```js
const MIN_TICK_GAP_MS = 10_000;

export async function runTick({
  readConfig,
  writeConfig,
  makeGit,
  appendEvent,
  now = () => Date.now()
}) {
  const cfg = await readConfig();
  if (!cfg?.access_token) return { skipped: "no-token" };

  if (cfg.last_tick_at) {
    const last = Date.parse(cfg.last_tick_at);
    if (Number.isFinite(last) && now() - last < MIN_TICK_GAP_MS) {
      return { skipped: "rate-limit-gap" };
    }
  }

  const git = makeGit();
  const startedIso = new Date(now()).toISOString();

  try {
    const pullResult = await git.ffPull("main");

    if (pullResult === "diverged") {
      const localSha = await git.currentSha();
      const branchName = `local-${startedIso.replace(/[:.]/g, "-")}`;
      await git.branchFromSha(branchName, localSha);
      await git.hardResetToOrigin("main");
      await appendEvent({ type: "sync-diverged", branch: branchName, at: startedIso });
    }

    let pushedSha = null;
    if (await git.dirty()) {
      pushedSha = await git.commitAll(`sync: ${startedIso}`);
      if (pushedSha) {
        await git.push("main");
      }
    }

    await writeConfig({
      last_tick_at: startedIso,
      last_push_sha: pushedSha ?? cfg.last_push_sha ?? null,
      last_pull_at: startedIso,
      last_error: null
    });

    return {
      pulled: pullResult,
      pushed: Boolean(pushedSha),
      sha: pushedSha
    };
  } catch (err) {
    await writeConfig({ last_error: err.message, last_tick_at: startedIso });
    await appendEvent({ type: "sync-error", reason: err.message, at: startedIso });
    return { error: err.message };
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test tests/cli/sync_tick.test.mjs`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/tick.mjs tests/cli/sync_tick.test.mjs
git commit -m "feat(sync): add tick (push+ff-pull+divergence handling)"
```

---

## Task 8: Heartbeat install — macOS launchd

**Files:**
- Create: `packages/cli/src/sync/heartbeat.mjs` (start; Tasks 9 and 10 add Linux + Windows branches)
- Test: `tests/cli/sync_heartbeat.test.mjs`

- [ ] **Step 1: Write failing test**

Create `tests/cli/sync_heartbeat.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderLaunchAgentPlist } from "../../packages/cli/src/sync/heartbeat.mjs";

test("renderLaunchAgentPlist embeds binary, 300s interval, log paths", () => {
  const plist = renderLaunchAgentPlist({
    label: "io.dotaios.sync",
    binary: "/usr/local/bin/dotaios",
    args: ["sync", "tick"],
    intervalSec: 300,
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log"
  });
  assert.ok(plist.includes("<key>Label</key>"));
  assert.ok(plist.includes("<string>io.dotaios.sync</string>"));
  assert.ok(plist.includes("<string>/usr/local/bin/dotaios</string>"));
  assert.ok(plist.includes("<string>sync</string>"));
  assert.ok(plist.includes("<string>tick</string>"));
  assert.ok(plist.includes("<key>StartInterval</key>"));
  assert.ok(plist.includes("<integer>300</integer>"));
  assert.ok(plist.includes("<string>/tmp/out.log</string>"));
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/cli/sync_heartbeat.test.mjs`
Expected: 1 fail.

- [ ] **Step 3: Implement `packages/cli/src/sync/heartbeat.mjs` (macOS portion)**

Create `packages/cli/src/sync/heartbeat.mjs`:

```js
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
  // bootstrap (load); ignore "already loaded" errors
  await exec("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);
}

export async function removeMacHeartbeat({
  plistPath = heartbeatPlistPath(),
  exec = runCmd
} = {}) {
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
```

- [ ] **Step 4: Run test, expect PASS**

Run: `node --test tests/cli/sync_heartbeat.test.mjs`
Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/heartbeat.mjs tests/cli/sync_heartbeat.test.mjs
git commit -m "feat(sync): macOS launchd heartbeat install"
```

---

## Task 9: Heartbeat install — Linux systemd user

**Files:**
- Modify: `packages/cli/src/sync/heartbeat.mjs` — fill in Linux branch
- Modify: `tests/cli/sync_heartbeat.test.mjs` — add Linux unit-content test

- [ ] **Step 1: Add failing test**

Append to `tests/cli/sync_heartbeat.test.mjs`:

```js
import { renderSystemdUnits } from "../../packages/cli/src/sync/heartbeat.mjs";

test("renderSystemdUnits returns service + timer matching binary + 300s interval", () => {
  const { service, timer } = renderSystemdUnits({
    binary: "/usr/bin/dotaios",
    intervalSec: 300
  });
  assert.ok(service.includes("[Service]"));
  assert.ok(service.includes("ExecStart=/usr/bin/dotaios sync tick"));
  assert.ok(timer.includes("[Timer]"));
  assert.ok(timer.includes("OnUnitActiveSec=300s"));
  assert.ok(timer.includes("OnBootSec=30s"));
  assert.ok(timer.includes("[Install]"));
  assert.ok(timer.includes("WantedBy=default.target"));
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/cli/sync_heartbeat.test.mjs`
Expected: new test fails.

- [ ] **Step 3: Implement Linux branch**

Replace the `installLinuxHeartbeat` / `removeLinuxHeartbeat` stubs in `packages/cli/src/sync/heartbeat.mjs`:

```js
export function renderSystemdUnits({ binary, intervalSec }) {
  const service = `[Unit]
Description=DotAIOS sync tick

[Service]
Type=oneshot
ExecStart=${binary} sync tick
`;

  const timer = `[Unit]
Description=DotAIOS sync timer

[Timer]
OnBootSec=30s
OnUnitActiveSec=${intervalSec}s
Unit=dotaios-sync.service

[Install]
WantedBy=default.target
`;

  return { service, timer };
}

export async function installLinuxHeartbeat({
  binary,
  unitDir = heartbeatUnitDir(),
  exec = runCmd
} = {}) {
  await ensureDir(unitDir);
  const { service, timer } = renderSystemdUnits({ binary, intervalSec: INTERVAL_SEC });
  await fs.writeFile(path.join(unitDir, "dotaios-sync.service"), service);
  await fs.writeFile(path.join(unitDir, "dotaios-sync.timer"), timer);
  await exec("systemctl", ["--user", "daemon-reload"]);
  await exec("systemctl", ["--user", "enable", "--now", "dotaios-sync.timer"]);
}

export async function removeLinuxHeartbeat({
  unitDir = heartbeatUnitDir(),
  exec = runCmd
} = {}) {
  await exec("systemctl", ["--user", "disable", "--now", "dotaios-sync.timer"]);
  await fs.rm(path.join(unitDir, "dotaios-sync.timer"), { force: true });
  await fs.rm(path.join(unitDir, "dotaios-sync.service"), { force: true });
  await exec("systemctl", ["--user", "daemon-reload"]);
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `node --test tests/cli/sync_heartbeat.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/heartbeat.mjs tests/cli/sync_heartbeat.test.mjs
git commit -m "feat(sync): Linux systemd user heartbeat install"
```

---

## Task 10: Heartbeat install — Windows Scheduled Task

**Files:**
- Modify: `packages/cli/src/sync/heartbeat.mjs` — fill in Windows branch
- Modify: `tests/cli/sync_heartbeat.test.mjs` — add Windows command-shape test

- [ ] **Step 1: Add failing test**

Append to `tests/cli/sync_heartbeat.test.mjs`:

```js
import { buildSchtasksArgs } from "../../packages/cli/src/sync/heartbeat.mjs";

test("buildSchtasksArgs creates the right /Create command", () => {
  const args = buildSchtasksArgs({ taskName: "DotAIOS Sync", binary: "C:/dotaios.exe" });
  assert.ok(args.includes("/Create"));
  assert.ok(args.includes("/TN"));
  assert.ok(args.includes("DotAIOS Sync"));
  assert.ok(args.includes("/SC"));
  assert.ok(args.includes("MINUTE"));
  assert.ok(args.includes("/MO"));
  assert.ok(args.includes("5"));
  assert.ok(args.includes("/TR"));
  assert.ok(args.some((a) => a.includes("C:/dotaios.exe")));
  assert.ok(args.some((a) => a.includes("sync tick")));
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/cli/sync_heartbeat.test.mjs`
Expected: new test fails.

- [ ] **Step 3: Implement Windows branch**

Replace the `installWindowsHeartbeat` / `removeWindowsHeartbeat` stubs:

```js
const TASK_NAME = "DotAIOS Sync";

export function buildSchtasksArgs({ taskName, binary }) {
  return [
    "/Create",
    "/F",
    "/TN", taskName,
    "/SC", "MINUTE",
    "/MO", "5",
    "/TR", `"${binary}" sync tick`
  ];
}

export async function installWindowsHeartbeat({
  binary,
  taskName = TASK_NAME,
  exec = runCmd
} = {}) {
  const args = buildSchtasksArgs({ taskName, binary });
  const result = await exec("schtasks", args);
  if (result.code !== 0) {
    throw new Error(`schtasks install failed: ${result.stderr.trim()}`);
  }
}

export async function removeWindowsHeartbeat({
  taskName = TASK_NAME,
  exec = runCmd
} = {}) {
  await exec("schtasks", ["/Delete", "/F", "/TN", taskName]);
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `node --test tests/cli/sync_heartbeat.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/heartbeat.mjs tests/cli/sync_heartbeat.test.mjs
git commit -m "feat(sync): Windows schtasks heartbeat install"
```

---

## Task 11: CLI hook (fire-and-forget tick on every `dotaios` invocation)

**Files:**
- Create: `packages/cli/src/lib/sync-hook.mjs`
- Modify: `packages/cli/src/index.mjs` — call hook before `process.exit`
- Test: `tests/cli/sync_hook.test.mjs`

Key requirement: the hook **must not block exit** noticeably, **must never throw**, and **must not run for the sync command itself** (`dotaios sync` would re-tick recursively — pointless).

Implementation strategy: spawn a detached child `dotaios sync tick` with `stdio: "ignore"`, don't wait. The CLI returns immediately. The heartbeat alone is enough to converge state if the spawn fails.

- [ ] **Step 1: Write failing test**

Create `tests/cli/sync_hook.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fireSyncHook } from "../../packages/cli/src/lib/sync-hook.mjs";

test("fireSyncHook returns immediately when sync not enabled", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "ingest",
    isSyncEnabled: async () => false,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook does not spawn when command is 'sync'", async () => {
  let spawned = false;
  await fireSyncHook({
    command: "sync",
    isSyncEnabled: async () => true,
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
});

test("fireSyncHook spawns dotaios sync tick when enabled", async () => {
  let args = null;
  await fireSyncHook({
    command: "ingest",
    isSyncEnabled: async () => true,
    spawnImpl: (cmd, a) => { args = [cmd, ...a]; return { unref: () => {} }; }
  });
  assert.ok(args[args.length - 2] === "sync");
  assert.ok(args[args.length - 1] === "tick");
});

test("fireSyncHook swallows any error", async () => {
  await fireSyncHook({
    command: "ingest",
    isSyncEnabled: async () => { throw new Error("boom"); },
    spawnImpl: () => {}
  });
  // no throw → pass
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/cli/sync_hook.test.mjs`
Expected: 4 fail.

- [ ] **Step 3: Implement `packages/cli/src/lib/sync-hook.mjs`**

```js
import { spawn } from "node:child_process";
import { isSyncEnabled } from "../../../core/src/sync-config.mjs";

function defaultSpawn(cmd, args) {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

export async function fireSyncHook({
  command,
  argv0 = process.argv0,
  spawnImpl = defaultSpawn,
  isSyncEnabled: isEnabledImpl = isSyncEnabled
} = {}) {
  try {
    if (command === "sync") return;
    if (!(await isEnabledImpl())) return;
    spawnImpl(argv0, [process.argv[1], "sync", "tick"]);
  } catch {
    // best-effort. Never throw from hook.
  }
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `node --test tests/cli/sync_hook.test.mjs`
Expected: 4 pass.

- [ ] **Step 5: Wire into `packages/cli/src/index.mjs`**

In `packages/cli/src/index.mjs`, locate the main dispatch logic (after the import block + before `process.exit`). After the command runs successfully, call:

```js
import { fireSyncHook } from "./lib/sync-hook.mjs";

// inside main() right before exit:
const commandName = args[0];
await fireSyncHook({ command: commandName });
```

Place this AFTER the command finishes but BEFORE the process exits. The hook itself returns instantly (spawn is detached).

- [ ] **Step 6: Smoke-check by running `dotaios --version`**

Run: `node packages/cli/src/index.mjs --version`
Expected: prints version, exits 0, no error. (No sync tick fires because no sync config yet — graceful.)

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/lib/sync-hook.mjs packages/cli/src/index.mjs tests/cli/sync_hook.test.mjs
git commit -m "feat(sync): fire-and-forget sync tick hook after every CLI invocation"
```

---

## Task 12: `sync` command dispatcher (`packages/cli/src/commands/sync.mjs`)

Subcommands: `setup`, `tick`, `status`, `logout`, `repo`. Each dispatches to a helper, with `--help` printing usage.

**Files:**
- Create: `packages/cli/src/commands/sync.mjs`
- Modify: `packages/cli/src/index.mjs` — register `sync` in the commands map
- Test: `tests/cli/sync_command.test.mjs`

- [ ] **Step 1: Write failing test**

Create `tests/cli/sync_command.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { syncCommand } from "../../packages/cli/src/commands/sync.mjs";

test("syncCommand with --help prints usage", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await syncCommand(["--help"]);
  } finally { console.log = orig; }
  assert.ok(logs.join("\n").includes("dotaios sync"));
  assert.ok(logs.join("\n").includes("setup"));
  assert.ok(logs.join("\n").includes("tick"));
  assert.ok(logs.join("\n").includes("status"));
});

test("syncCommand with unknown subcommand sets exit code 1", async () => {
  const errors = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => errors.push(a.join(" "));
  console.log = () => {};
  try {
    await syncCommand(["frobnicate"]);
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  assert.equal(process.exitCode, 1);
  assert.ok(errors.join("\n").includes("Unknown sync subcommand"));
  process.exitCode = 0; // reset for other tests
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/cli/sync_command.test.mjs`
Expected: 2 fail.

- [ ] **Step 3: Implement `packages/cli/src/commands/sync.mjs`**

```js
import { hasHelpFlag } from "../lib/args.mjs";

const HELP_TEXT = `Usage:
  dotaios sync <subcommand> [options]

Cross-device sync of your ~/aios/ folder to a private GitHub repo.

Subcommands:
  setup       One-time: sign in to GitHub, create your repo, push first mirror, install background heartbeat
  tick        Run one push+pull cycle (used by the heartbeat; safe to run manually)
  status      Show last tick time, repo URL, divergent branches, errors
  logout      Sign out of GitHub, remove heartbeat (keeps your repo on GitHub)
  repo        Print the URL of your DotAIOS repo

Options:
  --path <dir>   Use a non-default AIOS folder
`;

export async function syncCommand(args = []) {
  if (!args.length || hasHelpFlag(args)) {
    console.log(HELP_TEXT);
    return;
  }

  const [sub, ...rest] = args;

  // Lazy-import each subcommand to keep startup fast for unrelated invocations.
  if (sub === "setup") {
    const { runSetup } = await import("../sync/setup-flow.mjs");
    return runSetup(rest);
  }
  if (sub === "tick") {
    const { runTickCommand } = await import("../sync/tick-cmd.mjs");
    return runTickCommand(rest);
  }
  if (sub === "status") {
    const { runStatus } = await import("../sync/status-cmd.mjs");
    return runStatus(rest);
  }
  if (sub === "logout") {
    const { runLogout } = await import("../sync/logout-cmd.mjs");
    return runLogout(rest);
  }
  if (sub === "repo") {
    const { runRepo } = await import("../sync/repo-cmd.mjs");
    return runRepo(rest);
  }

  console.error(`Unknown sync subcommand: ${sub}`);
  console.log(HELP_TEXT);
  process.exitCode = 1;
}
```

- [ ] **Step 4: Register in `packages/cli/src/index.mjs`**

In the `commands` object literal in `packages/cli/src/index.mjs`, add:

```js
sync: "./commands/sync.mjs",
```

(Keep alphabetical order — between `status` and `update`.)

Also update `printHelp()` text to add a one-line description:

```
  sync <cmd>        Cross-device sync to a private GitHub repo
```

- [ ] **Step 5: Run test, expect PASS (with stub subcommand files created later)**

For tests to pass now, create empty placeholder files. The next tasks will implement them properly.

Create skeleton stubs (just enough for the dispatcher to not crash on dispatch):

```bash
mkdir -p packages/cli/src/sync
```

Create `packages/cli/src/sync/tick-cmd.mjs`:

```js
export async function runTickCommand() {
  // implemented in Task 13
  console.log("(tick stub)");
}
```

Create `packages/cli/src/sync/status-cmd.mjs`:

```js
export async function runStatus() {
  console.log("(status stub)");
}
```

Create `packages/cli/src/sync/repo-cmd.mjs`:

```js
export async function runRepo() {
  console.log("(repo stub)");
}
```

Create `packages/cli/src/sync/logout-cmd.mjs`:

```js
export async function runLogout() {
  console.log("(logout stub)");
}
```

Create `packages/cli/src/sync/setup-flow.mjs`:

```js
export async function runSetup() {
  console.log("(setup stub)");
}
```

Now run: `node --test tests/cli/sync_command.test.mjs`
Expected: 2 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/sync.mjs packages/cli/src/sync/ packages/cli/src/index.mjs tests/cli/sync_command.test.mjs
git commit -m "feat(sync): add sync command dispatcher + subcommand stubs"
```

---

## Task 13: `sync tick` subcommand (wire to `runTick`)

**Files:**
- Modify: `packages/cli/src/sync/tick-cmd.mjs` (replace stub)
- Modify: `tests/cli/sync_tick.test.mjs` — add CLI-shape test

- [ ] **Step 1: Add failing CLI test**

Append to `tests/cli/sync_tick.test.mjs`:

```js
import { runTickCommand } from "../../packages/cli/src/sync/tick-cmd.mjs";

test("runTickCommand exits 0 when sync not enabled", async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await runTickCommand([]);
  } finally { console.log = origLog; }
  assert.equal(process.exitCode || 0, 0);
});
```

- [ ] **Step 2: Implement `packages/cli/src/sync/tick-cmd.mjs`**

Replace with:

```js
import path from "node:path";
import fs from "node:fs/promises";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { readSyncConfig, writeSyncConfig } from "../../../core/src/sync-config.mjs";
import { createGit } from "./git.mjs";
import { runTick } from "./tick.mjs";
import { readOptionValue } from "../lib/args.mjs";

async function appendEvent(aiosPath, evt) {
  const eventsPath = path.join(aiosPath, "memory", "events.jsonl");
  try {
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.appendFile(eventsPath, JSON.stringify({ ...evt, at: evt.at ?? new Date().toISOString() }) + "\n");
  } catch {
    // events log is best-effort
  }
}

export async function runTickCommand(args = []) {
  const aiosPath = path.resolve(expandHome(readOptionValue(args, "--path") || defaultAiosPath()));

  const result = await runTick({
    readConfig: () => readSyncConfig(),
    writeConfig: (patch) => writeSyncConfig(patch),
    makeGit: () => createGit({ cwd: aiosPath }),
    appendEvent: (evt) => appendEvent(aiosPath, evt),
    now: () => Date.now()
  });

  // Quiet when running from heartbeat / hook; verbose only with --verbose
  if (args.includes("--verbose")) {
    console.log(JSON.stringify(result));
  }
}
```

- [ ] **Step 3: Run test, expect PASS**

Run: `node --test tests/cli/sync_tick.test.mjs`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/sync/tick-cmd.mjs tests/cli/sync_tick.test.mjs
git commit -m "feat(sync): wire sync tick subcommand to runTick"
```

---

## Task 14: `sync setup` orchestration

This is the user-visible flow. Pseudo-code:

```
1. Print: "Step 1/4 — Sign in to GitHub"
2. requestDeviceCode → print user code + URL
3. pollForToken (with sleep) until accessToken
4. fetchUsername → store both in sync-config

5. Print: "Step 2/4 — Create your memory repo"
6. Print: "Opening github.com/new (pre-filled) in your browser..."
7. Open buildCreateRepoUrl(username) via `open` (mac) / `xdg-open` (linux) / `start` (win)
8. pollForRepoExists(username/username-aios) — shows a spinner until 200

9. Print: "Step 3/4 — Initial upload"
10. Read templates/sync-gitignore.template → content
11. initialMirrorPush(aiosPath, accessToken, fullName, gitignoreContent, git)
12. Save repo_url + repo_full_name to sync-config

13. Print: "Step 4/4 — Background sync"
14. installHeartbeat({ binary: process.argv0 path })
15. Run one immediate tick (so the user's repo is fresh in seconds, not 5 minutes)

16. Print phone-access summary block (3 options: Claude Projects, Codex Mobile, GitHub Mobile)
```

**Files:**
- Modify: `packages/cli/src/sync/setup-flow.mjs` (replace stub)
- Create: `tests/cli/sync_setup.test.mjs`

- [ ] **Step 1: Write failing test (fully stubbed orchestration)**

Create `tests/cli/sync_setup.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { orchestrateSetup } from "../../packages/cli/src/sync/setup-flow.mjs";

test("orchestrateSetup runs all 4 steps in order on happy path", async () => {
  const calls = [];
  await orchestrateSetup({
    clientId: "ID",
    aiosPath: "/tmp/aios-test",
    gitignoreContent: ".env\n",
    requestDeviceCode: async () => {
      calls.push("requestDeviceCode");
      return { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", deviceCode: "DC", intervalSec: 0, expiresInSec: 900 };
    },
    pollForToken: async () => { calls.push("pollForToken"); return { accessToken: "T" }; },
    fetchUsername: async () => { calls.push("fetchUsername"); return "alice"; },
    writeConfig: async (patch) => { calls.push("writeConfig"); return patch; },
    openInBrowser: async () => { calls.push("openInBrowser"); },
    pollForRepoExists: async () => { calls.push("pollForRepoExists"); return true; },
    initialMirrorPush: async () => { calls.push("initialMirrorPush"); },
    installHeartbeat: async () => { calls.push("installHeartbeat"); },
    runFirstTick: async () => { calls.push("runFirstTick"); },
    log: () => {}
  });
  assert.deepEqual(calls, [
    "requestDeviceCode",
    "pollForToken",
    "fetchUsername",
    "writeConfig",       // token + username
    "openInBrowser",
    "pollForRepoExists",
    "writeConfig",       // repo url + full_name
    "initialMirrorPush",
    "installHeartbeat",
    "runFirstTick"
  ]);
});

test("orchestrateSetup surfaces failure if mirror push fails (does not silently swallow)", async () => {
  await assert.rejects(orchestrateSetup({
    clientId: "ID",
    aiosPath: "/tmp/x",
    gitignoreContent: ".env",
    requestDeviceCode: async () => ({ userCode: "X", verificationUri: "u", deviceCode: "DC", intervalSec: 0 }),
    pollForToken: async () => ({ accessToken: "T" }),
    fetchUsername: async () => "u",
    writeConfig: async () => {},
    openInBrowser: async () => {},
    pollForRepoExists: async () => true,
    initialMirrorPush: async () => { throw new Error("push failed"); },
    installHeartbeat: async () => {},
    runFirstTick: async () => {},
    log: () => {}
  }), /push failed/);
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/cli/sync_setup.test.mjs`
Expected: 2 fail.

- [ ] **Step 3: Implement `packages/cli/src/sync/setup-flow.mjs`**

Replace stub with:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultAiosPath, expandHome } from "../../../core/src/paths.mjs";
import { writeSyncConfig } from "../../../core/src/sync-config.mjs";
import { requestDeviceCode, pollForToken, fetchUsername } from "./auth.mjs";
import {
  buildCreateRepoUrl,
  pollForRepoExists,
  initialMirrorPush
} from "./repo.mjs";
import { createGit } from "./git.mjs";
import { installHeartbeat } from "./heartbeat.mjs";
import { runTick } from "./tick.mjs";

const CLIENT_ID = process.env.DOTAIOS_GH_CLIENT_ID || "Iv23liUNREGISTERED_PLACEHOLDER";

function defaultOpenInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "cmd"  :
                                    "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function loadGitignoreTemplate() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // packages/cli/src/sync/ → repo-root/templates/sync-gitignore.template
  const tplPath = path.resolve(here, "../../../../templates/sync-gitignore.template");
  return fs.readFile(tplPath, "utf8");
}

export async function orchestrateSetup({
  clientId,
  aiosPath,
  gitignoreContent,
  requestDeviceCode: requestDeviceCodeImpl,
  pollForToken: pollForTokenImpl,
  fetchUsername: fetchUsernameImpl,
  writeConfig,
  openInBrowser,
  pollForRepoExists: pollForRepoExistsImpl,
  initialMirrorPush: initialMirrorPushImpl,
  installHeartbeat: installHeartbeatImpl,
  runFirstTick,
  log = console.log
}) {
  log("Step 1/4 — Sign in to GitHub");
  const dc = await requestDeviceCodeImpl({ clientId });
  log(`  → Opening ${dc.verificationUri} in your browser…`);
  log(`  → Enter this code: ${dc.userCode}`);
  await openInBrowser(dc.verificationUri);
  const tok = await pollForTokenImpl({ clientId, deviceCode: dc.deviceCode, intervalSec: dc.intervalSec });
  const username = await fetchUsernameImpl({ accessToken: tok.accessToken });
  await writeConfig({ client_id: clientId, access_token: tok.accessToken, username, installed_at: new Date().toISOString() });
  log(`  ✓ Signed in as @${username}`);

  log("");
  log("Step 2/4 — Create your memory repo");
  const fullName = `${username}/${username}-aios`;
  const createUrl = buildCreateRepoUrl(username);
  log(`  → Opening github.com/new (pre-filled) in your browser…`);
  log(`  → Click "Create repository" on GitHub's page (we don't have permission to do it for you).`);
  await openInBrowser(createUrl);
  await pollForRepoExistsImpl({ accessToken: tok.accessToken, fullName });
  await writeConfig({
    repo_full_name: fullName,
    repo_url: `https://github.com/${fullName}.git`
  });
  log(`  ✓ Repo created: ${fullName} (private)`);

  log("");
  log("Step 3/4 — Initial upload");
  await initialMirrorPushImpl({ aiosPath, accessToken: tok.accessToken, fullName, gitignoreContent });
  log("  ✓ Files pushed");

  log("");
  log("Step 4/4 — Background sync");
  await installHeartbeatImpl();
  await runFirstTick();
  log("  ✓ Installed sync schedule (every 5 minutes + on every dotaios command)");

  log("");
  log("Your memory now syncs automatically. To access from your phone:");
  log("");
  log("  Recommended (free): claude.ai → Projects → New → link your repo. Tap \"Sync now\" before asking.");
  log("  Also free, when your Mac is awake: install ChatGPT mobile, scan the QR from Codex desktop.");
  log("  No-AI fallback: install GitHub Mobile to browse and edit the repo manually.");
}

export async function runSetup(args = []) {
  // top-level entry; reads gitignore from package, wires real deps, calls orchestrateSetup
  const aiosPath = path.resolve(expandHome(defaultAiosPath()));
  const gitignoreContent = await loadGitignoreTemplate();

  await orchestrateSetup({
    clientId: CLIENT_ID,
    aiosPath,
    gitignoreContent,
    requestDeviceCode,
    pollForToken,
    fetchUsername,
    writeConfig: (patch) => writeSyncConfig(patch),
    openInBrowser: async (url) => defaultOpenInBrowser(url),
    pollForRepoExists,
    initialMirrorPush: async ({ aiosPath: p, accessToken, fullName, gitignoreContent: g }) => {
      const git = createGit({ cwd: p });
      await initialMirrorPush({ aiosPath: p, accessToken, fullName, gitignoreContent: g, git });
    },
    installHeartbeat: async () => installHeartbeat({ binary: process.argv0 }),
    runFirstTick: async () => {
      const git = createGit({ cwd: aiosPath });
      await runTick({
        readConfig: () => import("../../../core/src/sync-config.mjs").then((m) => m.readSyncConfig()),
        writeConfig: (patch) => writeSyncConfig(patch),
        makeGit: () => git,
        appendEvent: async () => {},
        now: () => Date.now()
      });
    }
  });
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `node --test tests/cli/sync_setup.test.mjs`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/setup-flow.mjs tests/cli/sync_setup.test.mjs
git commit -m "feat(sync): sync setup orchestration"
```

---

## Task 15: `sync status`, `sync repo`, `sync logout` subcommands

**Files:**
- Modify: `packages/cli/src/sync/status-cmd.mjs`, `repo-cmd.mjs`, `logout-cmd.mjs`
- Create: `tests/cli/sync_status.test.mjs`

- [ ] **Step 1: Write failing test**

Create `tests/cli/sync_status.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderStatus } from "../../packages/cli/src/sync/status-cmd.mjs";

test("renderStatus prints 'sync is OFF' when no config", () => {
  const out = renderStatus(null);
  assert.ok(out.includes("OFF"));
  assert.ok(out.includes("dotaios sync setup"));
});

test("renderStatus prints repo + last tick when config present", () => {
  const out = renderStatus({
    username: "alice",
    repo_full_name: "alice/alice-aios",
    last_tick_at: "2026-05-19T14:00:00.000Z",
    last_push_sha: "abc1234567",
    last_error: null
  });
  assert.ok(out.includes("alice/alice-aios"));
  assert.ok(out.includes("abc1234"));
  assert.ok(out.includes("2026-05-19"));
});

test("renderStatus calls out last_error when present", () => {
  const out = renderStatus({
    username: "alice",
    repo_full_name: "alice/alice-aios",
    last_tick_at: "2026-05-19T14:00:00.000Z",
    last_error: "Bad credentials"
  });
  assert.ok(out.includes("Bad credentials"));
});
```

- [ ] **Step 2: Implement the three subcommand files**

`packages/cli/src/sync/status-cmd.mjs`:

```js
import { readSyncConfig } from "../../../core/src/sync-config.mjs";

export function renderStatus(cfg) {
  if (!cfg?.access_token) {
    return [
      "Sync is OFF.",
      "",
      "Run: dotaios sync setup"
    ].join("\n");
  }
  const lines = [
    `Sync is ON.`,
    `  GitHub user:    @${cfg.username}`,
    `  Repo:           ${cfg.repo_full_name}`,
    `  Last tick:      ${cfg.last_tick_at || "(never)"}`,
    `  Last push sha:  ${cfg.last_push_sha ? cfg.last_push_sha.slice(0, 7) : "(none)"}`
  ];
  if (cfg.last_error) lines.push(`  Last error:     ${cfg.last_error}`);
  return lines.join("\n");
}

export async function runStatus() {
  const cfg = await readSyncConfig();
  console.log(renderStatus(cfg));
}
```

`packages/cli/src/sync/repo-cmd.mjs`:

```js
import { readSyncConfig } from "../../../core/src/sync-config.mjs";

export async function runRepo() {
  const cfg = await readSyncConfig();
  if (!cfg?.repo_full_name) {
    console.error("Sync not set up. Run: dotaios sync setup");
    process.exitCode = 1;
    return;
  }
  console.log(`https://github.com/${cfg.repo_full_name}`);
}
```

`packages/cli/src/sync/logout-cmd.mjs`:

```js
import fs from "node:fs/promises";
import { syncConfigPath } from "../../../core/src/paths.mjs";
import { removeHeartbeat } from "./heartbeat.mjs";

export async function runLogout() {
  try { await removeHeartbeat(); } catch (e) { console.error(`(heartbeat remove failed: ${e.message})`); }
  await fs.rm(syncConfigPath(), { force: true });
  console.log("Signed out. Your repo on GitHub is intact.");
}
```

- [ ] **Step 3: Run test, expect PASS**

Run: `node --test tests/cli/sync_status.test.mjs`
Expected: 3 pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/sync/status-cmd.mjs packages/cli/src/sync/repo-cmd.mjs packages/cli/src/sync/logout-cmd.mjs tests/cli/sync_status.test.mjs
git commit -m "feat(sync): status, repo, logout subcommands"
```

---

## Task 16: Setup wizard prompt — offer sync during `dotaios setup`

**Files:**
- Modify: `packages/cli/src/commands/setup.mjs`
- Test: extend existing `tests/cli/setup.test.mjs` if a quick assertion fits; otherwise create `tests/cli/sync_setup_prompt.test.mjs`

- [ ] **Step 1: Locate the right place in `setup.mjs`**

Open `packages/cli/src/commands/setup.mjs`. After Step 3 (reveal) and before the existing "brief schedule prompt", insert a new prompt block.

- [ ] **Step 2: Add prompt logic**

```js
// After the existing reveal step, before the brief schedule prompt:

if (!nonInteractive && process.stdin.isTTY) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("\nConnect to GitHub for cross-device access? (Y/n) ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      const { runSetup } = await import("../sync/setup-flow.mjs");
      try {
        await runSetup([]);
      } catch (err) {
        console.error(`Sync setup failed: ${err.message}`);
        console.error("You can retry later with: dotaios sync setup");
      }
    }
  } finally { rl.close(); }
}
```

- [ ] **Step 3: Smoke test**

Run interactively:
```bash
node packages/cli/src/index.mjs setup --path /tmp/aios-test --yes --skip-reveal
```
Expected: With `--yes`, the new prompt is skipped (no hang). Behavior unchanged.

- [ ] **Step 4: Run full setup test suite**

Run: `node --test tests/cli/setup.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/setup.mjs
git commit -m "feat(sync): offer GitHub sync during dotaios setup"
```

---

## Task 17: `process-inbox` skill template + AGENTS.md rule

**Files:**
- Create: `templates/skills/process-inbox/SKILL.md`
- Modify: `templates/AGENTS.md.hbs`
- Test: extend existing template tests (`tests/core/render.test.mjs`) to assert the inbox rule is in `AGENTS.md`

- [ ] **Step 1: Write failing template test**

Append to `tests/core/render.test.mjs`:

```js
test("AGENTS.md template includes inbox routing rule", async () => {
  const file = path.join(new URL("../..", import.meta.url).pathname, "templates", "AGENTS.md.hbs");
  const content = await fs.readFile(file, "utf8");
  assert.ok(/memory\/inbox/.test(content), "AGENTS.md should mention memory/inbox");
  assert.ok(/process-inbox/.test(content), "AGENTS.md should reference the process-inbox skill");
});

test("process-inbox SKILL.md ships in templates", async () => {
  const file = path.join(new URL("../..", import.meta.url).pathname, "templates", "skills", "process-inbox", "SKILL.md");
  const content = await fs.readFile(file, "utf8");
  assert.ok(content.length > 200, "SKILL.md should be substantive");
  assert.ok(content.toLowerCase().includes("inbox"));
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `node --test tests/core/render.test.mjs`
Expected: 2 fail.

- [ ] **Step 3: Create `templates/skills/process-inbox/SKILL.md`**

```markdown
---
name: process-inbox
description: "Read memory/inbox/*.md (writes captured from the user's phone), file each into the right vault location, then delete the inbox file."
---

# process-inbox

The user's phone-side AI agents drop new memory writes into `memory/inbox/<timestamp>-<slug>.md`. Each file has YAML frontmatter (`source`, `device`, `captured_at`, optional `hint`) and a body. Your job is to file every such file into the right place in the AIOS, then delete the inbox file so it does not get re-processed.

## When to run

Run this skill at the start of any local session if `memory/inbox/` contains any `*.md` files.

## How to file each inbox entry

For each file in `memory/inbox/*.md`, read the frontmatter and the body, then pick the best destination:

| Body looks like… | File to |
|---|---|
| A person, company, or thing the user met / mentioned | `vault/org/people/<slug>.md`, `vault/org/companies/<slug>.md`, or `vault/org/things/<slug>.md` |
| A URL or article reference | `vault/raw/<slug>.md` |
| A todo / next action / reminder | append to `context/work.md` under "Inbox" |
| A short note, idea, fact about the day | append to today's daily note in `memory/daily/YYYY-MM-DD.md` |
| Updates the user's own profile or preferences | edit the relevant `context/*.md` (ask the user first if unclear) |

If the `hint:` field in the frontmatter tells you where to file it, prefer that.

## After filing

For each successfully filed entry:

1. Append a one-line note in `memory/events.jsonl`: `{"type":"inbox-processed","filed_to":"<path>","from":"<inbox-filename>"}`.
2. Delete the inbox file with `git rm` (so the next sync push removes it from GitHub).
3. Continue to the next file.

## When something is malformed

If the file has no usable content, or the YAML frontmatter is broken, leave it in `memory/inbox/` and tell the user during the session so they can decide.

## Don't

- Don't move inbox files between sessions silently — always tell the user how many you processed.
- Don't delete an inbox file you couldn't successfully file somewhere else.
- Don't write back to `memory/inbox/` from local code.
```

- [ ] **Step 4: Modify `templates/AGENTS.md.hbs`**

Find the `## Rules` section and append:

```
- If `memory/inbox/` contains files, read them first and use the `process-inbox` skill to file them into the right vault location, then delete the inbox file.
```

- [ ] **Step 5: Run test, expect PASS**

Run: `node --test tests/core/render.test.mjs`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add templates/skills/process-inbox/SKILL.md templates/AGENTS.md.hbs tests/core/render.test.mjs
git commit -m "feat(sync): ship process-inbox skill + AGENTS.md routing rule"
```

---

## Task 18: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a new section after the existing capture/session section**

Add this content (placement: between existing sections, find a natural spot):

```markdown
## Cross-device sync (new in v1.5)

DotAIOS can mirror your `~/aios/` folder to a private GitHub repo so your memory follows you across devices.

### Setup

```bash
dotaios sync setup
```

You'll sign in to GitHub once with a device code (paste in your browser — no PATs, no `gh` CLI), click "Create repository" on GitHub's own page, and DotAIOS pushes your folder. After that, every change syncs automatically — on every `dotaios` command and every 5 minutes in the background.

### Use your memory from your phone

Pick whichever fits your setup:

- **Free, recommended:** Open `claude.ai`, create a Project, link your `<username>-aios` repo. Tap "Sync now" before asking. Free Claude tier supports this as of February 2026.
- **Free, also nice:** Install ChatGPT on your phone, scan the QR code from the Codex desktop app — your phone now chats with the Codex on your Mac, which reads your live `~/aios/` directly. Requires your Mac to be awake. (Available since May 14, 2026.)
- **No-AI fallback:** Install GitHub Mobile. Browse and edit your repo manually. Anything you write in `memory/inbox/` gets filed by your desktop agent on next session.

### Phone writes never break your local work

When your phone-side agent (or you, via GitHub Mobile) writes a new memory, it goes into `memory/inbox/<timestamp>.md`. Your local agent uses the bundled `process-inbox` skill to file it into the right place, then deletes the inbox file. You never see a merge conflict.

### Commands

```
dotaios sync setup       # one-time
dotaios sync status      # last tick, repo URL
dotaios sync tick        # force one immediate push+pull
dotaios sync repo        # print your repo URL
dotaios sync logout      # sign out, remove background schedule (keeps repo)
```

> ⚠️ Requires a free GitHub account. If you don't have one, sign up at https://github.com/signup before running `dotaios sync setup`.
```

- [ ] **Step 2: Verify README parses**

Open `README.md` in any markdown previewer and verify the section renders.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add cross-device sync section to README"
```

---

## Final task: Run the full suite + manual smoke

- [ ] **Step 1: Full test run**

Run: `node --test tests/**/*.test.mjs`
Expected: all tests green. Existing 271 tests + ~25 new ones = ~296 passing.

- [ ] **Step 2: Lint with `node --check`**

Run: `find packages/cli/src/sync -name "*.mjs" -exec node --check {} \;` and same for `packages/core/src/sync-config.mjs`.
Expected: no output (silent = OK).

- [ ] **Step 3: Manual smoke (no real GitHub call) — `dotaios sync --help`**

Run: `node packages/cli/src/index.mjs sync --help`
Expected: prints the help text from Task 12.

- [ ] **Step 4: Manual smoke — `dotaios sync status` with no config**

Run: `node packages/cli/src/index.mjs sync status`
Expected: `Sync is OFF.\n\nRun: dotaios sync setup`.

- [ ] **Step 5: Manual smoke — `dotaios sync tick` with no config**

Run: `node packages/cli/src/index.mjs sync tick --verbose`
Expected: `{"skipped":"no-token"}`.

- [ ] **Step 6: Final commit (if anything fell out of earlier commits)**

```bash
git status
# only commit if there are stragglers
```

---

## Manual end-to-end test plan (run after Filippo registers the real GitHub App)

These are NOT automated — they need a real GitHub account.

1. `dotaios sync setup` on a clean machine. Confirm:
   - Device code pasted at github.com/login/device, approval prompt shows "DotAIOS Sync".
   - Browser pops to `github.com/new` with name + visibility pre-filled.
   - After clicking Create, terminal proceeds within 5 sec.
   - `dotaios sync status` shows ON, repo URL, recent tick.
   - The repo on GitHub contains the AIOS folder + `.gitignore`.

2. Edit `context/work.md` locally, save. Run `dotaios sync status` after 5 sec — `last_push_sha` should change. Confirm new commit on GitHub.

3. From GitHub Mobile or web UI, add `memory/inbox/2026-05-19T15-00-00Z-test.md` with:
   ```
   ---
   source: phone
   device: github-web
   captured_at: 2026-05-19T15:00:00Z
   hint: "this is a test entry"
   ---
   Test inbox entry.
   ```
4. Wait 5 min (or `dotaios sync tick` manually). File should appear under `~/aios/memory/inbox/`.

5. Run Claude Code / Codex locally with `~/aios/` as the AIOS folder. Confirm it reads the inbox file, files it somewhere (per `process-inbox` skill), and `git rm`s it. Next sync push should remove it from GitHub too.

6. `dotaios sync logout`. Confirm `~/.dotaios/sync.json` gone, heartbeat removed (`launchctl list | grep dotaios` empty on macOS).

7. Re-run `dotaios sync setup`. Confirm token re-creation works (existing repo is detected and reused, no error).

---

## Self-Review

**Spec coverage:**
- ✅ Auth: device flow (Tasks 4, 14)
- ✅ Repo create: deep-link (Task 5, 14)
- ✅ Initial mirror push (Tasks 5, 14)
- ✅ CLI hook + heartbeat sync model (Tasks 7, 8, 9, 10, 11)
- ✅ Conflict policy (Task 7)
- ✅ Inbox semantics + skill (Task 17)
- ✅ `.gitignore` shipped (Task 6)
- ✅ Setup wizard prompt (Task 16)
- ✅ All CLI subcommands: `setup`, `tick`, `status`, `logout`, `repo` (Tasks 12, 13, 14, 15)
- ✅ Token storage (Task 2)
- ✅ Rate-limit gap enforced (Task 7)
- ✅ Phone-read documentation (Task 18)

**Placeholder scan:** None. Every step has the actual code or command. Placeholder GitHub App client_id is documented as a TODO swap-in step.

**Type consistency:** `git` object methods used consistently across tasks: `dirty()`, `commitAll(message)`, `push(branch)`, `fetch()`, `ffPull(branch)`, `currentSha()`, `branchFromSha(name, sha)`, `hardResetToOrigin(branch)`, `init()`, `addRemote(url)`, `raw(args)`. Tick uses all of them; tests stub them with matching names.

**Engineer must know before starting:**
- Get the real `GITHUB_APP_CLIENT_ID` from Filippo. Put it in `process.env.DOTAIOS_GH_CLIENT_ID` or commit the placeholder and swap during release.
- Do not add npm dependencies. Everything is `node:` built-in or shell-out.
- Tests must be runnable without network. All network/spawn/fs calls are injectable.
- Do not amend commits. Make new commits per step.
