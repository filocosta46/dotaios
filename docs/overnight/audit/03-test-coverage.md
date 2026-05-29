# Test Coverage Audit — DotAIOS 1.17.0

**Date:** 2026-05-29  
**Branch:** audit/overnight-2026-05-28  
**Scope:** packages/ vs tests/ — untested / under-tested behavior

---

## Coverage Map

| Module | Has Tests? | Gap Description | Severity | Effort | Test Sketch |
|---|---|---|---|---|---|
| `packages/cli/src/commands/connect.mjs` | NO | Entire 568-line command has zero unit tests. Three `merge*Settings` functions each silently discard vs loudly reject malformed JSON — the malformed-JSON guard at line 367 is the documented safety boundary for no-partial-install | P0 | S | Import `mergeGeminiSettings`; write garbage to a tmp `settings.json`; assert it throws "not valid JSON" and no other file was written |
| `packages/cli/src/commands/connect.mjs` — `mergeOpenCodeSettings` | NO | Same malformed-JSON guard exists in `mergeOpenCodeSettings` (~line 507) — untested | P0 | S | Same pattern: corrupt `opencode.json` → throws, no artifacts written |
| `packages/core/src/sessions.mjs` — `withIndexLock` stale-lock path | THIN | `withIndexLock` steals a stale lock (>10 s old) and has a deadline/best-effort fallback at line 271. Zero tests hit this path. `sync_tick` tests cover `acquireLock` (a different lock), not `withIndexLock`. | P0 | M | Create a `.lock` file with `mtimeMs` >10 s in the past; call `appendIndexEntry`; assert lock was stolen and entry written |
| `packages/core/src/sessions.mjs` — `withIndexLock` deadline / best-effort | NO | If lock is held and 5-s deadline expires, `fn()` is called best-effort (`return fn()`). No test validates this fallback runs rather than hanging. | P1 | M | Simulate fresh lock file (young mtime), advance clock/Date past 5 s deadline, assert function still executes |
| `packages/core/src/sessions.mjs` — `withIndexLock` concurrent writes | NO | Two concurrent `appendIndexEntry` calls on same `aiosPath` could race. Neither a sequential nor a parallel concurrent test exists. | P1 | M | `Promise.all([appendIndexEntry(…), appendIndexEntry(…)])`; assert index has exactly 2 entries |
| `packages/cli/src/commands/connect.mjs` — `updateSkillRegistry` corrupt registry | NO | `updateSkillRegistry` silently resets to `{ skills: [] }` on JSON parse failure (line 210-211). There is no test that a corrupt `registry.json` yields a clean reset rather than a throw. | P1 | S | Write `{broken` to `registry.json`; call `updateSkillRegistry`; assert file re-written with valid JSON |
| `packages/core/src/bridges.mjs` | NO | `loadAgentRegistry`, `bridgeContent`, `isAgentInstalled`, `bridgePath` are pure / near-pure functions with no dedicated test file. Covered only indirectly via `v1_1` integration tests. | P1 | S | Unit-test `bridgeContent` output contains `MANAGED_START/END` and correct `@`-include vs plain-text mode; test `loadAgentRegistry` user-override merge |
| `packages/core/src/files.mjs` | NO | `pathExists`, `readJson`, `writeFileSafe`, `copyFileSafe`, `listFiles` — no test file; used throughout but never directly asserted | P1 | S | Test `readJson` returns fallback on missing file; test `writeFileSafe` with `preserve`/`overwrite` modes |
| `packages/cli/src/commands/connect.mjs` — `updateConnectionsRegistry` | NO | Appends a line to `registry.md`; no test for duplicate prevention or first-write creation | P2 | S | Call twice with same skill; assert single entry in registry |
| `packages/cli/src/commands/context.mjs` | NO | 225-line command; `refreshAgentEntrypoints`, `printContextSummary`, edit-open path — untested | P2 | M | Test `--refresh` dry-run path against tmp aios; assert re-generated entrypoints |
| `packages/cli/src/commands/import.mjs` | NO | 220 lines; `buildImportPlan`, `applyImportItem`, `markdownAppend`, `jsonlAppend` — zero coverage (integration smoke covers CLI flag only) | P2 | M | Test `buildImportPlan` produces correct bucket list for a simple import YAML |
| `packages/cli/src/commands/status.mjs` | NO (integration only) | `statusCommand` only exercised via `v1_1` spawnSync test ("beta testers" assertion). Internal helpers `readConnections`, `checkAgentBridges`, `readConfig` have no unit tests. | P2 | S | Unit-test `checkAgentBridges` returns missing-bridge entries for a tmp home with no bridge files |
| `packages/cli/src/commands/cleanup.mjs` | NO | `cleanupCommand` removes stale signals/sessions; no unit test for dry-run count vs actual deletion, or for partial/missing dirs | P2 | S | Populate tmp signals dir with old files; run cleanupCommand dry-run; assert nothing deleted; run real; assert deleted |
| `packages/cli/src/commands/market.mjs` | NO | `fetchRegistry`, `findEntry`, `marketInstall` — network-dependent but `readFileRegistry` is pure; no test | P2 | S | Test `readFileRegistry` parses a local fixture JSON file and returns entries |
| `packages/cli/src/commands/init.mjs` | THIN | `initCommand` tested via `v1_1` integration; `promptAnswers`, `createBaseTree`, `renderTemplates`, `createVaultTree` have no unit tests | P2 | M | Test `createBaseTree` with `usesExternalVault=true` creates vault tree at external path |
| `packages/cli/src/commands/search.mjs` | THIN | CLI command tested only as a side-effect in `pilot_metrics`; `parseLimit`, `validateScope`, `printGroup` untested | P2 | S | Call `searchCommand` on a tmp aios; assert scoped results for vault/memory |
| `packages/core/src/memory.mjs` — `readSignals` / `readRecentSignals` | NO | `readSignals` (date-range) and `readRecentSignals` exported but not imported by any test | P2 | S | Create signal files for 3 consecutive dates; assert `readSignals` returns only entries in range |
| `packages/core/src/search.mjs` — `markMatches` / `searchMemoryDir` | THIN | `markMatches` and `searchMemoryDir` (merges events+signals+archive) not tested directly; `searchMemory` (memory.mjs wrapper) is tested in memory.test but doesn't exercise `searchMemoryDir` label logic | P2 | S | Test `markMatches` bolding round-trips and `searchMemoryDir` returns merged results from events + signals |
| `packages/core/src/manifest.mjs` — `summarizePermissions` | THIN | Only monetization functions tested; `summarizePermissions`, `validatePermissions`, `validateProvides`, `validateRequires` have zero test coverage | P2 | S | Test `summarizePermissions` formats read/write arrays correctly; test `validateProvides` rejects unknown skill names |
| `packages/cli/src/commands/mcp.mjs` | NO | `printStatus`, `printInstall`, `mcpServerConfig` — untested; only MCP transport tests exist | P2 | S | Call `mcpCommand ["--path", aios]` on valid tmp aios; assert server config JSON is printed |
| `packages/core/src/schema.mjs` | NO | `createAiosConfig` and `schemaVersion` — no test; small file but is the canonical config shape | P3 | S | `assert.equal(createAiosConfig().schema_version, schemaVersion)` |
| `packages/core/src/adapter-contract.mjs` | NO | `ADAPTER_LEVELS`, `getLevelLabel` — trivial, no test | P3 | XS | `assert.equal(getLevelLabel("basic"), "Basic")` |
| `packages/cli/src/lib/gws.mjs` | NO | `assessGwsAuth`, `parseJsonObject` — complex auth-state parser, zero unit coverage | P2 | S | Test `assessGwsAuth` with mocked `gws auth status` stdout containing account email → `{ ready: true }` |
| `packages/cli/src/lib/args.mjs` | NO | `hasHelpFlag`, `readOptionValue` — utility used everywhere, no tests | P2 | XS | `assert.ok(hasHelpFlag(["--help"]))`, `assert.equal(readOptionValue(["--path","x"], "--path"), "x")` |
| `packages/cli/src/commands/schedule.mjs` | THIN | `parseScheduleField`, `isDue`, `serializeSchedules` tested only via integration spawnSync; unit-level path for `isDue` on edge boundaries (exactly on cron boundary) missing | P2 | S | Unit-test `isDue` with a cron string that is due right now vs one that fired 5 min ago |
| `packages/cli/src/commands/install.mjs` | THIN | `install` tested only by `v1_1` "refuses unsupported URL schemes"; `installPlugin`, `copyDirectory`, `updateSkillRegistry` have zero unit coverage | P2 | M | Test `installPlugin` with a local fixture directory copies files and writes registry |
| `packages/cli/src/commands/google.mjs` | NO | 543-line command; `parseAction`, `buildGwsArgs`, `nextGoogleDoctorAction` — entirely untested | P2 | M | Unit-test `nextGoogleDoctorAction` returns correct next step for each combination of {connected, authReady, gcloudReady} |
| `packages/cli/src/commands/reveal.mjs` | THIN | Covered by `v1_3_1` for dry-run and help only; no test for actual `open` spawn or error when binary missing | P3 | S | Already thin but covered for main paths |
| `packages/cli/src/commands/license.mjs` | NO | `licenseCommand` — 74 lines; entirely untested | P3 | XS | Call with `--path` on tmp aios; assert license text printed |
| `packages/cli/src/commands/skill.mjs` / `skills.mjs` | NO | Both command files entirely untested | P3 | S | Call `skillsCommand` on tmp aios with installed skill; assert skill name printed |
| `packages/cli/src/commands/update.mjs` | NO | `updateCommand` — 80 lines; entirely untested | P3 | XS | Verify `--help` flag doesn't throw |
| `packages/cli/src/adapters/detect.mjs` | NO | Agent detection logic for Claude Code, Codex, etc. — no unit test | P2 | S | Mock `homePath` with fake tool detection files; assert correct agent detected |

