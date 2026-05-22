# Onboarding Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a non-technical web-chat user able to go from "never heard of DotAIOS" to "a working `~/aios/` folder their agent reads" by installing one agent app and pasting one line — the agent does Node + setup, the user types no terminal commands.

**Architecture:** Three surfaces edited as one funnel — (A) the marketing website (`website/`, static React+Babel-in-browser SPA) is refreshed and its broken/stale CTA fixed; (B) the handoff is one agent-neutral paste line pointing at the GitHub repo; (C) `INSTALL.md` becomes the single canonical agent setup script, with `README.md` / `docs/friend-setup.md` reconciled so the agent path and the human-terminal path stop contradicting each other. No CLI feature code, no new infrastructure.

**Tech Stack:** Static HTML/CSS + React 18 via Babel-standalone-in-browser (no build step); Markdown docs; Vercel static hosting.

**Spec:** `docs/superpowers/specs/2026-05-22-onboarding-funnel-design.md`

---

## Notes for the implementer

- **This is a content/docs change set, not application code.** There is no test
  harness for prose or for a no-build SPA. The TDD loop is adapted: each task
  makes an exact edit, then **verifies with a `grep`/visual check**, then commits.
  Where a step says "verify", run the command shown and confirm the stated result
  before moving on.
- **The website has no build step.** `website/*.jsx` is transpiled in the browser
  by Babel-standalone. A syntax error will not fail a build — it fails silently at
  runtime. You MUST open the site in a browser (Task 9) to confirm it still renders.
- **The canonical paste line — use this EXACT string everywhere it appears:**

  ```
  Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.
  ```

  It appears in `website/app.jsx` (as `INSTALL_SNIPPET`) and in `README.md`. The
  two MUST be byte-identical — Task 9 verifies this.
- **Do not** touch the GitHub-sync feature branch, write CLI feature code, or deploy
  to Vercel production. Preview deploys only, and only in Task 9.
- Work happens on branch `feat/onboarding-funnel` (already created off `main`).

---

## File map

| File | Change | Tasks |
|---|---|---|
| `website/app.jsx` | Snippet constants, hero install box, version pill, hero-meta, hero-lede, new `WhatItDoes` section, HowItWorks copy | 1–5 |
| `website/styles.css` | CSS for the new two-step install block and the feature cards | 2, 4 |
| `INSTALL.md` | Full rewrite — single canonical agent setup script | 6 |
| `README.md` | Simplify "Installing with AI help"; fix Claude download URL | 7 |
| `docs/friend-setup.md` | Add a pointer to the agent path | 7 |
| `installers/windows/README.md` | Prepend a "not a shipped path" deprecation note | 8 |

---

## Task 1: Update the website snippet constants

**Files:**
- Modify: `website/app.jsx:7-8`

- [ ] **Step 1: Replace the two snippet constants**

Find (lines 7–8):

```jsx
const INSTALL_SNIPPET = `Ask Claude Code: "Read this and set up DotAIOS for me: https://github.com/filocosta46/dotaios"`;
const NPX_SNIPPET = `npx dotaios init`;
```

Replace with:

```jsx
const INSTALL_SNIPPET = `Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.`;
const NPX_SNIPPET = `npx dotaios setup`;
```

Rationale: the old line names "Claude Code" (the ICP has no Claude Code) and points
at the bare repo. The new line is agent-neutral and names `INSTALL.md` directly.
`npx dotaios setup` (not `init`) is the correct one-shot for the terminal path.

- [ ] **Step 2: Verify the old strings are gone**

Run: `grep -n "Ask Claude Code\|npx dotaios init" website/app.jsx`
Expected: no output (exit code 1).

- [ ] **Step 3: Verify the new paste line is present**

