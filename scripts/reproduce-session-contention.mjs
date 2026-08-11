#!/usr/bin/env node
// Make the session-store contention failure go red on demand.
//
// Why this exists: the failure only ever appeared in CI, on two cores. Locally
// the 32-writer acceptance test passed, so five rounds of hardening were aimed
// at a fault nobody could make fail. This script is the missing hook. Run it
// before forming a theory, and again after changing anything.
//
//   node scripts/reproduce-session-contention.mjs [writers] [rounds]
//
// Writers default to 32, rounds to 5. What matters is writers per core, not
// writers: CI runs 32 on 2 cores, so on an 8-core machine use ~96 to feel the
// same pressure. On 8 cores, 32 writers is roughly 1 red round in 5, and 96 is
// most rounds red on an unfixed tree.
//
// A round is red if any writer failed, if the session was created more than
// once, or if two writers grew it to the same length. "refused" is not red:
// capture reports contention as a value, and the caller is expected to retry.
//
// Bounded on purpose: fixed round count, a 90s hard kill per child, and every
// temporary root removed. Nothing survives the run.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRITERS = Number(process.argv[2] || 32);
const ROUNDS = Number(process.argv[3] || 5);
const CHILD_TIMEOUT_MS = 90_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, "..", "tests", "fixtures", "session-store-writer.mjs");

if (!fs.existsSync(WORKER)) {
  console.error(`Missing writer fixture: ${WORKER}`);
  process.exit(2);
}

function runWriter(aiosPath, turns) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, "write", aiosPath, String(turns)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const guard = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      if (code === 0) {
        try { return resolve({ ok: true, ...JSON.parse(out) }); }
        catch { return resolve({ ok: false, code: "UNPARSEABLE_RESULT", err }); }
      }
      const matched = err.match(/code: '([A-Z_]+)'/);
      resolve({ ok: false, code: matched ? matched[1] : `exit=${code ?? signal}`, err });
    });
    child.on("error", (error) => {
      clearTimeout(guard);
      resolve({ ok: false, code: `SPAWN_${error.code}` });
    });
  });
}

function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dotaios-contention-"));
  fs.writeFileSync(path.join(root, "aios.json"), "{}\n");
  fs.writeFileSync(path.join(root, "shared-transcript.jsonl"), JSON.stringify({
    agent: "claude-code",
    session_id: "source01",
    captured_at: "2026-08-11T10:00:00.000Z",
    source_type: "claude-code",
    title: "turn-1",
    turns: Array.from({ length: WRITERS }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index + 1}`,
    })),
  }));
  return root;
}

const failureCodes = new Map();
let redRounds = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
  const root = seedRoot();
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_, index) => runWriter(root, index + 1)),
  );
  const elapsed = Date.now() - startedAt;

  const failed = results.filter((result) => !result.ok);
  const created = results.filter((result) => result.ok && result.outcome === "created").length;
  const refused = results.filter((result) => result.ok && result.outcome === "refused").length;
  const grownLengths = results
    .filter((result) => result.ok && result.outcome === "grown")
    .map((result) => result.session.turns.length);
  const duplicateGrowth = grownLengths.length !== new Set(grownLengths).size;

  for (const failure of failed) {
    failureCodes.set(failure.code, (failureCodes.get(failure.code) || 0) + 1);
  }

  const red = failed.length > 0 || created !== 1 || duplicateGrowth;
  if (red) redRounds += 1;

  console.log(
    `round ${String(round).padStart(2)}  ${red ? "RED  " : "green"}  ${String(elapsed).padStart(6)}ms  `
    + `created=${created} grown=${grownLengths.length} refused=${refused} failed=${failed.length}`
    + (duplicateGrowth ? "  DUPLICATE-GROWTH" : "")
    + (failed.length ? `  [${[...new Set(failed.map((f) => f.code))].join(", ")}]` : ""),
  );

  if (failed.length) {
    const trace = path.join(os.tmpdir(), "dotaios-contention-first-failure.txt");
    if (!fs.existsSync(trace)) {
      fs.writeFileSync(trace, failed[0].err || "(empty)");
      console.log(`  first failure trace -> ${trace}`);
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nwriters=${WRITERS}  rounds=${ROUNDS}  red=${redRounds}/${ROUNDS}  cores=${os.cpus().length}`);
if (failureCodes.size) {
  console.log("failure codes:");
  for (const [code, count] of [...failureCodes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}x  ${code}`);
  }
}
process.exitCode = redRounds > 0 ? 1 : 0;
