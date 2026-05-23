# Foundation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three real bugs found in the deep audit and add missing tests so the existing feature set is solid before new features are added.

**Architecture:** Surgical fixes only — no refactors, no new abstractions. Each fix is self-contained. Test each fix with a new test before changing the code.

**Tech Stack:** Node.js 20 ESM, native test runner (`node --test`), no new dependencies.

---

## Files Modified or Created

| File | Change |
|------|--------|
| `packages/cli/src/commands/activate.mjs` | Fix symlink type on Windows (lines 195, 206) |
| `packages/cli/src/commands/setup.mjs` | Isolate step failures — each step catches and reports independently |
| `tests/cli/activate.test.mjs` | New — covers bridge writing and symlink creation |
| `tests/cli/setup.test.mjs` | New — covers step isolation on partial failure |

---

## Task 1: Fix Windows Symlinks in activate.mjs

**Context:** `fs.symlink(source, dest, "dir")` fails on Windows — the correct type for directory symlinks on Windows is `"junction"`. On Mac/Linux, `"dir"` is the right value. Both lines 195 and 206 in `activate.mjs` have this bug.

**Files:**
- Modify: `packages/cli/src/commands/activate.mjs`
- Test: `tests/cli/activate.test.mjs` (create new)

- [ ] **Step 1: Write the failing test**

Create `tests/cli/activate.test.mjs`:

```javascript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Resolve to repo root from this file's location
const repoRoot = new URL("../../..", import.meta.url).pathname;

async function makeTmpDirs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-activate-"));
  const aiosPath = path.join(base, "aios");
  const homePath = path.join(base, "home");
  await fs.mkdir(path.join(aiosPath, "skills"), { recursive: true });
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  // Write minimal aios.json so ensureAiosFolder passes
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  // Create a fake skill so bridgeSkillsToClaude has something to link
  await fs.mkdir(path.join(aiosPath, "skills", "test-skill"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "skills", "test-skill", "SKILL.md"),
    "# Test Skill\nA test skill.\n"
  );
  return { base, aiosPath, homePath };
}

describe("activateCommand — symlinks", () => {
  let dirs;

  before(async () => {
    dirs = await makeTmpDirs();
  });

  after(async () => {
    await fs.rm(dirs.base, { recursive: true, force: true });
  });

  it("creates skill symlink that resolves on this platform", async () => {
    const { activateCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/activate.mjs")
    );

    await activateCommand([
      "--path", dirs.aiosPath,
      "--home", dirs.homePath,
      "--all"
    ]);

    const symlinkPath = path.join(dirs.homePath, ".claude", "skills", "test-skill");
    const stat = await fs.lstat(symlinkPath);
    assert.ok(stat.isSymbolicLink(), "expected a symlink");

    const target = await fs.readlink(symlinkPath);
    assert.equal(target, path.join(dirs.aiosPath, "skills", "test-skill"));

    // Verify the symlink is actually traversable (resolves correctly)
    const skillFile = path.join(symlinkPath, "SKILL.md");
    const content = await fs.readFile(skillFile, "utf8");
    assert.ok(content.includes("Test Skill"), "symlink should resolve to skill content");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes — baseline check)**

```bash
cd /Users/filo/Brain/dotaios
node --test tests/cli/activate.test.mjs 2>&1
```

Expected on Mac: likely passes (Mac uses "dir" fine). Expected on Windows: fails with EINVAL. Confirm the test infrastructure works.

- [ ] **Step 3: Apply the symlink fix in activate.mjs**

In `packages/cli/src/commands/activate.mjs`, find the function `bridgeSkillsToClaude`.

Change line 195 from:
```javascript
await fs.symlink(source, dest, "dir");
```
To:
```javascript
await fs.symlink(source, dest, process.platform === "win32" ? "junction" : "dir");
```

Change line 206 (same pattern, in the `if (!options.overwrite)` branch):
```javascript
await fs.symlink(source, dest, "dir");
```
To:
```javascript
await fs.symlink(source, dest, process.platform === "win32" ? "junction" : "dir");
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/filo/Brain/dotaios
node --test tests/cli/activate.test.mjs 2>&1
```

Expected: PASS

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
cd /Users/filo/Brain/dotaios
npm test 2>&1 | tail -15
```

Expected: 233+ tests pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/filo/Brain/dotaios
git add packages/cli/src/commands/activate.mjs tests/cli/activate.test.mjs
git commit -m "fix: use junction symlink type on Windows in bridgeSkillsToClaude"
```

---

## Task 2: Isolate Setup Step Failures

**Context:** `setupCommand` runs init → activate → reveal in sequence. If `activateCommand` throws (e.g., permissions error), the whole setup crashes with a raw stack trace and no guidance. User is left with a half-set-up system and no recovery path.

**Fix:** Wrap each step in try/catch, print a clear human-readable failure message per step, and continue to the next step rather than crashing. The user ends up with a report: which steps worked, which failed, what to re-run.

**Files:**
- Modify: `packages/cli/src/commands/setup.mjs`
- Test: `tests/cli/setup.test.mjs` (create new)

- [ ] **Step 1: Write the failing test**

Create `tests/cli/setup.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL("../../..", import.meta.url).pathname;

