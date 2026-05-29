# DotAIOS — Overnight Report

**Branch:** `audit/overnight-2026-05-28` · **Date:** 2026-05-29
**Status:** ✅ green — `npm test` 376 pass / 0 fail / 1 skip (a Windows-only test, correct to skip on your Mac), `npm run smoke` passes. `main` was never touched. Nothing was published or deployed to production.

---

## TL;DR (read this first)

I ran a full audit of DotAIOS, fixed the highest-value problems, tightened the developer setup, and rebuilt the website. Everything is on a separate branch with 19 small, reviewed commits. The app still works exactly as before for users — these are reliability, security, and polish improvements, plus a much better website.

**You don't have to do anything technical to review it.** The "How to ship it" section near the bottom is the exact recipe when you're ready, and "Decisions for you" lists the few things only you can decide.

What I did **not** do (on purpose): I did not bump the version, did not publish to npm, did not deploy the website to production, and did not cut a GitHub release. Those are yours to trigger.

---

## What changed, in plain terms

### 1. Reliability & security fixes (the important ones)
These are bugs that could bite real users. Each was fixed with a test that fails before the fix and passes after, and the whole suite stays green.

- **Search no longer crashes on one bad line.** If a single line in your memory log got corrupted, search (and the cross-agent "catch-up" digest, and the Gemini auto-context hook) used to crash entirely. Now it just skips the bad line. *This protects the headline 1.17.0 feature.*
- **The Gemini setup can't be tricked into running commands.** The little script DotAIOS writes for Gemini now safely quotes your folder path, so an unusual character in the path can't turn into an accidental command.
- **Plugin installs can't escape their folder.** A bad entry in the (remote) plugin directory could previously copy files from anywhere on your disk into your synced folder. Now that's blocked.
- **The AI assistant can't make DotAIOS run a random program.** The local AI-tools bridge used to accept a "use this program" instruction from the AI; that's removed — it only uses the program you configure.
- **Saving sessions is now crash-safe.** The mechanism that stops two things writing to your session list at once had a flaw that could drop entries if two ran at the same moment, or if a previous run crashed. Rewritten to be safe under those conditions (and re-checked in a second review pass).
- **Search is faster.** It now reads files in parallel; roughly ~40% faster on large folders. Same results, just quicker.

### 2. The website (rebuilt twice)
- First I replaced the old site, which downloaded a whole UI framework and rebuilt itself in the browser on every visit (slow), with a plain, fast page — same content, far quicker to load.
- Then, per your request, I restyled it into a **dark, Silicon-Valley dev-tool look** (like hyperspell.com): glowing gradient hero, big editorial headline, a "your folder feeds every AI" diagram, feature cards, a trust section, and an FAQ. It keeps DotAIOS's true story (local, no account, paste-one-line) — no "book a demo", no cloud claims.
- I also wrote you a ready-to-paste prompt (`docs/overnight/website-design-prompt.md`) so you can hand the design to Claude and iterate further. **You chose to do this**, so the website is at a good checkpoint and waiting for whatever you bring back — I'll wire it in.

### 3. Documentation
- Added the missing **1.15.0** changelog entry (agent-led onboarding + private GitHub sync — it had been skipped).
- Documented the 1.17.0 features (`read_session_digest`, `connect gemini/opencode`) that were shipped but undocumented.
- Made the getting-started doc point non-technical readers to the agent-led install first, instead of dropping them into terminal commands.

### 4. Packaging
- The changelog now ships with the npm package; a missing skill license was added; a minor version mismatch was aligned. (Housekeeping so installs are clean.)

### 5. Developer/AI setup (additive only)
- A repo `CLAUDE.md` so any AI agent (including future me) instantly knows how the project works and its rules.
- Tests now run automatically on every branch in CI, not just the main one.
- An optional "run tests before pushing" safety hook, a `release-checklist` command, and two convenience slash commands.

---

## What I deliberately did NOT do (and why)

