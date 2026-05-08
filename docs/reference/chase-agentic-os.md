---
title: "3 Step Custom Agentic OS (5/4/26) - Claude Code"
source: "https://www.skool.com/chase-ai/classroom/7f632f47?md=2207b96b5ee04945a20c5f8d44a4182c"
author:
published:
created: 2026-05-07
description: "Architecture Prompt:You are helping me design and build my own Claude Code Agentic OS. An Agentic OS is the architecture that turns Claude Code from random one-"
tags:
  - "clippings"
---

3 Step Custom Agentic OS (5/4/26)

17:30

Architecture Prompt:  
  
You are helping me design and build my own Claude Code Agentic OS.

An Agentic OS is the architecture that turns Claude Code from random one-off prompts into a system I can run, track, and hand off. It has three core layers:

1. SKILL ARCHITECTURE — my daily work codified as reusable skills, organized by business domain
2. MEMORY — an Obsidian-style vault that compounds knowledge across sessions
3. OBSERVABILITY — a way to see what's running, what's working, and what's drifting

Your job is to walk me through building MY version, not yours. You will discover what I do, organize it into the architecture, and produce a concrete starter package I can build from on day one.

You will NOT hand-write the actual skill files yourself. When it comes time to build skills, you will hand me off to Anthropic's `skill-creator` skill (which exists as `/plugin install skill-creator@anthropics`). Your job ends at producing the SPECS for each skill — `skill-creator` builds the actual files.

\========================================================  
RULES OF ENGAGEMENT  
\========================================================

- Ask ONE question at a time. Wait for my answer. Do not dump all phases at once.
- After each phase, briefly summarize what you heard back to me and confirm before moving on.
- Be a thought partner, not a yes-man. If I say something contradictory or vague, push back and ask for specifics.
- Use plain language. No jargon unless I use it first.
- When I am done with a phase, you proceed to the next phase automatically — do not ask my permission to move forward.
- At the end, you will produce concrete files and a 7-day plan. Do not skip the deliverable.

\========================================================  
PHASE 1 — BRAIN DUMP  
\========================================================

Start by asking me to brain dump everything I do in a typical week. Tell me to be messy — no structure, no categorization, no filtering. Just a stream of every recurring task, project, communication channel, tool, deliverable, and ritual that fills my time. I should aim for 20-50 items minimum.

Prompt me with examples to unstick me if I freeze:

- "What do you do every Monday morning?"
- "What's the first thing you check when you sit down?"
- "What do you wish you didn't have to do?"
- "What do you keep meaning to do but never get to?"

Wait until I say I'm done dumping.

\========================================================  
PHASE 2 — DOMAIN EXTRACTION  
\========================================================

Read my brain dump. Propose 5-9 DOMAINS that organize what I do. Each domain should be a major area of work (e.g., Research, Content, Sales, Community, Admin, Finance, Agency, Memory). Use language I used, not generic business school terms.

Show me the domains as a clean list with a one-line description of what falls under each. Ask: "Does this match how you think about your work? What would you rename, merge, split, or add?"

Iterate with me until I say it's right. Then lock the domain list.

\========================================================  
PHASE 3 — SKILL DISCOVERY (per domain)  
\========================================================

For each domain, ask me five questions in order. Wait for me to answer each before asking the next:

1. "What did you do 3+ times in this domain in the last week?"
2. "What in this domain feels manual, repetitive, or copy-paste?"
3. "What in this domain could a smart intern do, but you do yourself because explaining it is too painful?"
4. "What would break in this domain if you got 10x more volume tomorrow?"
5. "What would 10x your output in this domain if it ran on autopilot?"

After all five, propose 4-7 candidate SKILLS for that domain. Each skill should be:

- A specific, repeatable task with a clear input and output
- Written as a verb phrase: "draft sponsor reply", "generate weekly client status", "categorize raw transactions"
- Tagged with a one-line description of what it does

Ask me to confirm, edit, or remove. Lock the skill list for that domain. Move to the next domain. Repeat until all domains are covered.

\========================================================  
PHASE 4 — AUTOMATION TRIAGE  
\========================================================

For every skill across every domain, ask me three questions:

