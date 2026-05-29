# Performance Audit — DotAIOS 1.17.0

**Branch:** audit/overnight-2026-05-28  
**Date:** 2026-05-29  
**Auditor:** automated subagent (read-only, no code changes)

---

## Measurements

### Method

- Synthetic vault of 500 / 2000 / 5000 small markdown files (`~609 bytes each`) created in `/tmp/aios-synth*`
- AIOS init pointing each vault path via `--vault-path`
- Commands timed using `Date.now()` across 3 cold-process runs via `child_process.execSync`
- Node.js baseline measured separately to isolate runtime startup
- File I/O breakdown measured with raw `fs.readFile` / `fs.readdir` benchmarks

### Results

| Command | vault size | avg (ms) | notes |
|---|---|---|---|
| `node index.mjs --help` | n/a | 27 | cold process baseline |
| `status` | 0 files | 38 | 12ms overhead vs --help |
| `search hello` | 0 files | 32 | 6ms overhead vs --help |
| `search productivity --scope vault` | 500 files | 67 | |
| `search productivity --scope vault` | 2000 files | 153 | ~150ms felt threshold |
| `search productivity --scope vault` | 5000 files | 315 | user-perceptible slowness |
| `search productivity` (scope=all) | 2000 files | 157 | ~4ms serial-scope overhead |
| `index` | 500 files | 61 | |
| `index` | 2000 files | 141 | |
| `index` | 5000 files | 292 | |

### File I/O Breakdown (2000-file vault, `search`)

| Phase | time (ms) | % of total |
|---|---|---|
| Node.js startup | ~27 | ~18% |
| `readdir` + sort 2000 entries | ~5 | ~3% |
| Sequential `readFile` × 2000 | ~97 | ~63% |
| Per-file processing (split/match) | ~24 | ~16% |

### Parallelism Benchmark (2000 files, raw I/O)

| Strategy | time (ms) |
|---|---|
| Sequential `readFile` | 100 |
| `Promise.all` (all 2000 at once) | 35 |
| Batched `Promise.all` (32 at a time) | 29 |

Conclusion: 63% of search time is wasted waiting on sequential I/O. Parallelised reads would reduce a 153ms search to ~85ms (~44% faster) on the same hardware.

---

## Findings

### F1 — Sequential file reads in `searchMarkdownDir`

**Severity:** P1 | **Effort:** S | **File:** `packages/core/src/search.mjs:145-148`

```js
for (const filePath of files) {
  content = await fs.readFile(filePath, "utf8");  // sequential
```

All files are read one at a time before any result is returned. No early exit after `limit` results are collected — the entire vault is scanned and all matching files accumulated, then sorted, then sliced. With 2000 files (~1.2MB), sequential I/O accounts for 97ms of a 153ms search. Mac benchmarks show batched `Promise.all(32)` cuts this to ~29ms (70% reduction).

**Fix sketch:** Replace the sequential for-loop with a batched `Promise.all` (batch size 32–64 avoids fd exhaustion). No semantic change; limit/sort logic unchanged.

---

### F2 — Serial scope iteration in `searchAios`

**Severity:** P2 | **Effort:** S | **File:** `packages/core/src/search.mjs:29-33`

```js
for (const name of scopes) {
  const results = await searchScope(name, ...);  // serial
```

When `scope=all`, eight scopes (sessions, context, memory, vault, projects, skills, references, plugins) are awaited one-by-one. With an empty vault and all scopes empty, measured overhead is ~7ms vs single-scope. With large vaults across multiple scopes, the overhead multiplies. Each scope independently does readdir + file reads.

**Fix sketch:** `const groups = await Promise.all(scopes.map(name => searchScope(...)))`. Scopes are fully independent; parallelism is safe.

---

### F3 — `searchMarkdownDir` reads all files even after `limit` is reached

**Severity:** P2 | **Effort:** S | **File:** `packages/core/src/search.mjs:136-176`

The function reads ALL files in the vault, accumulates ALL matching results, then calls `.sort().slice(0, limit)`. With `--limit 20` on a 2000-file vault, 2000 readFile calls are made even if the first 20 files all match. There is no short-circuit once `limit` results have been found.

**Fix sketch:** After `results.push(...)`, add `if (results.length > limit * 3) break` to allow partial early exit. (Multiply by 3 to leave room for sorting to surface better-scoring results at end of list. Alternatively, use a min-heap of size `limit` and break when score threshold is known.)