---

## KNOWN GAP: `connect.mjs` malformed-JSON guard (line 367)

**Finding:** Confirmed no test exists. The comment at line 367 explicitly documents the safety invariant:

> *"Merge settings first: it validates an existing settings.json and aborts on a malformed file before we write any other artifacts (no partial install)."*

Three functions implement this pattern:
1. `mergeGeminiSettings` (~line 423) — throws on corrupt `~/.gemini/settings.json`
2. `mergeOpenCodeSettings` (~line 507) — throws on corrupt `~/.config/opencode/opencode.json`
3. `updateSkillRegistry` (~line 209) — silently resets (different policy — also untested)

**Test sketch (unit, no home directory access):**

```js
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
// mergeGeminiSettings is not exported — extract it or test via connectCommand
// with a tmp --path and a pre-written corrupt ~/.gemini/settings.json mock

test("mergeGeminiSettings throws on corrupt settings.json and writes nothing else", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-connect-test-"));
  const settingsPath = path.join(tmp, "settings.json");
  await fs.writeFile(settingsPath, "{broken json");

  await assert.rejects(
    () => mergeGeminiSettings(settingsPath, path.join(tmp, "hook.sh"), tmp),
    /not valid JSON/
  );
  // Verify no hook script or bridge file was written
  const files = await fs.readdir(tmp);
  assert.deepEqual(files.sort(), ["settings.json"], "no partial artifacts written");
});
```

