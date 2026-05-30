# INSTALL.md cold-machine test — honest transcript + failure points

**Date:** 2026-05-29 · **Method:** drove `INSTALL.md` literally as an agent would, doing only what the text says.
**Isolation:** clean throwaway `$HOME` (`/tmp/coldtest-*`), clean npm cache, Node installed *from scratch* via INSTALL.md's own nvm path. No Docker available on this box and the host's Node couldn't be removed, so isolation is "clean `$HOME` + freshly-installed Node," not a true bare OS. Network was available. **No fixes applied — diagnosis only.**

## Bottom line
- **Did the technical install complete unattended (no human)? YES** — Step 1 (install Node) → Step 2 (`init`) → Step 3 (`activate`) all ran clean, no prompts hung, no guessing, on a clean `$HOME`.
- **Did the FULL onboarding complete unattended? NO — by design.** Step 4 is a 3-question interview; it *must* pause for the user's answers. That's the point of onboarding, not a defect.
- **First point of human friction:** Step 4 (the interview) — **intended**. The first *unintended* risk is **Step 1 (Node install)** on the macOS-without-Homebrew path (details below) and the all-automated-paths-fail fallback.

## Step-by-step transcript

### Step 1 — install Node — ✅ works, with one real trap
- Literal `node --version` on a cold box fails → agent must install Node.
- Ran INSTALL.md's nvm path: `curl …/nvm/v0.39.0/install.sh | bash`, then `. nvm.sh && nvm install --lts`. Result: downloaded **Node v24.16.0**, checksum verified, installed into the clean `$HOME` **unattended**. ✅
- **TRAP (assume-knowledge):** the **macOS-without-Homebrew** instruction reads *"install nvm … then **open a new shell** and run `nvm install --lts`."* An agent drives **one** shell session — it can't "open a new shell," and the freshly-installed nvm isn't on `PATH` in the current one. The **Linux** path correctly includes `export NVM_DIR=… && . "$NVM_DIR/nvm.sh"` before `nvm install`; the **macOS-no-brew** path omits that source line. A literal-following agent on a no-brew Mac would run `nvm install --lts` → `nvm: command not found` → stall/guess.
  - This matters for the ICP: **non-technical Mac users almost never have Homebrew**, so they land on exactly this no-brew path.
- The Homebrew path (`brew install node`, gated on `brew --version`) and Windows (`winget …`) are standard one-liners; fine when those tools exist.
- Final graceful fallback (*"tell the user: install LTS from nodejs.org, then confirm"*) is a clean human-handoff — but it is the single most likely real-world stall: a non-technical user being asked to go download and install Node by hand.

### Step 2 — `npx dotaios init --yes` — ✅ clean
- Installed the published `dotaios` from npm and scaffolded **43 files**, `aios.json` present. No hang.
- Note: `npx dotaios` on a real **TTY** first-run prints *"Need to install … Ok to proceed? (y)"*. In this non-interactive run npx auto-proceeded; an agent in a TTY-driven session would need to answer it. Low risk, worth knowing.

### Step 3 — `npx dotaios activate` — ✅ clean
- Linked 11 skills, refreshed `skills/INDEX.md`, and handled **"no AI tools detected"** gracefully (clear next step). ✅

### Step 4 — the 3-question interview — ⏸ required human input (by design)
- The agent asks name+role, current work, priorities **one at a time**, waits for answers, then edits files with its own tools.
- **Verified the edit targets match the real scaffold:** `context/identity.md` has `## Basics` + `- Name:`/`- Role:`; `work.md` has `## Current Work`; `priorities.md` has `## Current Bets`. A file-capable agent edits them correctly — **no guessing**.
- **Assume-capability:** requires an agent with file-editing tools that can parse the markdown. True for the target agents (Claude Code/Codex/Cursor/Gemini); a plain web chat could not — but INSTALL.md scopes itself to file-capable agents.

### Step 5 — closing message — ✅ no execution, fine.

## Failure points / assume-knowledge (ranked)
1. **macOS-without-Homebrew Node install** — "open a new shell" is not agent-followable and the `. nvm.sh` source line (present in the Linux path) is missing. Most likely path for non-technical Mac users. **Highest-leverage gap.**
2. **All-automated-paths-fail fallback → manual nodejs.org install** — the most likely point a real non-technical user gets stuck and must act.
3. **`npx` first-run "Ok to proceed?" prompt on a TTY** — an agent must answer it; not mentioned in INSTALL.md.
4. **Step 4 needs file-editing tools** — fine for target agents, blocks non-file agents (acceptable, but undocumented as a prerequisite).
5. **Network required** (nvm + npx) — a truly offline cold box fails. Unavoidable; not worth addressing.

## What this does NOT tell us
A real LLM agent was not in the loop — I followed the text literally as a stand-in. The remaining unknown is whether a given agent *interprets* the prose correctly (e.g., reads `node --version` output and picks the right OS branch). The literal-follow surfaced the structural traps above; an agent-in-the-loop run would confirm interpretation quality.

## Agent-in-the-loop run — against the FIXED INSTALL.md (2026-05-30)

After the doc fixes landed (`4e9de73`), a real subagent was dropped into a fresh throwaway `$HOME` with a **node-less, brew-less PATH** (so it was forced to do Step 1 and routed to the macOS-without-Homebrew branch — the one that was just fixed) and told to follow `INSTALL.md` literally, stopping at the Step 4 interview.

**Result:**
- **Reached the Step 4 interview unattended? YES.** Steps 1–3 ran end-to-end with no human input; it stopped at the 3-question gate without fabricating answers.
- **Stalls / guesses / deviations: NONE.** Every command came straight from the literal text.
- **The fixed macOS-without-Homebrew Node path worked verbatim in a single shell:** `brew --version` failed → no-brew branch → `curl … | bash` then `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts` produced a working `node` v24.16.0 + `npx`. The literal-pass trap (#1) is resolved — no "open a new shell" deviation was needed.
- **Final state:** `npx -y dotaios init --yes` created `aios.json` + 43 files; `npx -y dotaios activate` linked 11 skills (no tools detected in the throwaway HOME); the Step 4 edit targets (`identity.md` `## Basics`/Name/Role, `work.md` `## Current Work`, `priorities.md` `## Current Bets`) all present.
- Only cosmetic note: nvm printed "Profile not found" because the sandbox HOME had no shell rc file — irrelevant since the guide's explicit `. nvm.sh` loads it in-session; a real Mac account has a `~/.zshrc`.

**Install-success signal: PASS.** A capable agent completes the technical install (Node → init → activate) unattended and reaches the intended human gate with zero stalls or guesses.

## Caveats on record (the PASS is conditional)
1. **Strong-model / optimistic case.** The agent-in-the-loop run used a strong model — the realistic-ICP but optimistic case. A weaker agent could still misread a step (e.g. pick the wrong OS branch, or not recover from an unexpected error). The number is "a capable agent succeeds," not "any agent succeeds."
2. **Ran against the published package.** The run used `npx -y dotaios` (published 1.17.0), not the local branch build. `init`/`activate` are unchanged on the branch, so the behavior is equivalent — but this was not a test of the exact branch artifacts end to end.

## Before public launch (not done yet — harden the number)
- A **true bare-OS run** (Docker / fresh VM with no Node and no host bleed-through), to remove the "clean `$HOME` + host tooling" asterisk.
- A **weaker-agent sample** (run the same loop with a smaller model) to bound the pessimistic case, so the install-success claim isn't only the strong-model number.