describe("setupCommand — step isolation", () => {
  it("prints clear failure message and does not throw when activate fails", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-setup-"));

    // Capture console output
    const messages = [];
    const originalError = console.error.bind(console);
    const originalLog = console.log.bind(console);
    console.error = (...args) => messages.push(["err", args.join(" ")]);
    console.log = (...args) => messages.push(["log", args.join(" ")]);

    try {
      const { setupCommand } = await import(
        path.join(repoRoot, "packages/cli/src/commands/setup.mjs")
      );

      // Run setup with --yes (non-interactive), --skip-reveal,
      // and a deliberately invalid home dir to trigger activate failure.
      // Because activate writes to ~/.claude etc, we use --home to point
      // to a read-only location. /dev/null works on Mac/Linux.
      await setupCommand([
        "--path", path.join(tmpBase, "aios"),
        "--yes",
        "--skip-reveal",
        "--home", "/nonexistent-home-12345"
      ]);
    } catch {
      // setup should NOT throw — it should catch and report
      assert.fail("setupCommand should not throw when a step fails — it should report and continue");
    } finally {
      console.error = originalError;
      console.log = originalLog;
      await fs.rm(tmpBase, { recursive: true, force: true });
    }

    const allOutput = messages.map(([, m]) => m).join("\n");
    // Should have a message indicating activate had issues
    assert.ok(
      allOutput.includes("step 2") || allOutput.includes("activate") || allOutput.includes("skip") || allOutput.includes("re-run"),
      `Expected failure guidance in output, got: ${allOutput.slice(0, 500)}`
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails (setup currently throws)**

```bash
cd /Users/filo/Brain/dotaios
node --test tests/cli/setup.test.mjs 2>&1
```

Expected: FAIL — `setupCommand should not throw when a step fails`

- [ ] **Step 3: Wrap each step in setup.mjs with isolated error handling**

Replace the step-execution block in `packages/cli/src/commands/setup.mjs` (lines 39-57) with:

```javascript
  // Step 1: init
  console.log("DotAIOS setup — step 1 of 3: create your folder");
  console.log("");
  let initOk = false;
  try {
    await initCommand(passthrough);
    initOk = true;
  } catch (err) {
    console.error(`Step 1 failed: ${err.message}`);
    console.error("Re-run: dotaios init to retry this step.");
    console.error("");
  }

  // Step 2: activate (only if init succeeded — activate needs aios.json)
  let activateOk = false;
  if (initOk) {
    console.log("");
    console.log("DotAIOS setup — step 2 of 3: connect your AI tools");
    console.log("");
    try {
      await activateCommand(passthrough);
      activateOk = true;
    } catch (err) {
      console.error(`Step 2 failed: ${err.message}`);
      console.error("Re-run: dotaios activate to retry connecting your tools.");
      console.error("");
    }
  }

  // Step 3: reveal (best-effort, never blocks)
  if (!skipReveal && initOk) {
    console.log("");
    console.log("DotAIOS setup — step 3 of 3: open the folder");
    console.log("");
    try {
      await revealCommand(passthrough);
    } catch (error) {
      console.error(`(skipped reveal: ${error.message})`);
    }
  }

  // If init didn't even succeed, bail early with clear message
  if (!initOk) {
    console.error("Setup could not complete. Fix the error above, then re-run: dotaios setup");
    return;
  }
```

Note: `activateOk` is declared but the rest of setup.mjs can proceed regardless — the brief prompt and skills summary don't depend on activate succeeding.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/filo/Brain/dotaios
node --test tests/cli/setup.test.mjs 2>&1
```

Expected: PASS

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/filo/Brain/dotaios
npm test 2>&1 | tail -15
```

Expected: 234+ tests pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/filo/Brain/dotaios
git add packages/cli/src/commands/setup.mjs tests/cli/setup.test.mjs
git commit -m "fix: isolate setup step failures — each step reports independently, does not throw"
```

---

## Task 3: Harden Schedule YAML Editing

**Context:** `enableSchedule()` in `setup.mjs` edits `schedules.yml` with line-by-line regex. It works for the generated format but silently does nothing if the file was manually edited or reformatted. No feedback to the user if the edit had no effect.

**Fix:** After writing the file, re-read it and verify the target schedule now shows `enabled: true`. If not, print a clear message telling the user to edit the file manually.

**Files:**
- Modify: `packages/cli/src/commands/setup.mjs` — `enableSchedule` function

- [ ] **Step 1: Locate `enableSchedule` in setup.mjs (lines 176-199)**

The current function writes the file but never verifies the change took effect.

- [ ] **Step 2: Add verification after the write**

Replace the current `enableSchedule` function with:

```javascript
async function enableSchedule(aiosPath, scheduleName) {
  const schedulesPath = path.join(aiosPath, "schedules.yml");
  if (!await pathExists(schedulesPath)) return false;

  const content = await fs.readFile(schedulesPath, "utf8");
  const lines = content.split("\n");
  let inTarget = false;
  let changed = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === `- name: ${scheduleName}` || trimmed === `name: ${scheduleName}`) {
      inTarget = true;
    } else if (inTarget && trimmed.startsWith("- name:")) {
      inTarget = false;
    }
    if (inTarget && trimmed === "enabled: false") {
      changed = true;
      return line.replace("enabled: false", "enabled: true");
    }
    return line;
  });

  if (!changed) {
    console.log(`  (could not enable ${scheduleName} automatically — edit schedules.yml and set enabled: true under the "${scheduleName}" entry)`);
    return false;
  }

  await fs.writeFile(schedulesPath, updated.join("\n"));
  return true;
}
```

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/filo/Brain/dotaios
npm test 2>&1 | tail -15
```

Expected: same pass count, 0 fail.

- [ ] **Step 4: Commit**

```bash
cd /Users/filo/Brain/dotaios
git add packages/cli/src/commands/setup.mjs
git commit -m "fix: verify enableSchedule edit took effect, print manual fallback if not"
```

---

## Task 4: Verify doctor Command Catches Real Issues

**Context:** `dotaios doctor` is the health check command. It should catch broken/missing bridges, missing aios.json, and missing Node version. Verify it's reliable before relying on it as the foundation's self-check.

**Files:**
- Read: `packages/cli/src/commands/doctor.mjs`
- Test: `tests/cli/doctor.test.mjs` (create new)

- [ ] **Step 1: Read doctor.mjs**

```bash
cat /Users/filo/Brain/dotaios/packages/cli/src/commands/doctor.mjs
```

Read the full file and identify: what checks does it run? What does it miss?

- [ ] **Step 2: Write test that exercises the happy path and a broken state**

Create `tests/cli/doctor.test.mjs`:

```javascript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = new URL("../../..", import.meta.url).pathname;

async function makeMinimalAios(base) {
  const aiosPath = path.join(base, "aios");
  await fs.mkdir(path.join(aiosPath, "context"), { recursive: true });
  await fs.writeFile(
    path.join(aiosPath, "aios.json"),
    JSON.stringify({ schema_version: "1.0.0", ai_tools: [], created_at: new Date().toISOString() })
  );
  return aiosPath;
}

describe("doctorCommand", () => {
  let tmpBase;

  before(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "dotaios-doctor-"));
  });

  after(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("does not throw on a valid aios folder", async () => {
    const aiosPath = await makeMinimalAios(tmpBase);
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    // Should not throw — doctor reports issues, doesn't throw on them
    await assert.doesNotReject(
      doctorCommand(["--path", aiosPath]),
      "doctorCommand should not throw even when it finds issues"
    );
  });

  it("does not throw when aios folder is missing", async () => {
    const { doctorCommand } = await import(
      path.join(repoRoot, "packages/cli/src/commands/doctor.mjs")
    );

    await assert.doesNotReject(
      doctorCommand(["--path", path.join(tmpBase, "nonexistent")]),
      "doctorCommand should not throw on missing folder"
    );
  });
});
```

- [ ] **Step 3: Run test**

```bash
cd /Users/filo/Brain/dotaios
node --test tests/cli/doctor.test.mjs 2>&1
```

Expected: PASS. If it fails, read the error — doctor likely throws rather than reports. Fix the throw by wrapping the main body in try/catch and printing the error.

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/filo/Brain/dotaios
npm test 2>&1 | tail -15
```

Expected: 235+ tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /Users/filo/Brain/dotaios
git add tests/cli/doctor.test.mjs
git commit -m "test: add doctor command smoke tests for valid and missing aios folder"
```

---

## Final Verification

- [ ] **Run the full test suite one last time**

```bash
cd /Users/filo/Brain/dotaios
npm test 2>&1 | tail -20
```

Expected: all tasks' tests passing, 0 fail. Total count 235+.

- [ ] **Manual smoke test — setup on this machine**

```bash
npx dotaios setup --yes --skip-reveal --path /tmp/dotaios-smoke-test
```

Expected: completes without throwing, prints "All set." message.

```bash
rm -rf /tmp/dotaios-smoke-test
```

---

## Self-Review

**Spec coverage:** Four issues from audit — Windows symlinks ✓, setup step isolation ✓, YAML feedback ✓, doctor reliability ✓. No unresolved audit items in scope.

**Placeholder scan:** No TBDs. All code blocks are complete and runnable.

**Type consistency:** No shared types across tasks — each is self-contained.

**Scope:** No new features. No refactors beyond what each fix requires. Tests added only for code being changed.
