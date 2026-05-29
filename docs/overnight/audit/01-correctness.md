# Correctness Audit — packages/cli + packages/core
**Branch:** audit/overnight-2026-05-28  **Version:** 1.17.0  **Auditor:** Claude Sonnet 4.6  **Date:** 2026-05-29

---

## Findings Table

| ID | Severity | Effort | File:Line | Issue | Fix Sketch | Flags |
|----|----------|--------|-----------|-------|-----------|-------|
| C01 | P1 | S | `packages/core/src/sessions.mjs:264-268` | **Stale-lock TOCTOU — can produce two concurrent lock holders.** After `stat(mtime > 10s)` succeeds, another process (C) may acquire the lock. Then process A's `fs.rm(lockPath)` deletes C's fresh lock. C still believes it holds the lock and proceeds; A then succeeds on its retry `open("wx")`. Both run `fn()` concurrently → index read-modify-write race, corrupting `index.jsonl`. | Write PID + `at` into the lock file (as `tick.mjs` already does), then after `rm`, open and check whether the PID still belongs to a live process before stealing. | |
| C02 | P1 | S | `packages/core/src/sessions.mjs:271` | **Deadline bypass runs `fn()` without any lock.** `if (Date.now() > deadline) return fn();` — two concurrent waiters that both timeout will both run `fn()` unprotected, silently corrupting the index. | Replace the bypass with a thrown timeout error: `throw new Error("withIndexLock: timed out after 5s")`. Callers should already be resilient to occasional failures. | |
| C03 | P1 | S | `packages/core/src/search.mjs:386-397` | **Private `readJsonl` in search.mjs throws on any corrupt JSONL line** (`JSON.parse` with no try/catch), unlike the safe sibling in `memory.mjs`. A single malformed byte in `events.jsonl` or any signals file crashes `searchMemoryDir`, the `search_memory` MCP tool, and `buildSessionDigest`. | Either import `readJsonl` from `memory.mjs` (which silently skips bad lines), or wrap line 396 in a `try/catch {}` returning `[]` on the bad line. | |
| C04 | P2 | S | `packages/core/src/sessions.mjs:163` | **`filterSessions` `since` check is wrong for entries with `null`/`undefined` `captured_at`**. `null < "2024-…"` evaluates to `false` in JS, so sessions with no timestamp are never filtered out by `--since`. | Change to: `if (sinceTs && (entry.captured_at == null || entry.captured_at < sinceTs)) return false;` | |
| C05 | P2 | M | `packages/core/src/sessions.mjs:76,113` | **Duplicate-source-path race for new sessions.** If two processes call `writeSession` simultaneously for the same `source_path` when neither has an entry yet, both see `priorEntry = null`, both write a session file, and both append to the index. The index then has two entries for the same source path. Subsequent runs do an update correctly, but there is a window of duplication. | Lift the initial `readSessionIndex` inside `withIndexLock` so the existence check is serialized: one process will find the other's entry and switch to the update path. | |
| C06 | P2 | S | `packages/cli/src/ingest/placement.mjs:68` / `packages/core/src/memory.mjs:122` | **`todayStamp()` (UTC) vs `isoDate()` (local time) divergence for signal placement.** `describeShelfTarget` dry-run shows `todayStamp()` (UTC) as the expected signals file, but the actual `appendSignal` writes to `isoDate(LOCAL)`. For users east of UTC after local midnight, the dry-run displays tomorrow's date while the real file uses today's local date. | Replace `todayStamp()` in `describeShelfTarget` with `isoDate(new Date())` (matching `appendSignal`), or unify both to UTC by converting `appendSignal` to use `toISOString().slice(0,10)`. | |
| C07 | P2 | S | `packages/cli/src/commands/capture.mjs:204,209` | **`captured_at` is dereferenced without null guard in `runList`.** `b.captured_at.localeCompare(…)` and `entry.captured_at.slice(0,10)` both throw if an index entry somehow has `captured_at: null`. All current code sets `captured_at` at creation, but defensive coding prevents a crash on a hand-edited or externally-written index. | Add `?? ""` fallbacks: `(b.captured_at ?? "").localeCompare(a.captured_at ?? "")` and `(entry.captured_at ?? "").slice(0, 10)`. | |
| C08 | P2 | S | `packages/core/src/sync-config.mjs:41` | **`writeSyncConfig` read-modify-write is not guarded by the tick lock.** The `setup-flow.mjs` calls `writeSyncConfig` multiple times during `orchestrateSetup` without holding `acquireLock`. A concurrent tick that is already running could read stale config between step 1 (token written) and step 3 (sha written), dropping one field. The code itself notes this with a TODO on line 40. | Serialise setup-phase config writes with the same `sync.lock` used by `runTick`. | |
| C09 | P3 | S | `packages/cli/src/sync/git.mjs:75-79` | **`parseInt` on `rev-list` output is not guarded against `NaN`.** If `git rev-list --count HEAD..origin/main` returns non-numeric output (e.g., git error), `behind = NaN`, and `NaN === 0` is `false`, so the code proceeds to rebase unnecessarily. | Guard with `if (!Number.isFinite(behind) || behind === 0)`. | |
| C10 | P3 | S | `packages/core/src/sessions.mjs:312-317` | **`stripFrontmatter` fails silently on minimal (empty) frontmatter `---\n---\n`.** `indexOf("\n---", 4)` searches from position 4; the closing `---` at position 3 is not found, so the function returns the full string with frontmatter intact. Session body search then includes YAML noise. | Search from position 0 with `indexOf("\n---\n", 0) + 1` or parse more robustly. | |
| C11 | P3 | S | `packages/cli/src/ingest/placement.mjs:232-273` | **`placeSignal` silently ignores `--overwrite` for inline signals (length ≤ 1500 chars).** For short signals there is no dedup check; `--overwrite` has no effect, and re-ingesting the same short text always appends another JSONL entry. | Document that `--overwrite` is no-op for inline signals, or add source-based dedup to `appendSignal`. | [ICP-RISK if dedup adds complexity] |