Run: `grep -c "follow INSTALL.md step by step" website/app.jsx`
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add website/app.jsx
git commit -m "fix(website): agent-neutral paste line, setup not init"
```

---

## Task 2: Rebuild the hero install box as a two-step path

**Files:**
- Modify: `website/app.jsx` — the `install` block inside `Hero()` (currently lines 127–151)
- Modify: `website/styles.css` — add install-step CSS after the `.install-alt` rule (currently ends at line 329)

- [ ] **Step 1: Replace the install block JSX**

Find this block inside `Hero()` (currently lines 127–151):

```jsx
        <div id="install" className="install">
          <div className="install-head">
            <span className="lbl">paste this into any AI chat</span>
            <span>60 seconds</span>
          </div>
          <code>
            <span className="prompt">›</span>
            <span>Ask </span>
            <span className="arg">Claude Code</span>
            <span>: </span>
            <span className="quote">"Read this and set up DotAIOS for me: https://github.com/filocosta46/dotaios"</span>
          </code>
          <button className={`copy-btn ${copied ? "copied" : ""}`} onClick={() => copy(INSTALL_SNIPPET, setCopied)}>
            {copied ? "✓ copied" : "Copy"}
          </button>

          <div className="install-or">or, if you prefer the command line</div>

          <div className="install-alt">
            <code><span className="lead">$</span>{NPX_SNIPPET}</code>
            <button className={`copy-btn ${copiedNpx ? "copied" : ""}`} onClick={() => copy(NPX_SNIPPET, setCopiedNpx)} style={{ position: 'static' }}>
              {copiedNpx ? "✓" : "Copy"}
            </button>
          </div>
        </div>
```

Replace with:

```jsx
        <div id="install" className="install">
          <div className="install-head">
            <span className="lbl">get started</span>
            <span>2 steps · ~60 seconds</span>
          </div>

          <div className="install-step">
            <span className="install-step-num">1</span>
            <div className="install-step-body">
              <b>Open an AI agent app.</b>
              <p>
                DotAIOS works with any agent that reads <code>AGENTS.md</code> —
                Claude Code, Codex, Cursor, Gemini, Antigravity. Don't have one
                yet?{" "}
                <a href="https://claude.com/download" target="_blank" rel="noopener">
                  Install Claude Code
                </a>{" "}
                — free, and the easiest place to start.
              </p>
            </div>
          </div>

          <div className="install-step">
            <span className="install-step-num">2</span>
            <div className="install-step-body">
              <b>Paste this line into it.</b>
              <div className="install-line">
                <code>
                  <span className="prompt">›</span>
                  <span className="quote">{INSTALL_SNIPPET}</span>
                </code>
                <button
                  className={`copy-btn ${copied ? "copied" : ""}`}
                  onClick={() => copy(INSTALL_SNIPPET, setCopied)}
                  style={{ position: "static" }}>
                  {copied ? "✓" : "Copy"}
                </button>
              </div>
            </div>
          </div>

          <div className="install-or">already comfortable in a terminal?</div>

          <div className="install-alt">
            <code><span className="lead">$</span>{NPX_SNIPPET}</code>
            <button
              className={`copy-btn ${copiedNpx ? "copied" : ""}`}
              onClick={() => copy(NPX_SNIPPET, setCopiedNpx)}
              style={{ position: "static" }}>
              {copiedNpx ? "✓" : "Copy"}
            </button>
          </div>
        </div>
```

Note: the old absolute-positioned top-right copy button is removed; both copy
buttons are now inline (`position: static`). The `copied` / `copiedNpx` state
hooks already exist in `Hero()` (lines 79–80) — no state change needed.

- [ ] **Step 2: Add the install-step CSS**

In `website/styles.css`, immediately after the `.install-alt .lead` rule
(currently line 329), add:

```css

/* Two-step get-started block */
.install-step {
  display: flex; gap: 12px;
  margin-bottom: 14px;
}
.install-step-num {
  flex: 0 0 22px;
  width: 22px; height: 22px;
  border-radius: 50%;
  background: var(--cobalt);
  color: var(--paper);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  display: grid; place-items: center;
}
.install-step-body { flex: 1; min-width: 0; }
.install-step-body b {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 15px;
  color: var(--ink);
  display: block;
  margin-bottom: 4px;
}
.install-step-body p {
  margin: 0;
  font-size: 13.5px;
  color: var(--ink-soft);
  line-height: 1.55;
}
.install-step-body p code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--cobalt-tint);
  color: var(--cobalt-deep);
  padding: 1px 5px;
  border-radius: 4px;
}
.install-step-body a { color: var(--cobalt-deep); font-weight: 600; }
.install-line {
  display: flex; align-items: center; gap: 10px;
  margin-top: 8px;
  background: var(--paper);
  border: 1px solid var(--hairline-2);
  border-radius: 8px;
  padding: 10px 12px;
}
.install-line code {
  display: block; flex: 1; min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}