---

### F4 — `listSearchFiles` sorts at every recursive directory level

**Severity:** P3 | **Effort:** S | **File:** `packages/core/src/search.mjs:378`

```js
return results.sort();
```

`listSearchFiles` is recursive and calls `.sort()` on accumulated results at every directory return. For a flat vault/raw with 2000 files this is one O(N log N) sort; for deeply nested trees it re-sorts merged sub-arrays. Benchmarked at ~5ms for 2000 files — low impact now but grows with nesting depth.

**Fix sketch:** Remove the `.sort()` from the recursive function and do a single sort on the final collected list in the callers (`searchMarkdownDir`). The `listMarkdownFiles` function in `index.mjs` has the same pattern at `entries.sort(...)` inside the loop body.

---

### F5 — `appendIndexEntry` rewrites entire `index.jsonl` on every new session

**Severity:** P1 | **Effort:** M | **File:** `packages/core/src/sessions.mjs:283-288`

```js
async function appendIndexEntry(aiosPath, entry) {
  await withIndexLock(aiosPath, async () => {
    const entries = await readSessionIndex(aiosPath);  // full read
    entries.push(entry);
    await writeSessionIndex(aiosPath, entries);  // full rewrite
  });
}
```

Every new session write: acquires lock → reads entire `index.jsonl` → rewrites entire `index.jsonl`. At ~418 bytes per entry, a user with 1000 sessions triggers a 418KB rewrite per import; at 5000 sessions, 2MB. For batch imports (e.g. `capture import claude-code` importing dozens of sessions) this compounds: each session does a full read-modify-write cycle under lock.

The `withIndexLock` itself spins with 50ms `delay()` per attempt — a concurrent import + touch of the same session serialises and each waiter burns a 50ms tick before retrying.

**Fix sketch:** For append-only new sessions where no dedup check is needed, use `fs.appendFile` on the JSONL directly (skip the full read). Reserve the read-modify-write path for update operations. Estimated reduction: O(N) per write → O(1) for the pure-append path.

---

### F6 — `writeSession` with `source_path` does two full index reads

**Severity:** P2 | **Effort:** S | **File:** `packages/core/src/sessions.mjs:76, 114`

```js
const existing = await readSessionIndex(aiosPath);    // line 76: outside lock
// ... then inside withIndexLock:
const current = await readSessionIndex(aiosPath);     // line 114: inside lock
```

The update path (source_path dedup) reads `index.jsonl` once outside the lock for the `priorEntry` lookup, then reads it again inside the lock for the actual mutation. With a large index this is 2 × full-file read per update. The first read is racy (could be stale by the time the lock is acquired).

**Fix sketch:** Move the initial `readSessionIndex` inside `withIndexLock` so the check and mutation use the same read. Reduces to 1 read + 1 write, and eliminates the TOCTOU race.

---

### F7 — `status` eagerly imports `detectMarker` from `pdf.mjs`, pulling in `web.mjs` → `lightpanda.mjs`

**Severity:** P3 | **Effort:** S | **File:** `packages/cli/src/commands/status.mjs:6`, `packages/cli/src/ingest/pdf.mjs:7`

```js
// status.mjs
import { detectMarker } from "../ingest/pdf.mjs";     // static import
// pdf.mjs
import { IngestError } from "./web.mjs";              // static import
// web.mjs
import { resolveLightpanda, lightpandaPlatformBinary } from "../../../core/src/lightpanda.mjs"; // static import
```

The `status` command statically imports `pdf.mjs`, which statically imports `web.mjs`, which statically imports `lightpanda.mjs` (a module that imports `createWriteStream`, `pipeline`, `Readable` from Node builtins plus path/child_process). None of these are needed for `status`'s use of `detectMarker`. The heavy ingest deps themselves (linkedom, cheerio, readability, turndown, unpdf) are lazy-loaded via dynamic `import()` — so the real cost here is just the Node module graph parse overhead, not the npm packages. Measured overhead vs `--help`: ~12ms for status.

**Fix sketch:** Export `IngestError` from a thin `packages/cli/src/ingest/errors.mjs` and have `pdf.mjs` import from there. `web.mjs` then only needs to be loaded when actually ingesting. Alternatively, `status.mjs` could dynamically import `detectMarker` (`await import(...)`) since it's only needed for one output line.

