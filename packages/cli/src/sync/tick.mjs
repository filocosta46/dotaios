import fs from "node:fs/promises";
import { verifyRepoPrivate as defaultVerifyRepoPrivate } from "./repo.mjs";

const MIN_TICK_GAP_MS = 10_000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 5_000;
const SYNC_CONFLICT_SUMMARY =
  "Sync stopped because local and remote changes overlap. Your pre-existing edits were preserved. DotAIOS recorded the conflict locally and did not create a recovery branch, reset files, or push. Ask your agent to resolve it safely, then run `dotaios sync now` again.";
// Git reported changes in the folder, but staging them produced nothing to
// commit. The usual cause is a nested project repository: its own commits move
// while the pointer recorded in this repo does not, so every tick sees a dirty
// tree, stages nothing, and used to report success. Left silent this repeats
// forever while the user's work is never mirrored.
export const SYNC_STALLED_SUMMARY =
  "Sync found changes in your folder but had nothing it could record. This usually means a project inside your AIOS folder has its own Git repository, which Git stores as a pointer rather than as files. Run `dotaios doctor` to see which paths are affected. Nothing was lost, and nothing was pushed.";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Atomically remove a stale lock. rename() is exclusive: if two stealers race,
// exactly one wins the rename and the other gets ENOENT.
async function stealLockFile(lockPath) {
  const moved = `${lockPath}.steal.${process.pid}.${Date.now()}`;
  try {
    await fs.rename(lockPath, moved);
  } catch {
    return false;
  }
  await fs.rm(moved, { force: true });
  return true;
}

/**
 * Acquire an exclusive lock file. Returns true if acquired, false if a fresh
 * lock is already held by another tick. A lock older than staleMs is treated
 * as abandoned (crashed process) and stolen.
 */
export async function acquireLock(lockPath, { now = () => Date.now(), staleMs = STALE_LOCK_MS } = {}) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const fh = await fs.open(lockPath, "wx"); // exclusive create — fails if exists
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
      await fh.close();
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // A lock file exists. Decide if it is stale.
      let stale = false;
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const { at } = JSON.parse(raw);
        stale = !Number.isFinite(at) || now() - at > staleMs;
      } catch {
        // unreadable / corrupt lock — treat as stale
        stale = true;
      }
      if (!stale) return false;
      const stole = await stealLockFile(lockPath);
      if (!stole) await delay(LOCK_RETRY_MS);
    }
  }
  return false;
}

export async function releaseLock(lockPath) {
  await fs.rm(lockPath, { force: true });
}

export async function runTick({
  lockPath,
  readConfig,
  writeConfig,
  makeGit,
  verifyRepoPrivate = defaultVerifyRepoPrivate,
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
  let currentBranch = null;
  try {
    currentBranch = await git.currentBranch();
  } catch {
    // An unknown checkout is not safe to mutate.
  }
  if (currentBranch !== "main") return { skipped: "not-main-branch" };

  const locked = await acquireLock(lockPath, { now });
  if (!locked) return { skipped: "locked" };

  const startedIso = new Date(now()).toISOString();

  try {
    if (typeof verifyRepoPrivate !== "function") {
      throw new Error("sync privacy verification is unavailable");
    }
    await verifyRepoPrivate({
      accessToken: cfg.access_token,
      fullName: cfg.repo_full_name
    });

    // 1. Commit local changes FIRST — rebase refuses to run on a dirty tree.
    let pushedSha = null;
    if (await git.dirty()) {
      pushedSha = await git.commitAll(`sync: ${startedIso}`);
      // dirty() saw changes and commitAll could stage none of them. Record it —
      // writing last_error: null here is what made the stall invisible.
      if (pushedSha === null) {
        const error = new Error(SYNC_STALLED_SUMMARY);
        error.syncStalled = true;
        throw error;
      }
    }

    // 2. Pull by rebasing the local commit(s) on top of origin.
    const pullResult = await git.pullRebase("main");

    // 3. pullRebase aborts a conflicted rebase before returning. The local sync
    //    commit remains, and no remote push or destructive reset occurs.
    let pushed = false;
    let pushedHead = null;
    if (pullResult === "conflict") {
      let eventLogError = null;
      let configError = null;
      try {
        await appendEvent({
          type: "sync-conflict",
          summary: SYNC_CONFLICT_SUMMARY,
          at: startedIso
        });
      } catch (error) {
        eventLogError = error.message;
      }
      try {
        await writeConfig({
          last_tick_at: startedIso,
          last_error: SYNC_CONFLICT_SUMMARY
        });
      } catch (error) {
        configError = error.message;
      }
      return {
        conflict: true,
        pulled: pullResult,
        pushed: false,
        sha: null,
        error: SYNC_CONFLICT_SUMMARY,
        ...(eventLogError && { event_log_error: eventLogError }),
        ...(configError && { config_error: configError })
      };
    }

    if (pushedSha) {
      // 4. Local commit (now replayed on top of origin) goes up.
      await git.push("main");
      // Record the actual HEAD after push: a rebase above may have rewritten
      // the commit, so commitAll's pre-rebase sha can no longer exist.
      pushedHead = await git.currentSha();
      pushed = true;
    }

    await writeConfig({
      last_tick_at: startedIso,
      last_push_sha: pushed ? pushedHead : (cfg.last_push_sha ?? null),
      last_pull_at: startedIso,
      last_error: null
    });

    return {
      pulled: pullResult,
      pushed,
      stalled: false,
      sha: pushed ? pushedHead : null
    };
  } catch (err) {
    // Best-effort: persisting the error must never itself cause runTick to throw.
    try {
      await writeConfig({ last_error: err.message, last_tick_at: startedIso });
    } catch { /* swallow — error reporting is best-effort */ }
    try {
      await appendEvent({ type: "sync-error", reason: err.message, at: startedIso });
    } catch { /* swallow */ }
    return {
      error: err.message,
      ...(err.syncStalled && { stalled: true, pushed: false, sha: null })
    };
  } finally {
    try {
      await releaseLock(lockPath);
    } catch { /* swallow — lock removal is best-effort; stale-steal recovers it */ }
  }
}
