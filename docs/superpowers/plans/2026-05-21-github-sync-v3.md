# GitHub Sync v3 — Implementation Plan (simplification diff)

> Spec: `docs/superpowers/specs/2026-05-21-github-sync-v3.md`
> Branch: `worktree-feat+github-sync` (continue here — do NOT restart)
> This is a **simplification diff** over the v2 build (tasks 1–16), not a new build.

**Goal:** strip the GitHub App and the 3-platform heartbeat from the built sync
feature, flip the tick to a rebase model, fix the `setup` exit-1 bug, and finish
the phone-write (inbox) path v2 left unbuilt.

**Conventions:** Node 20 ESM, `node:` built-ins only, zero new npm deps. Tests:
`node --test tests/**/*.test.mjs` — **0 failures at the end of every task.** All
network / spawn / fs / clock calls keep their injectable overrides. One commit
per task on the branch. Filippo controls `npm publish` — never publish from
automation.

**Task order is dependency-safe:** each task leaves the tree green and every
module's imports resolvable.

---

## Task 1: Rebase-model tick (`git.mjs` + `tick.mjs`)

**Files:** `packages/cli/src/sync/git.mjs`, `packages/cli/src/sync/tick.mjs`,
`tests/cli/sync_git.test.mjs`, `tests/cli/sync_tick.test.mjs`

- [ ] **Step 1 — tests first.** Update `sync_git.test.mjs`: add a `pullRebase()`
  case (clean rebase → `"rebased"` / `"up-to-date"`; conflicting rebase →
  `git rebase --abort` is called and it returns `"conflict"`). Update
  `sync_tick.test.mjs` for the new order: when the working tree is dirty the
  commit happens **before** the pull; on a `"conflict"` pull result the tick
  branches the pre-rebase sha then hard-resets to origin and logs `sync-conflict`;
  on a clean pull no branch is created.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.**
  - `git.mjs`: add `pullRebase(branch = "main")` — `fetch`, then
    `rebase origin/<branch>`; on non-zero exit run `rebase --abort` and return
    `"conflict"`; on success return `"rebased"` or `"up-to-date"` (no commits
    behind). Keep `branchFromSha` + `hardResetToOrigin` for the fallback. `ffPull`
    may be removed once `tick.mjs` no longer calls it.
  - `tick.mjs`: reorder `runTick` to **(1)** capture pre-op sha, **(2)** if
    `dirty()` → `commitAll(...)`, **(3)** `pullRebase("main")`, **(4)** on
    `"conflict"` → `branchFromSha("local-<ts>", preSha)` +
    `hardResetToOrigin("main")` + `appendEvent({type:"sync-conflict",...})`,
    **(5)** `push("main")` if there is anything to push. Keep the lock and the
    10-second rate-gap untouched.
- [ ] **Step 4 — run, expect PASS. Run full suite, expect 0 failures.**
- [ ] **Step 5 — commit:** `refactor(sync): rebase-model tick — commit, pull --rebase, push`

---

## Task 2: Auth → token paste + setup-flow rework + exit-1 fix

**Files:** `packages/cli/src/sync/auth.mjs`,
`packages/cli/src/sync/setup-flow.mjs`, `tests/cli/sync_auth.test.mjs`,
`tests/cli/sync_setup.test.mjs`

- [ ] **Step 1 — tests first.** Rewrite `sync_auth.test.mjs`: drop device-flow
  cases; cover `buildTokenCreateUrl()` (contains `scopes=repo` + a description),
  `validateToken()` (good token → username via `GET /user`; bad token → throws a
  plain-language error). Keep `fetchUsername` coverage. Rewrite
  `sync_setup.test.mjs` for the token-paste orchestration: no device-flow stubs,
  no `installHeartbeat` stub; assert the flow reads a pasted token, validates it,
  drives repo creation, runs the initial push + first tick.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.**
  - `auth.mjs`: delete `requestDeviceCode` + `pollForToken` + the device-flow
    constants/`TERMINAL_ERRORS`. Add `buildTokenCreateUrl()` →
    `https://github.com/settings/tokens/new?scopes=repo&description=DotAIOS%20Sync`.
    Add `validateToken({ accessToken, fetchImpl })` → calls `GET /user`, returns
    the username, throws a plain-language error on a non-OK response. Keep
    `fetchUsername` (or fold it into `validateToken`).
  - `setup-flow.mjs`: remove the `PLACEHOLDER_CLIENT_ID` / `CLIENT_ID` /
    `isPlaceholderClientId` machinery and the placeholder hard-fail. Remove the
    `installHeartbeat` import and the Step 4 heartbeat install. New Step 1: open
    `buildTokenCreateUrl()` in the browser, print instructions, read a pasted
    token from stdin, `validateToken` it, `writeConfig`. Steps 2–3 (repo
    deep-link, initial push) unchanged. New Step 4: run the first tick + print
    the agent-agnostic phone instructions. **Fix the exit-1 leak** — `runSetup`
    must not set `process.exitCode = 1` on a successful run; only a genuine
    failure sets it.
