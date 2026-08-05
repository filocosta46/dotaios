import { createGit } from "../../packages/cli/src/sync/git.mjs";

const [cwd, phase] = process.argv.slice(2);
const phases = [
  "after-candidate",
  "after-commit",
  "after-lock",
  "after-prepared",
  "after-transaction-published",
  "after-tombstone"
];
if (!cwd || !phases.includes(phase)) {
  process.stderr.write(`usage: sync-commit-lifecycle-harness.mjs <repo> <${phases.join("|")}>\n`);
  process.exit(2);
}

const stop = () => process.kill(process.pid, "SIGKILL");
const indexTransactionLifecycle = {
  ...(phase === "after-candidate" && { afterCandidateInstalled: stop }),
  ...(phase === "after-commit" && { afterCommit: stop }),
  ...(phase === "after-lock" && { afterLockPublished: stop }),
  ...(phase === "after-prepared" && { afterPreparedTransaction: stop }),
  ...(phase === "after-transaction-published" && { afterTransactionPublished: stop }),
  ...(phase === "after-tombstone" && { afterTransactionTombstoned: stop })
};

await createGit({ cwd, indexTransactionLifecycle }).commitAll("sync lifecycle crash");
process.exit(3);