1. "How often does this need to run?" (on-demand / daily / weekly / monthly / event-triggered)
2. "Does this skill need to touch local files, the filesystem, or local CLIs?" (yes/no)
3. "Does this skill need to keep running while your laptop is closed?" (yes/no)

Apply this decision rule and tag each skill with one of:

- ON-DEMAND — I trigger it manually
- LOCAL ROUTINE — runs on a local schedule (needs filesystem access OR I'm always on a desktop)
- CLOUD ROUTINE — runs remotely on a schedule (web/API only, must run while laptop is closed)

Be honest with me — if a skill doesn't yet need automation, leave it on-demand. Do not over-automate.

\========================================================  
PHASE 5 — DELIVERABLE OUTPUT  
\========================================================

Now produce the starter package. Output the following four artifacts in order, as code blocks I can copy directly:

### Artifact 1: CLAUDE.md

A starter master prompt for the root of my Agentic OS folder. It should:

- Define the OS persona (thought partner, not chatbot)
- List the folder structure (raw/, wiki/, projects/,.claude/skills/, decisions/, references/)
- Reference the domains we locked
- Reference the skills we identified, organized by domain
- Note that the OS is a living document and should be updated as new domains/skills emerge

### Artifact 2: Skill Folder Structure

A directory tree showing exactly which folders to create:  
.claude/skills/  
\[domain-1\]/  
\[skill-1\]/ [skill.md](http://skill.md/ "http://skill.md")  
\[skill-2\]/ [skill.md](http://skill.md/ "http://skill.md")  
\[domain-2\]/  
...

### Artifact 3: Prioritized First 3 Skills

Pick the three highest-leverage skills to build FIRST. Justify each pick using:

- Frequency (how often I do it)
- Pain (how much manual effort it removes)
- Reversibility (low-risk to mess up while iterating)

For each, do NOT hand-write the full [skill.md](http://skill.md/ "http://skill.md"). Instead, output:

- A one-paragraph spec (what it does, what it triggers on, what it outputs)
- The exact prompt I should run to invoke Anthropic's `skill-creator` skill to scaffold it properly with correct YAML frontmatter, trigger phrases, and eval structure. Format the prompt as a code block I can copy directly.

Example for one skill:

> "Use the skill-creator skill to build a new skill called `[skill-name]`. It should: \[spec\]. Trigger phrases: \[list\]. Output: \[what it produces\]."

This keeps me from hand-writing markdown that the skill-creator does better and more consistently.

### Artifact 4: 7-Day Build Plan

A concrete day-by-day plan:

- Day 1: Set up the folder structure + paste [CLAUDE.md](http://claude.md/ "http://CLAUDE.md"). Install Anthropic's `skill-creator` skill (`/plugin install skill-creator@anthropics`) — this is the tool you'll use to build every skill from here on out.
- Day 2-4: Build the first 3 skills using `skill-creator` (one per day). Run the spec prompts from Artifact 3. After each skill is generated, test it on a real input from your work that day. Iterate the [skill.md](http://skill.md/ "http://skill.md") until the output matches what you'd produce manually.
- Day 5: Wire ONE local routine using Claude Code's `/schedule` (or a local cron pointing at `claude` CLI) — pick the most painful recurring task. Set up ONE memory pattern: drop a raw input into `raw/`, run a skill that compiles it to `wiki/`, confirm the loop works.
- Day 6: Add ONE more skill. Same process — `skill-creator`, test on real input, iterate.
- Day 7: Audit. What worked? What's drifting? What's still manual that should be a skill? Update [CLAUDE.md](http://claude.md/ "http://CLAUDE.md") with anything new. Plan next week's 1-3 additions. Re-run me (this prompt) in 6 months as your work evolves.

Meta-skill recommendation: Beyond `skill-creator`, the user should also be aware of:

- `dream` — memory consolidation skill, useful once you have ~10+ skills and want Claude to clean up your memory files
- `update-config` — for setting up hooks (e.g., auto-run a skill when you open Claude Code in the morning)

Mention these as "later additions" — not Day 1 priority. The user should master `skill-creator` and the basic build loop first.

\========================================================  
GO  
\========================================================

Begin Phase 1 now. Ask me for the brain dump.  

---

Dashboard Prompt  
  
Build me a local Streamlit dashboard called "Agentic OS Dashboard" — a wrapper for my Claude Code skills.

This is a STARTER SHELL, NOT a finished product. Every skill button is a clearly-labeled placeholder. After you finish building, you will start a conversation with me to wire in MY actual skills.

Two phases:  
PHASE 1 — Build the scaffold (silent, just ship the files)  
PHASE 2 — Open a conversation with me to customize it

\==========================================================  
PHASE 1 — BUILD THE SCAFFOLD  
\==========================================================

ARCHITECTURE

- Stack: Streamlit (Python). Single `app.py`. No React, no Next.js, no build step.
- Config split: `app.py` is logic only. `config.example.py` (committed) holds template paths + skill list. `config.py` (gitignored) is user's personal copy.
- Data source: reads `~/.claude/usage-data/session-meta/*.json` (graceful empty if missing).
- MCP detection: read `~/.claude.json` (fallback `~/.claude/.mcp.json`), parse `mcpServers` key.
- Skill execution: each button shells out via `subprocess.Popen(["claude", "-p", prompt])` in a daemon thread, output appended to activity feed. Naive, not streaming JSON. Member can upgrade later.

FILES TO CREATE

1. `app.py` — single-file dashboard (~350-450 lines)
2. `config.example.py` — template config
3. `config.py` — copy of example (we add to.gitignore)
4. `.streamlit/config.toml` — theme
5. `requirements.txt` — loose-pinned deps
6. `.gitignore`
7. `README.md` — 5-line quickstart

---

## AESTHETIC — JETBRAINS MONO TERMINAL COCKPIT

CRITICAL: This must look like a terminal cockpit, not generic Streamlit. Get this wrong, the whole thing fails. Get this right, member instantly recognizes "that looks like Chase's."

Rules:

- JetBrains Mono everywhere. NO serif. NO Anthropic Sans. Mono is the entire type system.
- UPPERCASE for all headlines + labels with letter-spacing 0.06–0.20em
- Ring shadows ONLY (`box-shadow: 0 0 0 1px var(--ring-soft)`) — no borders, no drop shadows
- Border-radius: 2-3px (sharp, not pillowy). Cockpit, not consumer app.

CSS — paste these exactly into a `<style>` block injected at top of `app.py`:

@import url(' [https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap')](https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap%27\) "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap')");

:root {  
\--bg: [#0e0f10](#0e0f10 "#0e0f10");  
\--bg-elev: #141516;  
\--bg-card: [#1c1b19](#1c1b19 "#1c1b19");  
\--ring-soft: rgba(209, 207, 197, 0.18);  
\--ring-mid: rgba(209, 207, 197, 0.30);  
\--fg: [#faf9f5](#faf9f5 "#faf9f5");  
\--fg-dim: [#b0aea5](#b0aea5 "#b0aea5");  
\--fg-mute: [#87867f](#87867f "#87867f");  
\--accent: [#c96442](#c96442 "#c96442");  
\--good: [#8fb97a](#8fb97a "#8fb97a");  
\--danger: [#b53333](#b53333 "#b53333");  
}

html, body, \[class\*="css"\] { font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace; color: var(--fg); }  
.stApp { background: var(--bg); }

\[data-testid="stStatusWidget"\], \[data-testid="stToolbar"\], [#MainMenu](#MainMenu "#MainMenu"), footer,  
\[data-testid="stDecoration"\], \[data-testid="stHeader"\], header\[data-testid="stHeader"\] {  
display: none!important; height: 0!important;  
}  
.block-container { padding-top: 1rem!important; max-width: 1480px; }

.hero-title {  
font-family: 'JetBrains Mono', monospace!important;  
font-size: 2.4rem; font-weight: 600; letter-spacing: 0.05em; line-height: 1;  
margin: 0 0 0.4rem 0; text-transform: uppercase;  
}  
.hero-title em { font-style: normal; color: var(--accent); }

.title-meta { font-size: 0.66rem; color: var(--fg-mute); letter-spacing: 0.12em; text-transform: uppercase; text-align: right; line-height: 1.5; }  
.title-meta.live { color: var(--good); }

.hero-card {  
background: var(--bg-card); border-radius: 3px; padding: 0.85rem 1rem;  
box-shadow: 0 0 0 1px var(--ring-soft); min-height: 92px;  
}  
.hero-label { font-size: 0.62rem; letter-spacing: 0.18em; color: var(--fg-mute); text-transform: uppercase; margin-bottom: 0.45rem; }  
.hero-headline { font-size: 1rem; font-weight: 500; color: var(--fg); letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.2; }  
.hero-headline em { font-style: normal; color: var(--accent); }  
.hero-bar { height: 4px; background: var(--bg-elev); border-radius: 1px; overflow: hidden; margin-top: 0.5rem; }  
.hero-bar >.fill { height: 100%; background: var(--accent); border-radius: 1px; }

.pulse-dot { width: 8px; height: 8px; background: var(--good); border-radius: 50%; display: inline-block; margin-right: 0.5rem; vertical-align: middle; animation: pulse 1.1s ease-in-out infinite; }  
@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1.0; } }

.cat-label {  
color: var(--accent); font-size: 0.62rem; letter-spacing: 0.2em;  
font-weight: 500; text-transform: uppercase; margin: 1rem 0 0.5rem 0;  
padding-bottom: 0.35rem; border-bottom: 1px solid var(--ring-soft);  
}  
.col-label {  
color: var(--fg); font-size: 0.7rem; letter-spacing: 0.22em;  
font-weight: 500; text-transform: uppercase; margin: 0.4rem 0 0.6rem 0;  
}

.mcp-strip { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0.3rem 0 0.6rem 0; }  
.mcp-chip {  
display: inline-flex; align-items: center; gap: 6px;  
background: var(--bg-card); border-radius: 999px; padding: 4px 12px;  
font-size: 0.7rem; color: var(--fg-dim); box-shadow: 0 0 0 1px var(--ring-soft);  
text-transform: lowercase; letter-spacing: 0.04em;  
}  
.mcp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-mute); }

.stButton > button {  
background: var(--bg-card); color: var(--fg-dim); border: none; border-radius: 2px;  
padding: 0.6rem 0.8rem; font-family: 'JetBrains Mono', monospace!important;  
font-weight: 500; font-size: 0.72rem!important; letter-spacing: 0.06em;  
text-transform: uppercase; text-align: left; width: 100%; height: auto; white-space: normal;  
box-shadow: 0 0 0 1px var(--ring-soft); transition: box-shadow 0.12s, color 0.12s;  
}  
.stButton > button:hover { color: var(--accent)!important; box-shadow: 0 0 0 1px var(--accent)!important; }

.stTextInput > div > div > input {  
background: var(--bg-elev); color: var(--fg); border: none; border-radius: 3px;  
font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; padding: 0.55rem 0.75rem;  
box-shadow: 0 0 0 1px var(--ring-soft);  
}  
.stTextInput > div > div > input:focus { box-shadow: 0 0 0 1px var(--accent); outline: none; }

.skill-desc { font-size: 0.6rem; color: var(--fg-mute); margin: 0.2rem 0 0.9rem 0.1rem;  
letter-spacing: 0.04em; line-height: 1.35; text-transform: uppercase; }

.aos-feed {  
background: var(--bg-elev); border-radius: 3px; padding: 0.85rem 1rem;  
box-shadow: 0 0 0 1px var(--ring-soft); height: 280px; overflow-y: auto;  
font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; line-height: 1.55; color: var(--fg-dim);  
}  
.aos-feed.ts { color: var(--accent); }  
.aos-feed.name { color: var(--fg); font-weight: 500; }  
.aos-feed-empty { color: var(--fg-mute); letter-spacing: 0.06em; text-transform: uppercase; }

/ *Bright placeholder banner — must be visible so member knows skills are stubs* /  
.placeholder-banner {  
background: rgba(217, 165, 102, 0.08); color: var(--fg); border-radius: 3px;  
padding: 0.7rem 1rem; box-shadow: 0 0 0 1px rgba(217, 165, 102, 0.4);  
font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; margin: 0.5rem 0 1rem 0;  
}  
.placeholder-banner em { font-style: normal; color: [#d9a566](#d9a566 "#d9a566"); }

---

## LAYOUT (top to bottom)

1. **Header row.** Left: `AGENTIC OS` (mono uppercase, 2.4rem, weight 600, accent color on `OS`). Right: pulse-dot + `SYSTEM · LIVE` (green) over vault name + plan + timestamp.
2. **Placeholder banner.** Bright amber strip immediately below header:  
	`// PLACEHOLDER WRAPPER — these skills are stubs · ask Claude Code to swap them for yours`  
	This is critical. Member must know nothing here is real until they wire it.
3. **3 hero-cards row.** Custom HTML (NOT plotly Indicator). Each card has:
	- `.hero-label` (e.g. `5-HOUR TOKEN WINDOW`)
		- `.hero-headline` showing `42,180 / 200,000 21%` (number/cap percent in accent color)
		- `.hero-bar` progress bar at the percent
	Cards: 5-HR TOKEN WINDOW, WEEKLY TOKEN WINDOW, DAILY ROUTINES.  
	Empty state: replace numbers with `—`, headline reads `NO DATA YET`, bar at 0%.
4. **7-day cumulative activity chart.** Use Altair (NOT plotly). Line color `--accent`, area fill `--accent-soft`, axis colors `--fg-mute`, mono font. Wrap layered charts with `alt.layer(...)` not `+`. Empty state: skip the chart, show `<div class="aos-feed-empty" style="padding: 2rem 1rem;">// NO ACTIVITY YET — RUN A CLAUDE CODE SESSION TO POPULATE</div>`.
5. **MCP server strip.** Detected servers as chips. Empty: single chip "NO MCP SERVERS CONFIGURED".
6. **Skills grid.** Section anchor `// SKILLS` with `.cat-label`. Two columns (`// DAILY` left, `// CONTENT` right). Each skill renders:
	- Optional `st.text_input` if `input_placeholder` exists
		- `st.button` with label
		- `<div class="skill-desc">` description below
	No category badge per skill — column header is the badge.
7. **Activity feed.** Bottom panel. `<div class="aos-feed">`. Each entry: `[HH:MM:SS] SKILL_NAME · first line`. Empty: `// no activity yet — click a placeholder to test`.

---

## SUBPROCESS (NAIVE — keep simple)

When a button is clicked:

1. Build cmd = \[CLAUDE\_CLI, "-p", prompt\_template.replace("{input}", user\_input or "")\]
2. If PERMISSION\_MODE == "bypassPermissions", append --permission-mode bypassPermissions
3. Spawn in daemon thread via subprocess.Popen
4. Read stdout line by line, push first non-empty line to activity feed via st.session\_state
5. On exit, push "done (exit N)" line

That's it. No JSONL parsing. No runtime state machine. Member can upgrade later.

---

## PLACEHOLDER SKILLS (config.example.py)

Make placeholders OBVIOUSLY placeholders. Each label has `[PH]` prefix:

SKILLS = \[  
{"label": "\[PH\] Morning Brief", "prompt\_template": "Generate one-page brief of today's top AI/Claude Code stories.", "description": "PLACEHOLDER · swap with your daily skill", "category": "daily"},  
{"label": "\[PH\] Vault Cleanup", "prompt\_template": "Scan vault folders for files older than 7 days and move to /archive.", "description": "PLACEHOLDER · swap with your weekly skill", "category": "daily"},  
{"label": "\[PH\] Inbox Triage", "prompt\_template": "Triage today's Gmail inbox into urgent/warm/sponsor/noise.", "description": "PLACEHOLDER · swap with your inbox skill", "category": "daily"},  
{"label": "\[PH\] Deep Research", "prompt\_template": "Run deep multi-source research on: {input}", "description": "PLACEHOLDER · swap with your research skill", "category": "content", "input\_placeholder": "topic"},  
{"label": "\[PH\] Outline Video", "prompt\_template": "Generate a YouTube video outline for: {input}", "description": "PLACEHOLDER · swap with your outline skill", "category": "content", "input\_placeholder": "video topic"},  
{"label": "\[PH\] Content Cascade", "prompt\_template": "Generate blog + LinkedIn + X article from: {input}", "description": "PLACEHOLDER · swap with your repurpose skill", "category": "content", "input\_placeholder": "youtube URL"},  
\]

Tolerant to ANY shape — missing field = sensible default.

---

## CONFIG.EXAMPLE.PY

from pathlib import Path

VAULT\_PATH = Path.home() / "Documents" / "my-vault" # CHANGE ME  
VAULT\_NAME = "My Agentic OS"  
CLAUDE\_CLI = "claude"  
SESSION\_META\_DIR = Path.home() / ".claude" / "usage-data" / "session-meta"  
MCP\_CONFIG = Path.home() / ".claude.json"

CLAUDE\_PLAN = "pro" # "pro" | "max" | "team"  
PERMISSION\_MODE = "default" # or "bypassPermissions"  
TOKEN\_CAPS = {"five\_hour": 200\_000, "weekly": 2\_000\_000}  
ROUTINE\_CAPS = {"pro": 25, "max": 100, "team": 500}

SKILLS = \[... \] # placeholders shown above

---

## SESSION-META JSON SCHEMA

Each \*.json in SESSION\_META\_DIR is tolerated to have:  
{ "timestamp": "2026-05-04T19:54:00Z",  
"tokens\_in": 42180, "tokens\_out": 18722,  
"is\_routine": false, "cost\_usd": 0.42, "skill": "morning" }

All fields optional. Missing folder/empty folder → all metrics = 0.

---

## README.md (5 LINES — KEEP TIGHT)

## Agentic OS Dashboard

Local Streamlit cockpit for Claude Code (starter scaffold).  
pip install -r requirements.txt  
cp [config.example.py](http://config.example.py/ "http://config.example.py") [config.py](http://config.py/ "http://config.py") # edit paths  
streamlit run [app.py](http://app.py/ "http://app.py")  

Customize: open Claude Code in this folder. Talk to it.

\============================================================

PHASE 2 — START THE CONVERSATION

\============================================================

After the 7 files are saved, do NOT stop. Print this exactly to me:

────────────────────────────────────────────────────────

WRAPPER UP. NOW YOURS.

────────────────────────────────────────────────────────

Files shipped:

• [app.py](http://app.py/ "http://app.py") (~400 lines, terminal cockpit shell)

• [config.example.py](http://config.example.py/ "http://config.example.py") (placeholder skills, paths)

• [config.py](http://config.py/ "http://config.py") (copy of above — edit this one)

•.streamlit/config.toml (theme)

• requirements.txt

•.gitignore

• [README.md](http://readme.md/ "http://README.md")

Boot it:

pip install -r requirements.txt

streamlit run [app.py](http://app.py/ "http://app.py")

Open [http://localhost:8501](http://localhost:8501/ "http://localhost:8501") in another window so you can see changes live as we work.

────────────────────────────────────────────────────────

Now we wire YOUR skills in. I have questions for you:

1\. List your existing Claude Code skills.

Run `ls ~/.claude/skills` (or paste the names). I need labels + a one-line

description for each. We'll swap the \[PH\] placeholders for these.

2\. Which 3-6 do you want on the dashboard for Day 1?

Don't dump every skill — pick the ones you'd hit a button for.

The rest stay in your skills folder, invokable via Claude Code directly.

3\. Group them how?

Default columns are DAILY (left) / CONTENT (right). What works for you?

(e.g. SALES / ADMIN, INPUT / OUTPUT, MORNING / WORK / NIGHT.)

4\. Brand it?

Default accent is terracotta (#c96442). Want a different color? Hex or vibe.

5\. Extra panels you want?

Examples: GitHub commits today, vault file count, scheduled-routine calendar,

last-skill-run timestamps. Skip if you want to keep Day 1 lean.

────────────────────────────────────────────────────────

Pick any one to start (skill list is the most leverage).

When you answer, I'll edit the files in place and you'll see it update live.

Do not skip Phase 2. The point of this scaffold is to start the conversation —

the wrapper itself is just the door we walk through.  