- [ ] **Step 4 — run, expect PASS. Run full suite, expect 0 failures.**
- [ ] **Step 5 — commit:** `feat(sync): replace GitHub App device flow with pasted PAT`

---

## Task 3: Remove the heartbeat

**Files:** delete `packages/cli/src/sync/heartbeat.mjs`, delete
`tests/cli/sync_heartbeat.test.mjs`; edit `packages/core/src/paths.mjs`,
`tests/core/paths.test.mjs`, `packages/cli/src/sync/logout-cmd.mjs`

> Safe to do now: after Task 2, `setup-flow.mjs` no longer imports `heartbeat.mjs`.
> Only `logout-cmd.mjs` still references it.

- [ ] **Step 1 — tests first.** Remove the `heartbeatPlistPath` /
  `heartbeatUnitDir` assertions from `tests/core/paths.test.mjs`. Delete
  `tests/cli/sync_heartbeat.test.mjs`.
- [ ] **Step 2 — implement.**
  - Delete `packages/cli/src/sync/heartbeat.mjs`.
  - `paths.mjs`: delete `heartbeatPlistPath()` and `heartbeatUnitDir()`.
  - `logout-cmd.mjs`: remove the `removeHeartbeat` import + call; `runLogout`
    now just removes `sync.json` and prints the sign-out message.
- [ ] **Step 3 — run full suite, expect 0 failures.** Grep the repo for
  `heartbeat` to confirm no dangling references.
- [ ] **Step 4 — commit:** `refactor(sync): drop 3-platform heartbeat — hooks cover sync`

---

## Task 4: Phone-write path — inbox helpers + process-inbox skill + AGENTS.md rules

**Files:** new `packages/cli/src/sync/inbox.mjs`, new
`templates/skills/process-inbox/SKILL.md`, edit `templates/AGENTS.md.hbs`, new
`tests/cli/sync_inbox.test.mjs`

- [ ] **Step 1 — tests first.** `sync_inbox.test.mjs`: `listInbox(aiosPath)`
  returns the `memory/inbox/*.md` files (empty array when the dir is missing);
  `clearInbox` / per-file removal works.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.**
  - `inbox.mjs`: `listInbox(aiosPath)` and a remove helper, using the existing
    `inboxDir()` path helper.
  - `templates/skills/process-inbox/SKILL.md`: a plain-markdown skill — read each
    `memory/inbox/*.md`, route its content into the correct `vault/` or
    `context/` location based on the file's `hint` + content, then `git rm` the
    inbox file. Skip + leave malformed files for human review.
  - `templates/AGENTS.md.hbs`: under `## Rules` add **two** rules — (a) the
    sync-tick rule: "Run `dotaios sync tick` at the start of a work session and
    again before finishing, so memory stays mirrored across devices." (b) the
    inbox rule: "If `memory/inbox/` contains files, read them first and use the
    `process-inbox` skill to file them, then delete the inbox file."
- [ ] **Step 4 — run, expect PASS. Run full suite, expect 0 failures.**
- [ ] **Step 5 — commit:** `feat(sync): phone-write inbox path — helper, skill, AGENTS.md rules`

---

## Task 5: README — cross-device sync section

**Files:** `README.md`

- [ ] **Step 1 — write.** Add a "Cross-device sync" section: what `dotaios sync
  setup` does, the one-time PAT step (with the broad-scope `repo` token tradeoff
  stated plainly), how the phone reads the repo (Claude Project / Codex / GitHub
  Mobile), and how the inbox + `process-inbox` skill handle phone writes. No
  mention of a daemon or a GitHub App.
- [ ] **Step 2 — run full suite, expect 0 failures** (sanity).
- [ ] **Step 3 — commit:** `docs: README cross-device sync section`

---

## Done when

All five tasks committed on `worktree-feat+github-sync`, full suite green, no
`heartbeat` references remain, and `dotaios sync setup` is a token-paste flow that
exits `0` on success. Then hand back to Filippo for the
`finishing-a-development-branch` decision (merge / PR). Do not `npm publish`.
