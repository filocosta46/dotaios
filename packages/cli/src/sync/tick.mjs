import {
  githubRepoIdentity,
  plainRemoteUrl,
  verifyRepoPrivate as defaultVerifyRepoPrivate
} from "./repo.mjs";
import { acquireOperationLock, releaseOperationLock } from "./operation-lock.mjs";

const MIN_TICK_GAP_MS = 10_000;
const SYNC_CONFLICT_SUMMARY =
  "Sync stopped because local and remote changes overlap. Your pre-existing edits were preserved. DotAIOS recorded the conflict locally and did not create a recovery branch, reset files, or push. Ask your agent to resolve it safely, then run `dotaios sync now` again.";
// Git reported changes in the folder, but staging them produced nothing to
// commit. The usual cause is a nested project repository: its own commits move
// while the pointer recorded in this repo does not, so every tick sees a dirty
// tree, stages nothing, and used to report success. Left silent this repeats
// forever while the user's work is never mirrored.
export const SYNC_STALLED_SUMMARY =
  "Sync found changes in your folder but had nothing it could record. This usually means a project inside your AIOS folder has its own Git repository, which Git stores as a pointer rather than as files. Ask your agent to inspect the folder for nested Git repositories. Nothing was lost, and nothing was pushed.";

export async function runTick({
  lockPath,
  readConfig,
  writeConfig,
  makeGit,
  verifyRepoPrivate = defaultVerifyRepoPrivate,
  appendEvent,
  now = () => Date.now()
}) {
  const operationLock = await acquireOperationLock(lockPath, { now });
  if (!operationLock) return { skipped: "locked" };
  const startedIso = new Date(now()).toISOString();

  try {
    const cfg = await readConfig();
    if (!cfg?.access_token) return { skipped: "no-token" };

    if (cfg.last_tick_at) {
      const last = Date.parse(cfg.last_tick_at);
      if (Number.isFinite(last) && now() - last < MIN_TICK_GAP_MS) {
        return { skipped: "rate-limit-gap" };
      }
    }

    // Inspect checkout identity in a Git process that has no sync token. The
    // token is not allowed into Git until origin is bound to the configured repo.
    const inspectionGit = makeGit({ accessToken: null, expectedRepoFullName: null });
    let currentBranch = null;
    try {
      currentBranch = await inspectionGit.currentBranch();
    } catch {
      // An unknown checkout is not safe to mutate.
    }
    if (currentBranch !== "main") return { skipped: "not-main-branch" };

    const expectedIdentity = githubRepoIdentity(plainRemoteUrl(cfg.repo_full_name || ""));
    const originIdentity = githubRepoIdentity(await inspectionGit.originUrl());
    if (!expectedIdentity || originIdentity !== expectedIdentity) {
      throw new Error(
        `the configured Git origin does not match the private sync repository ${cfg.repo_full_name || "(unknown)"}. ` +
        `Sync stopped before sending credentials or changing Git.`
      );
    }
    if (typeof verifyRepoPrivate !== "function") {
      throw new Error("sync privacy verification is unavailable");
    }
    await verifyRepoPrivate({
      accessToken: cfg.access_token,
      fullName: cfg.repo_full_name
    });
    const git = makeGit({
      accessToken: cfg.access_token,
      expectedRepoFullName: cfg.repo_full_name
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
    const pullResult = await git.pullRebase("main", {
      lastPushSha: cfg.last_push_sha ?? null
    });

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

    const hasUnpushedCommit = pushedSha
      ? true
      : pullResult === "empty"
        ? true
        : await git.hasUnpushedCommits("main");
    if (hasUnpushedCommit) {
      // 4. A new local commit, or one left by an earlier failed push, goes up.
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
      outcome: "success",
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
      await releaseOperationLock(operationLock);
    } catch { /* swallow — lock removal is best-effort; stale-steal recovers it */ }
  }
}