```

- [ ] **Step 3: Verify**

Run: `grep -c "install-step-num" website/app.jsx`
Expected: `2`

Run: `grep -c "install-line" website/app.jsx`
Expected: `1`

Run: `grep -c "install-step-num" website/styles.css`
Expected: `1`

Run: `grep -c "install-line" website/styles.css`
Expected: `2` (the `.install-line` and `.install-line code` rules)

- [ ] **Step 4: Commit**

```bash
git add website/app.jsx website/styles.css
git commit -m "feat(website): two-step get-started block in hero"
```

---

## Task 3: Fix the version pill, hero-meta strip, and hero-lede

**Files:**
- Modify: `website/app.jsx` — `Hero()`: hero-tag (lines 116–119), hero-lede (lines 123–125), hero-meta (lines 153–166)

- [ ] **Step 1: Replace the stale version pill**

Find (currently lines 116–119):

```jsx
        <span className="hero-tag">
          <span className="pill">v0.3</span>
          local · file-based · no sign-up
        </span>
```

Replace with:

```jsx
        <span className="hero-tag">
          <span className="pill">open source</span>
          local · file-based · no sign-up
        </span>
```

Rationale: `v0.3` is wrong (package is at 1.14.6) and any hardcoded number rots.
A non-versioned label cannot go stale.

- [ ] **Step 2: Update the hero-lede tail for ubiquity**

Find (currently lines 123–125):

```jsx
        <p className="hero-lede">
          DotAIOS is one folder on your computer. <code>~/aios/</code> — that holds your context, your memory, and the things you'd like your AI to do for you. Claude, Cursor, Gemini, Codex: they all read from the same place. Write it once, every tool knows.
        </p>
```

Replace with:

```jsx
        <p className="hero-lede">
          DotAIOS is one folder on your computer. <code>~/aios/</code> — that holds your context, your memory, and the things you'd like your AI to do for you. Claude Code, Cursor, Gemini, Codex, and any agent that reads <code>AGENTS.md</code> all read from the same place. Write it once, every tool knows.
        </p>
```

- [ ] **Step 3: Replace the hero-meta strip**

Find (currently lines 153–166):

```jsx
        <div className="hero-meta">
          <div className="hero-meta-item">
            <b>One folder</b>
            <span>plain Markdown, on your machine</span>
          </div>
          <div className="hero-meta-item">
            <b>Four tools</b>
            <span>Claude · Cursor · Codex · Gemini</span>
          </div>
          <div className="hero-meta-item">
            <b>No cloud</b>
            <span>no sign-up, no sync, no server</span>
          </div>
        </div>
```

Replace with:

```jsx
        <div className="hero-meta">
          <div className="hero-meta-item">
            <b>One folder</b>
            <span>plain Markdown, on your machine</span>
          </div>
          <div className="hero-meta-item">
            <b>Every agent</b>
            <span>anything that reads AGENTS.md</span>
          </div>
          <div className="hero-meta-item">
            <b>No account</b>
            <span>no server we run; sync is your own GitHub</span>
          </div>
        </div>