(Requires either exporting `mergeGeminiSettings` for testability, or testing through `connectCommand` with a temp `--gemini-dir` option.)

---

## `withIndexLock` concurrency (sessions.mjs ~253-291)

**Finding:** The stale-lock steal and the 5-second deadline best-effort fallback are NOT tested. `sessions.test.mjs` does not import `withIndexLock` directly (it is unexported). Tests exercise `writeSession` → `appendIndexEntry` → `withIndexLock` implicitly, but only single-writer, no contention, no stale lock.

**Test sketch:**

```js
test("withIndexLock steals stale lock and completes write", async () => {
  const aios = tmpAios();
  const lockPath = path.join(aios, "memory/sessions/index.jsonl.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  // Write a lock file with mtime > 10s ago
  await fs.writeFile(lockPath, "{}");
  const old = new Date(Date.now() - 15_000);
  await fs.utimes(lockPath, old, old);

  // Should steal the stale lock and write normally
  const session = makeSession();
  await writeSession(aios, session);
  const index = await readSessionIndex(aios);
  assert.equal(index.length, 1);
  assert.equal(await fs.access(lockPath).then(() => true).catch(() => false), false, "lock released");
});
```

---

## Summary Statistics

| Severity | Count |
|---|---|
| P0 (critical untested path) | 3 |
| P1 (high-leverage) | 5 |
| P2 (medium) | 20 |
| P3 (low) | 6 |

**Total source modules with zero direct test coverage:** 18 of ~68 modules (~26%)  
**Total source modules with thin/integration-only coverage:** ~10 additional

---

## Top 3 Highest-Leverage Missing Tests

1. **`connect.mjs` malformed-JSON guard (P0/S):** The documented "no partial install" safety boundary is entirely untested. A corrupt `~/.gemini/settings.json` or `~/.config/opencode/opencode.json` must abort before any file is written. This is a user-facing destructive failure mode for non-technical users.

2. **`withIndexLock` stale-lock steal (P0/M):** If a CLI process crashes while holding the session index lock, the next run must steal it. The steal path (line 267) is reachable in production (any crash or `kill -9`) but has no test. A missed steal = index permanently locked = `capture` and `sync` silently broken.

3. **`withIndexLock` concurrent writes (P0/M):** Two simultaneous `dotaios capture` calls (e.g., agent + hook) race on the index file. No concurrent test exists to validate the serialization contract that was the entire motivation for adding this lock (commit 5294041).