---

## Prose on the Top Three Findings

### C01 + C02 — `withIndexLock` Stale-Lock TOCTOU and Deadline Bypass (sessions.mjs)

The session index lock has two distinct holes that can produce concurrent writers without either caller being aware.

**C01 (TOCTOU):** The stale-lock detection path reads the lock file's `mtime`, decides it is stale (> 10 s old), then removes it with `fs.rm`. This is a three-step sequence — `stat → rm → open`. In the gap between `rm` and the subsequent `open("wx")`, a different process (call it C) may have just acquired the lock successfully. Process A's `rm` deletes C's valid lock. C does not check after acquiring the lock; it proceeds with the index read-modify-write. Milliseconds later, A's `open("wx")` succeeds on the now-empty path, and A also runs its read-modify-write. Both operations are in flight simultaneously. The final `writeSessionIndex` (an atomic rename of a `.tmp` file) means each write is individually atomic, but neither sees the other's in-flight changes — whoever renames last wins, and the other process's changes are silently dropped. On a fast machine with high session-capture frequency (e.g., an agent importing many sessions), the window is small but real. The fix is to write the holder's PID into the lock file (which `tick.mjs` already does for `sync.lock`) and verify live-ness before stealing.

**C02 (Deadline):** The 5 s deadline fallback (`return fn()`) is even simpler to trigger: if the lock is continuously held for 5 s (possible during a slow git rebase or large index write), every queued waiter runs `fn()` without any synchronization, turning the serialisation into a free-for-all. The intent is "never hang the CLI", which is correct; but the remedy should be a loud `throw` rather than a silent unsynchronised execution.

**Practical impact:** Most users run one agent at a time, so the race window is rarely open. But non-technical ICP users using both the CLI and the MCP server simultaneously (e.g., Claude Code + Gemini hook in the same second) can trigger it.

---

### C03 — Corrupt JSONL Crashes Search and MCP (search.mjs)

`packages/core/src/search.mjs` defines a **private** `readJsonl` helper (line 386) that does not guard `JSON.parse`. One malformed line — from a partial write, a hand-edit, or a disk-flush race — crashes `searchJsonlEntries`. This function is on the hot path for:

- `search_memory` MCP tool (crashes the tool call, surfaces as an MCP error to the agent)
- `searchMemoryDir` called from `buildSessionDigest` (crashes `dotaios brief --compact` and the Gemini/OpenCode hook injection)
- `dotaios search` CLI command

The safe version already exists in `memory.mjs` and silently skips unparseable lines. The fix is a one-line import swap or a three-line try/catch. The duplicate private helper should be removed.

**User impact:** A non-technical user whose `events.jsonl` has one bad byte would silently lose the entire working context digest at the start of every agent session, with no useful error message.

---

## Secondary Findings Summary

- **C04** (`filterSessions` null `captured_at`): Low real-world risk because all creation paths set `captured_at`, but the guard is cheap.
- **C05** (duplicate-source race): Harmless after the first tick that de-duplicates, but could cause agents to see stale duplicates briefly.
- **C06** (UTC vs local date in dry-run): Cosmetic divergence for non-UTC users; write path is correct.
- **C07** (null dereference in `capture list`): Defensive programming only; not a real crash path today.
- **C08** (`writeSyncConfig` RMW): The tick lock prevents concurrent ticks, so this only matters during setup, which is single-process.
- **C09** (NaN from `parseInt`): Git errors are already surfaced loudly before this point.
- **C10** (empty frontmatter strip): Corner case; DotAIOS never writes empty frontmatter.
- **C11** (`--overwrite` no-op for signals): Surprising but not data-corrupting behaviour.
