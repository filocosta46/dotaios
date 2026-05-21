import fs from "node:fs/promises";

const MIN_TICK_GAP_MS = 10_000;
const STALE_LOCK_MS = 5 * 60 * 1000;

/**
 * Acquire an exclusive lock file. Returns true if acquired, false if a fresh
 * lock is already held by another tick. A lock older than staleMs is treated
 * as abandoned (crashed process) and stolen.
 */
export async function acquireLock(lockPath, { now = () => Date.now(), staleMs = STALE_LOCK_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      // steal: remove and retry the exclusive create once more
      await fs.rm(lockPath, { force: true });
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

  const locked = await acquireLock(lockPath, { now });
  if (!locked) return { skipped: "locked" };

  const git = makeGit();
  const startedIso = new Date(now()).toISOString();

  try {
    // 1. Commit local changes FIRST — rebase refuses to run on a dirty tree.
    let pushedSha = null;
    if (await git.dirty()) {
      pushedSha = await git.commitAll(`sync: ${startedIso}`);
    }

    // 2. Pull by rebasing the local commit(s) on top of origin.
    const pullResult = await git.pullRebase("main");

    // 3. A real same-file conflict is the only case that needs the escape
    //    hatch: park the (already-aborted, restored) local commit on a branch
    //    so it is recoverable, then align main with origin. Any other
    //    divergence rebased cleanly above and needs nothing special.
    let pushed = false;
    if (pullResult === "conflict") {
      const localSha = await git.currentSha();
      const branchName = `local-${startedIso.replace(/[:.]/g, "-")}`;
      await git.branchFromSha(branchName, localSha);
      await git.hardResetToOrigin("main");
      await appendEvent({ type: "sync-conflict", branch: branchName, at: startedIso });
    } else if (pushedSha) {
      // 4. Local commit (now replayed on top of origin) goes up.
      await git.push("main");
      pushed = true;
    }

    await writeConfig({
      last_tick_at: startedIso,
      last_push_sha: pushed ? pushedSha : (cfg.last_push_sha ?? null),
      last_pull_at: startedIso,
      last_error: null
    });

    return {
      pulled: pullResult,
      pushed,
      sha: pushed ? pushedSha : null
    };
  } catch (err) {
    // Best-effort: persisting the error must never itself cause runTick to throw.
    try {
      await writeConfig({ last_error: err.message, last_tick_at: startedIso });
    } catch { /* swallow — error reporting is best-effort */ }
    try {
      await appendEvent({ type: "sync-error", reason: err.message, at: startedIso });
    } catch { /* swallow */ }
    return { error: err.message };
  } finally {
    try {
      await releaseLock(lockPath);
    } catch { /* swallow — lock removal is best-effort; stale-steal recovers it */ }
  }
}