```

Rationale: "Four tools" undersells the ubiquity that is a headline selling point.
"no sync, no server" became false when GitHub cross-device sync shipped — the
accurate claim is no DotAIOS-run server and no account; sync is opt-in on the
user's own GitHub.

- [ ] **Step 4: Verify the stale strings are gone**

Run: `grep -n "v0.3\|Four tools\|no sign-up, no sync, no server" website/app.jsx`
Expected: no output (exit code 1).

- [ ] **Step 5: Commit**

```bash
git add website/app.jsx
git commit -m "fix(website): honest version pill, ubiquity + sync-accurate hero meta"
```

---

## Task 4: Add the "What it does" feature section

**Files:**
- Modify: `website/app.jsx` — add a `WhatItDoes()` component and render it in `App()`
- Modify: `website/styles.css` — add feature-card CSS after the `.slash` rules (currently end at line 591)

- [ ] **Step 1: Add the `WhatItDoes` component**

In `website/app.jsx`, insert this complete component immediately before the
`function Footer()` declaration (currently line 249):

```jsx
function WhatItDoes() {
  return (
    <section className="section" data-screen-label="What it does">
      <span className="section-eyebrow">What it does</span>
      <h2 className="section-title">More than a profile. A working memory.</h2>
      <p className="section-lede">
        Your context is the start. DotAIOS also pulls in what you read, remembers
        what you discussed, and follows you across devices.
      </p>
      <div className="steps">
        <div className="feature">
          <h3>Cross-device sync</h3>
          <p>
            Mirror your folder to a private GitHub repo, so an AI on your phone
            reads the same memory. Opt-in, and it runs on your own GitHub — no
            server we host.
          </p>
          <span className="feature-cmd">dotaios sync setup</span>
        </div>
        <div className="feature">
          <h3>Reads the web</h3>
          <p>
            Hand it a URL, a PDF, or a document. DotAIOS extracts clean Markdown
            into your vault — JavaScript-heavy pages included, via a built-in
            headless browser.
          </p>
          <span className="feature-cmd">dotaios ingest &lt;url&gt;</span>
        </div>
        <div className="feature">
          <h3>Remembers your sessions</h3>
          <p>
            Save AI conversations locally so your context compounds — across
            tools and across time. Search every past session from one place.
          </p>
          <span className="feature-cmd">dotaios capture enable</span>
        </div>
      </div>
    </section>);

}
```

- [ ] **Step 2: Render `WhatItDoes` in `App()`**

In `App()`, find (currently line 289):

```jsx
      <HowItWorks />
      <Marketplace />
```

Replace with:

```jsx
      <HowItWorks />
      <WhatItDoes />
      <Marketplace />
```

- [ ] **Step 3: Add the feature-card CSS**

In `website/styles.css`, immediately after the `.slash span em` rule (currently
line 591), add:

```css

/* ---------- What it does (feature cards) ---------- */
.feature {
  padding: 24px;
  border-radius: var(--radius);
  border: 1px solid var(--hairline);
  background: var(--card);
  display: flex; flex-direction: column; gap: 10px;
}
.feature h3 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 20px;
  letter-spacing: -0.02em;
  margin: 0;
  color: var(--ink);
}
.feature p {
  color: var(--ink-soft);
  margin: 0;
  font-size: 14.5px;
  line-height: 1.55;
}
.feature .feature-cmd {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--cobalt-deep);
  background: var(--cobalt-tint);
  padding: 4px 8px;
  border-radius: 5px;
  align-self: flex-start;
  margin-top: 2px;
}
```

The section reuses the existing `.steps` 3-column grid, which is already
responsive (collapses to one column under 980px) — no new grid CSS needed.

- [ ] **Step 4: Verify**

Run: `grep -c "function WhatItDoes\|<WhatItDoes />" website/app.jsx`
Expected: `2`

Run: `grep -c "feature-cmd" website/styles.css`
Expected: `1`

- [ ] **Step 5: Commit**

```bash
git add website/app.jsx website/styles.css
git commit -m "feat(website): add 'what it does' section for sync, web-fetch, sessions"
```

---

## Task 5: Refresh HowItWorks copy for ubiquity

**Files:**
- Modify: `website/app.jsx` — `HowItWorks()` Step 01 paragraph (currently line 208)

- [ ] **Step 1: Update the Step 01 paragraph**

Find (currently line 208):

```jsx
          <p>Claude Code, Cursor, Gemini, Codex pick any of them. It creates the folder, asks you who you are and what you're working on, and saves your answers.</p>