---

### F8 — `detect.mjs::binaryExists` uses synchronous `spawnSync("which", ...)` on status

**Severity:** P2 | **Effort:** S | **File:** `packages/cli/src/adapters/detect.mjs:222-225`

```js
function binaryExists(name) {
  const result = spawnSync("which", [name], { stdio: "pipe" });
  return result.status === 0;
}
```

Called for `"gemini"` and `"codex"` during `probeAdapterLiveness()` on every `status` invocation. `spawnSync` blocks the Node.js event loop until the subprocess exits. Two synchronous process forks per `status` call. On macOS, `which` is fast but this still blocks the main thread while the fork+exec+exit cycle completes.

**Fix sketch:** Replace with `execFile("which", [name])` (async) or use `process.env.PATH.split(path.delimiter).some(d => fs.access(path.join(d, name)))` to avoid forking entirely.

---

### F9 — `context printContextSummary` does 3 sequential syscalls per file (pathExists + stat + readFile)

**Severity:** P3 | **Effort:** S | **File:** `packages/cli/src/commands/context.mjs:100-110`

```js
const exists = await pathExists(filePath);   // stat
const stat = await fs.stat(filePath);        // stat again
const preview = await readPreview(filePath); // readFile (entire file)
```

For the default 4 primary context files + domain files: each file is stat'd twice (once by `pathExists`, once directly) and then fully read just to extract the first non-heading line. If a user has many domain context files, this fans out into serial syscall chains.

**Fix sketch:** Merge into a single `try { stat = await fs.stat(fp); content = await fs.readFile(fp); } catch (ENOENT)`. Eliminates redundant stat and can be further parallelized across files with `Promise.all`.

---

### F10 — `index` command reads every vault file sequentially for summary extraction

**Severity:** P2 | **Effort:** S | **File:** `packages/cli/src/commands/index.mjs:54-57`

```js
for (const file of files) {
  const summary = await readSummary(file);  // sequential readFile per file
```

Same pattern as `searchMarkdownDir` — 2000 sequential reads taking ~97ms of the 141ms total. The `readSummary` function only needs the first ~10 lines (frontmatter + first heading), not the entire file.

**Fix sketch (two parts):** (a) Parallelize with batched `Promise.all`; (b) read only the first 512–1024 bytes via a streaming approach (`fs.open` + `filehandle.read(buffer, 0, 1024, 0)`) instead of the full file, since frontmatter descriptions are always near the top.

---

## Summary Table

| ID | Description | Severity | Effort | File:Line |
|---|---|---|---|---|
| F1 | Sequential readFile loop in searchMarkdownDir | P1 | S | search.mjs:145 |
| F2 | Serial scope iteration in searchAios | P2 | S | search.mjs:29 |
| F3 | No early exit after limit reached in searchMarkdownDir | P2 | S | search.mjs:136 |
| F4 | Per-directory sort in listSearchFiles | P3 | S | search.mjs:378 |
| F5 | Full index rewrite per session append | P1 | M | sessions.mjs:283 |
| F6 | Double index read in writeSession source_path update | P2 | S | sessions.mjs:76,114 |
| F7 | status eagerly imports pdf→web→lightpanda chain | P3 | S | status.mjs:6 |
| F8 | Synchronous spawnSync("which") in binaryExists | P2 | S | detect.mjs:222 |
| F9 | Double stat + full readFile per file in context summary | P3 | S | context.mjs:100 |
| F10 | Sequential readFile in index command | P2 | S | index.mjs:54 |

**Counts:** P0: 0 · P1: 2 · P2: 5 · P3: 3

No P0 (blocking slowness) at personal scale (100–500 files). P1 items become P0 at >2000 files.

---

## Notes on Scope

- No semantic/vector search proposed. All findings are I/O or algorithmic patterns.
- Heavy ingest deps (cheerio, linkedom, unpdf, turndown, readability) are correctly lazy-loaded via dynamic `import()`. No issue there.
- CLI cold-start for `--help` is 27ms — excellent, no heavy top-level imports in `index.mjs`.
- `status` command is 38ms even with the transitively loaded ingest module chain — acceptable.
- Search scales approximately linearly with vault size (O(N) in files, O(chars) total). At ~2500 files the ICP will feel the latency; at 5000 it is clearly slow.