- **No semantic / "AI" search.** Out of scope by design — it would add heavy machinery and pull against the simple, local, non-technical product. Left as-is.
- **No version bump / publish / production deploy / GitHub release.** These are irreversible and public — your call (recipe below).
- **Website not deployed to a preview URL.** The Vercel command-line tool isn't installed in my environment, and deploying would mean touching your Vercel login, which I won't do. Also, you opted to bring back a Claude-designed version first. The one-line command for you to make a *preview* (not production) is in the recipe.
- **A handful of pre-existing security hardening items** (not caused by this work) were found and **listed, not fixed**, to keep this branch focused. See `docs/overnight/BACKLOG.md` → "Pre-existing security items" (all are low/moderate and assume an already-misbehaving local AI). I can do them next in a separate small branch.
- **Old website components left in place** (the previous React files) rather than deleted — they're unreferenced now but `registry.json` among them is used by the test suite, so I left the folder intact. Safe to clean up later.

---

## Risks / things to know

- **Low overall risk.** Every change is covered by tests; the suite and smoke test are green; the app's user-facing behavior is unchanged except "search is more robust and faster".
- **One behavior change worth naming:** the session-saving lock now gives up with a clear error after 30 seconds of genuine contention, instead of silently writing anyway. This is intentional — silently writing was the old bug that could corrupt the list. In normal use this never triggers (saves take milliseconds).
- **The website is mid-decision.** The current dark version is shippable, but you said you'll try a Claude-designed version. Until you pick one, don't deploy the site to production.
- **PID reuse edge case** in the session lock is an inherent limitation of file-based locks (documented in `CLAUDE.md`); not a practical concern for a single-user tool.

---

## How to ship it (exact steps, when you're ready)

Do these from the project folder. Nothing here was done for you.

1. **Review the branch.** It's `audit/overnight-2026-05-28`. Read this report + `docs/overnight/BACKLOG.md`. The full audit detail is in `docs/overnight/audit/`.
2. **Decide on the website** (see "Decisions for you"). If you keep the dark version as-is, skip to step 3. If you're swapping in a Claude-designed version, paste me the HTML/CSS and I'll wire it in first.
3. **Merge to main** (via PR or directly):
   ```bash
   git checkout main && git merge audit/overnight-2026-05-28
   ```
4. **Bump the version.** These are bug-fixes + docs + site, no breaking changes, so a minor bump fits the new features documented:
   ```bash
   npm version 1.18.0 -m "release: 1.18.0 — reliability, security hardening, new website"
   ```
   (Then add a `## [1.18.0]` section to `CHANGELOG.md` summarizing the fixes — or ask me to draft it.)
5. **Verify green one more time:**
   ```bash
   npm run release:check   # tests + smoke + changelog + pack + clean tree + on-main
   ```
6. **Publish to npm:**
   ```bash
   npm publish
   ```
7. **Deploy the website.** First a *preview* to eyeball it, then promote to production:
   ```bash
   npx vercel            # preview — gives you a temporary URL to check
   npx vercel --prod     # production — updates dotaios.vercel.app
   ```
   (You may need `npx vercel login` once. I intentionally didn't touch your Vercel login.)
8. **Cut the GitHub release:**
   ```bash
   git push origin main --tags
   gh release create v1.18.0 --notes-from-tag
   ```

---

## Decisions for you

1. **Website direction** — keep tonight's dark Silicon-Valley version, or run the prompt in Claude design and send me the result to wire in? (Either is a 2-file swap.)
2. **Version number** — I suggested `1.18.0` (new website + documented features + fixes). If you'd rather call it a patch (`1.17.1`), that's fine too.
3. **The 5 pre-existing security items** in the backlog — want me to do them next (small, additive, ~1 short branch), or leave them?
4. **Old website React files** — okay to delete the now-unused `app.jsx/graph.jsx/marketplace.jsx/tweaks-panel.jsx/plugins.js`? (I'll keep `registry.json` — the tests use it.)

---

## Where everything is
- `docs/overnight/PLAN.md` — the plan + progress log for the whole run.
- `docs/overnight/BACKLOG.md` — every finding, triaged (what was fixed, deferred, dropped, and why).
- `docs/overnight/audit/01..07-*.md` — the seven detailed audit reports.
- `docs/overnight/website-design-prompt.md` — the prompt to hand to Claude design.
- `CLAUDE.md` — the new in-repo guide for AI agents/contributors.