```

Replace with:

```jsx
          <p>Claude Code, Cursor, Gemini, Codex, Antigravity — pick any agent you already use. It creates the folder, asks you who you are and what you're working on, and saves your answers.</p>
```

This is the only HowItWorks change — Step 02's title ("Every AI reads the same
folder") and Step 03 already carry the ubiquity message. Do not expand further.

- [ ] **Step 2: Verify**

Run: `grep -c "pick any agent you already use" website/app.jsx`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add website/app.jsx
git commit -m "docs(website): ubiquity wording in how-it-works step 1"
```

---

## Task 6: Rewrite INSTALL.md as the single canonical agent script

**Files:**
- Modify: `INSTALL.md` (full replacement)

- [ ] **Step 1: Replace the entire file contents**

Overwrite `INSTALL.md` with exactly this:

```markdown
# DotAIOS — Agent Setup Guide

> This document is written for AI agents (Claude Code, Codex, Cursor, Gemini, and others).
> A human has asked you to set up DotAIOS for them.
> Follow each step in order. Do not skip steps. The human should never need to type
> a terminal command — you run them.

---

## Before you start

DotAIOS creates a folder at `~/aios/` that you and every other AI tool on this
machine will read automatically. It holds context about who the user is, what
they're working on, and skills you can run on their behalf.

Your job: install it, connect it, learn a few things about the user through
friendly conversation, then explain what they now have.

Run every command yourself. Do not ask the user to open a terminal or paste
commands.

---

## Step 1 — Make sure Node.js 20+ is available

Run:
```
node --version
```

- Returns `v20.x.x` or higher → continue to Step 2.
- Returns a lower version, or the command fails → **install Node.js yourself**,
  then re-check. Do not send the user to a download page unless automated install
  is impossible.
  - **macOS** with Homebrew (`brew --version` succeeds): `brew install node`
  - **macOS** without Homebrew: install nvm, then Node —
    `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash`
    then open a new shell and run `nvm install --lts`
  - **Windows**: `winget install OpenJS.NodeJS.LTS`
  - **Linux**:
    `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash`
    then `nvm install --lts`
- Only if every automated path fails: tell the user *"I need Node.js to continue.
  Please install the LTS version from nodejs.org, then tell me when it's done."*
  and wait for them to confirm.

After installing, run `node --version` again and confirm it reports `v20.x.x` or
higher before continuing.

---

## Step 2 — Create the folder

Run:
```
npx dotaios init --yes
```

This scaffolds `~/aios/` with placeholder context files. It takes about 30
seconds. Wait for it to finish. Say nothing to the user while it runs.

Do **not** run `npx dotaios setup`. That command is the interactive path for a
human sitting at a terminal. You are on the agent path: `init` then `activate`,
with the interview done by you in Step 4.

---

## Step 3 — Connect the user's AI tools

Run:
```
npx dotaios activate
```

This writes small bridge files so Claude Code, Codex, Gemini, and other tools
find the user's context. It also auto-detects which tools are installed — you do
not need to ask the user which tools they use.

---

## Step 4 — Learn about the user (conversational — do not rush this)

Ask these three questions **one at a time**. Wait for each answer before asking
the next. Be warm and natural — you are having a conversation, not filling out a
form.

After each answer, write it directly into the correct file using your
file-editing tools. Do not ask permission to write — just do it.

**Question 1:**
> "What's your name, and what do you do for work?"

→ Write to `~/aios/context/identity.md`. Replace the placeholder line under
`## Basics` with their name and role. Leave the other sections as they are.

**Question 2:**
> "What are you working on right now? One thing or a few — whatever's taking up
> your mental energy."

→ Write to `~/aios/context/work.md`. Replace the content under `## Current Work`
with what they said. Keep it in their words.

**Question 3:**
> "What matters most this week? What would make it a good week if it got done?"

→ Write to `~/aios/context/priorities.md`. Replace the content under
`## Current Bets` with what they said.

After all three answers, say:
> "Perfect. You can change any of this later — just tell me, or run
> `dotaios interview --review` when things shift."

**Optional — do not push this:**
> "Anything else you'd like me to remember — a CV, a bio, a doc about your
> project? Drag it here or give me a link."

If they give you something:
- A file or local path → run `npx dotaios ingest <path>`
- A URL → run `npx dotaios ingest <url>`
- They say no or skip → move on immediately, do not mention it again.

---

## Step 5 — Show them what they now have

Do NOT say "try asking me to plan your day" — the memory may not have enough in
it yet to do that well.

Instead, say something like this (adapt it to what they told you):

> "You're set up. Here's what DotAIOS gives you now:
>
> **Every AI tool on this machine knows who you are.** Claude Code, Cursor,
> Codex, Gemini — they read your context automatically, with no re-introduction.
>
> **Skills you can use right now** — just ask me, or type `/` in Claude Code:
>
> - `/plan-today` — a structured plan for the day (works best after a few sessions)
> - `/today` — save today's plan to a daily note
> - `/closeday` — close the day and carry unfinished work forward
> - `/ingest` — save any article, PDF, or document into your vault
> - `/weekly-review` — review the week and update your context
> - `/audit` — check that your setup is healthy
>
> **A brief any time:** `dotaios brief` writes today's local brief into your
> daily note.
>
> **It grows with you.** When your work or priorities change, tell me and I'll
> update the files. You can drag any document in at any time."

**Optional extras — mention them, but do not set them up now.** Tell the user
these exist and that they can turn them on whenever they want:

- **Cross-device sync** — read your memory on your phone: `dotaios sync setup`
- **Save conversations** — keep AI sessions as local memory:
  `dotaios capture enable claude-code`
- **Daily brief schedule** — run the brief automatically each morning:
  `dotaios schedule install`

Do not run these during first-time setup. Keep the first run minimal.

---

## If something goes wrong

- `npx: command not found` → Node.js is not installed. Go back to Step 1 and
  install it yourself.
- `EACCES` permission error → npm permissions need fixing. See:
  https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
- `Target already exists` → `~/aios/` already exists from a previous install. Run
  `npx dotaios init --force --yes` instead.
- Anything else → run `npx dotaios status` and read the output.

---

## For agents reading the GitHub repo

If a user pointed you at `https://github.com/filocosta46/dotaios` and asked you to
set up DotAIOS, this is the file to follow. Start at Step 1 above.

### Installing third-party plugins
If the user already has DotAIOS set up and gives you a link to a different
repository to install a skill or plugin:
1. `git clone <url> /tmp/dotaios-plugin`
2. `npx dotaios install /tmp/dotaios-plugin`
3. `rm -rf /tmp/dotaios-plugin`

The full documentation is in the `docs/` folder. The skills are in `skills/`.
Everything is plain Markdown — you can read it all.
```

Key changes from the old `INSTALL.md`: Step 1 now has the agent install Node
itself instead of telling the user to visit nodejs.org; Step 4 keeps the lean
3-question conversational interview (the only interview on the agent path); Step 5
gains an "optional extras" block that *names but does not run* sync / capture /
brief; the troubleshooting `init --force` becomes `init --force --yes` (the agent
path is non-interactive, so `--force` alone would hang on the interview prompt).

- [ ] **Step 2: Verify**

Run: `grep -c "brew install node\|winget install OpenJS.NodeJS.LTS" INSTALL.md`
Expected: `2`

Run: `grep -c "Do not run these during first-time setup" INSTALL.md`
Expected: `1`

Run: `grep -n "go to nodejs.org, click the LTS button" INSTALL.md`
Expected: no output (the old "tell the user to go install it" wording is gone).

- [ ] **Step 3: Commit**

```bash
git add INSTALL.md
git commit -m "docs: INSTALL.md is the single canonical agent setup script"
```

---

## Task 7: Reconcile README.md and friend-setup.md

**Files:**
- Modify: `README.md` — line 23 (Claude download URL), lines 70–79 ("Installing with AI help" section)
- Modify: `docs/friend-setup.md` — add a pointer after the intro paragraph

- [ ] **Step 1: Fix the Claude Code download URL in README.md**

Find (currently line 23):

```markdown
- [Claude Code](https://claude.ai/download) — recommended
```

Replace with:

```markdown
- [Claude Code](https://claude.com/download) — recommended
```

(`claude.ai/download` 301-redirects to `claude.com/download`; link the canonical
URL directly.)

- [ ] **Step 2: Simplify the "Installing with AI help" section in README.md**

Find this section (currently lines 70–79):

```markdown
## Installing with AI help

If you opened this page inside Claude Code, Codex, or another AI agent — or pasted this URL into a chat — the agent can guide you through the whole installation.

**Say this to your agent:**

> Read the DotAIOS README at this URL and help me install it. First run `node --version` to check if I have Node.js 20 or higher. If I don't, install it for me: on Mac run `brew install node` if Homebrew is available, otherwise open https://nodejs.org and download the LTS installer; on Windows run `winget install OpenJS.NodeJS.LTS`; on Linux run `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash` then `nvm install --lts`. Once Node is ready, run `npx dotaios setup` and walk me through the setup questions.

The agent will check your machine, install anything missing, run `npx dotaios setup`, and walk you through the 5 setup questions. You don't need to understand the Terminal commands — just follow what it says.
```

Replace with:

```markdown
## Installing with AI help

Have an AI agent app open — Claude Code, Codex, Cursor, Gemini, or another? It can do the whole install for you. You will not type a single terminal command.

**Paste this to your agent:**

> Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step.

The agent reads [`INSTALL.md`](INSTALL.md) — a setup guide written for agents — installs Node.js if it is missing, creates your folder, connects your tools, and asks you a few questions about yourself. Just follow along.
```

The long inline Node-install prompt is removed because that logic now lives in
`INSTALL.md` Step 1. The paste line here is byte-identical to `INSTALL_SNIPPET`
in `website/app.jsx`.

- [ ] **Step 3: Add an agent-path pointer to friend-setup.md**

In `docs/friend-setup.md`, find the intro paragraph (currently lines 3–4):

```markdown
A one-page recipe for getting DotAIOS running on your Mac so your AI tools (Claude Code, Cursor, Codex, Gemini) know who you are, what you're working on, and how to help without asking you to re-explain everything.
```

Immediately after it, add this blockquote (leave one blank line before and after):

```markdown
> **Prefer not to use the terminal?** If you have an AI agent app open (Claude
> Code, Codex, Cursor, Gemini), it can do this whole install for you — see
> [`../INSTALL.md`](../INSTALL.md). Paste it one line and the agent handles every
> step. The guide below is the manual terminal path, for when you'd rather run
> the commands yourself.
```

This makes explicit that `friend-setup.md` is the human-terminal path and
`INSTALL.md` is the agent path — they no longer compete.

- [ ] **Step 4: Verify**

Run: `grep -c "claude.ai/download" README.md`
Expected: `0`

Run: `grep -c "follow INSTALL.md step by step" README.md`
Expected: `1`

Run: `diff <(grep -o "Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step." README.md | head -1) <(grep -o "Set up DotAIOS for me: read https://github.com/filocosta46/dotaios and follow INSTALL.md step by step." website/app.jsx | head -1)`
Expected: no output — the paste line is byte-identical in both files.

Run: `grep -c "the manual terminal path" docs/friend-setup.md`
Expected: `1`

- [ ] **Step 5: Commit**

```bash
git add README.md docs/friend-setup.md
git commit -m "docs: point agent installs at INSTALL.md, separate from the terminal path"
```

---

## Task 8: Mark the Windows installer as not a shipped path

**Files:**
- Modify: `installers/windows/README.md` — prepend a deprecation note

- [ ] **Step 1: Prepend the deprecation note**

At the very top of `installers/windows/README.md`, before the existing
`# Windows Installer` heading, add this note followed by a blank line:

```markdown
> **Status: not a shipped path (kept for reference).** DotAIOS onboards through
> an AI agent — the agent installs Node.js and runs setup with no terminal typing
> (see the repo's `INSTALL.md`). This MSI launcher is unbuilt, unsigned, and
> unmaintained. A native installer was evaluated and rejected on KISS grounds:
> code-signing, notarization, and per-OS CI are release infrastructure DotAIOS
> would have to own, and the installer would still need an agent app plus Node to
> be useful. Do not present this as an install option.

```

This is non-destructive — the source files stay in place; the note just stops the
folder from implying a maintained install path.

- [ ] **Step 2: Verify**

Run: `grep -c "not a shipped path" installers/windows/README.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add installers/windows/README.md
git commit -m "docs: mark the Windows MSI installer as an unshipped reference path"
```

---

## Task 9: Verify the site renders, then preview-deploy

**Files:** none modified — verification only.

- [ ] **Step 1: Serve the site locally**

```bash
cd website && python3 -m http.server 8000
```

Leave it running. (A local HTTP server is required — opening `index.html` as a
`file://` URL fails because the `text/babel` scripts are fetched over HTTP.)

- [ ] **Step 2: Open and visually check**

Open `http://localhost:8000` in a browser. Confirm ALL of the following:

- The page renders with no blank/white screen (a blank screen means a JSX syntax
  error — open the browser console, read the error, fix the file, reload).
- The hero pill reads **open source**, not `v0.3`.
- The hero "get started" box shows **two numbered steps**: step 1 ("Open an AI
  agent app", with a working "Install Claude Code" link) and step 2 ("Paste this
  line", with the paste line and a Copy button).
- Clicking **Copy** in step 2 copies the paste line (paste into a text field to
  confirm).
- The hero-meta strip reads **One folder / Every agent / No account**.
- A **"What it does"** section appears between "How it works" and the skills
  marketplace, with three cards: Cross-device sync, Reads the web, Remembers your
  sessions.
- Narrow the window below 980px: the steps and feature cards stack to one column;
  nothing overflows.

- [ ] **Step 3: Stop the local server**

Press `Ctrl+C` in the terminal running `http.server`.

- [ ] **Step 4: Preview-deploy to Vercel**

Deploy a **preview** build (NOT production). Use the `vercel:deploy` skill, or
from the repo root:

```bash
npx vercel deploy
```

Do **not** pass `--prod`. If the CLI asks to link a project, link it to the
existing `dotaios` Vercel project; do not create a new one.

Expected: the command prints a preview URL (`https://dotaios-<hash>.vercel.app`).

- [ ] **Step 5: Check the preview URL**

Open the preview URL and repeat the Step 2 visual checks against it. Confirm the
live preview matches local.

- [ ] **Step 6: Report, then STOP**

Post the preview URL to Filippo for review. **Do not promote to production** —
production deploy requires Filippo's explicit go. Do not merge `feat/onboarding-funnel`
to `main` without his approval.

---

## Self-review — spec coverage

Spec → plan mapping (every spec section has a task):

- Spec **A1** (install path two-move fix) → Task 1 (constants) + Task 2 (box).
- Spec **A2** (version pill) → Task 3 Step 1.
- Spec **A3** ("no sync, no server" reword) → Task 3 Step 3.
- Spec **A4** (feature coverage) → Task 4.
- Spec **A5** ("Four tools" → ubiquity) → Task 3 Step 3 + Task 5.
- Spec **A6** (snippets + HowItWorks copy) → Task 1 + Task 5.
- Spec **B** (the paste line) → Task 1 defines it; Task 7 reuses it identically.
- Spec **C1** (agent installs Node) → Task 6 Step 1, INSTALL.md Step 1.
- Spec **C2** (one scaffold path, no interactive `setup`) → Task 6, INSTALL.md Step 2.
- Spec **C3** (one lean interview) → Task 6, INSTALL.md Step 4.
- Spec **C4** (defer sync/brief/capture) → Task 6, INSTALL.md Step 5 extras block.
- Spec **C5** (reconcile README + friend-setup) → Task 7.
- Spec **D** (`--agent` CLI mode) → out of scope, no task — correct, it is a
  documented follow-up only.
- Spec "archive `installers/windows/`" recommendation → Task 8.
- Spec acceptance criterion "no production deploy" → Task 9 Step 6.

No spec requirement is left without a task. No CLI feature code is in any task.
```
