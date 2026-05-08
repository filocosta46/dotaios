# AIOS — Consolidated Product Brief v2

**Date**: 2026-05-06  
**Status**: Final draft — ready for execution  
**Supersedes**: aios-product-plan.md, aios-handoff-prompt.md (which remain as reference)

---

## The Core Insight

AIOS is **not an app**. It's invisible infrastructure.

The user never opens AIOS. They open Claude Code, Cursor, Codex, or Antigravity — and those tools automatically read `~/.aios/` files. AIOS makes every AI agent smarter because it gives them durable personal context: who you are, what you're working on, how you write, what your priorities are.

**Analogy**: `.gitconfig` makes Git know your name. `~/.aios/` makes every AI agent know your life.

---

## Positioning

**One-liner**: Dotfiles for AI agents — personal memory that makes every AI tool smarter.

**What it is**: A local-first folder convention (`~/.aios/`) with a CLI installer that scaffolds your personal context, a memory system, and a plugin architecture. Every AI agent reads these files. Knowledge compounds across sessions and tools.

**What it is NOT**:
- Not an agent framework (not LangChain, not CrewAI)
- Not a SaaS (no cloud, no accounts, no server)
- Not a new chat app (you use your existing AI tools)
- Not developer-only (any student who uses ChatGPT can use this)

---

## ICP (Ideal Customer Profile)

**Primary**: AI-native students and operators — people who already use Claude Code, Codex, Cursor, or similar AI tools but treat them as stateless chatbots. They've taken the step of installing an AI tool on their machine but haven't organized their personal context for agents.

**Secondary**: Developers and technical operators who want to extend the system with plugins.

**NOT the ICP (yet)**: Non-technical users who only use web ChatGPT and would never open a terminal. They come in v2 with a desktop app wrapper.

**The key UX realization**: The user's daily interface is Claude Code / Cursor / Codex. AIOS is invisible. They install it once via CLI, answer some setup prompts, and then their AI tools just know them better. The only time they touch the CLI again is to install a plugin or check status.

---

## Install UX (What the user actually experiences)

```bash
# Step 1: One command (requires Node.js — which they already have if using Claude Code)
npx dotaios init

# Interactive setup (2 minutes):
# → What's your name?
# → What do you do? (student / freelancer / employee / founder)
# → What are you working on right now? (free text)
# → What AI tools do you use? (Claude Code / Cursor / Codex / Other)
# → Want to connect Gmail? (y/N — skippable)
#
# → ✅ Created ~/.aios/ with your personal context
# → ✅ Generated CLAUDE.md for Claude Code
# → ✅ Generated AGENTS.md for Codex/Gemini
# → ✅ Generated .cursorrules for Cursor
# → ℹ️  Open your AI tool now — it will automatically read your context.

# Step 2: There is no step 2. Open Claude Code. It just works.

# Optional: check health
npx dotaios status
# ✅ Context: identity.md, priorities.md configured
# ✅ Agent files: CLAUDE.md, AGENTS.md, .cursorrules generated
# ⚠️ Vault: empty (run: npx dotaios ingest <file> to add knowledge)
```

**Critical**: No `npm install -g`. No cloning repos. No editing config files. `npx` handles everything — one command, interactive prompts, done.

---

## v1 Architecture (Updated with all feedback)

### Folder structure

```
~/.aios/
├── CLAUDE.md                    # Claude Code entrypoint (auto-loaded)
├── AGENTS.md                    # Universal agent entrypoint (Codex, Gemini)
├── .cursorrules                 # Cursor entrypoint (auto-loaded by Cursor)
├── .env                         # User secrets (gitignored)
├── .env.example                 # Template showing what secrets are needed
├── .gitignore                   # Security defaults
├── aios.json                    # Schema version + user config
│
├── context/                     # WHO YOU ARE — loaded every session
│   ├── identity.md              # Name, background, skills, values
│   ├── work.md                  # Active threads, what you're working on
│   ├── priorities.md            # Current bets, next actions
│   ├── north-star.md            # Long-term direction, decision filters
│   └── domains/                 # Mental modes (loaded on demand per project)
│       ├── make.md              # Creative output voice
│       ├── sell.md              # Commercial/outreach voice
│       └── build.md             # Engineering principles
│
├── projects/                    # WHAT YOU'RE DOING — active work
│   └── <slug>/
│       └── README.md            # Frontmatter: domain, status
│
├── memory/                      # WHAT THE SYSTEM REMEMBERS
│   ├── events.jsonl             # Append-only state change log
│   ├── signals/                 # Classified ephemeral inputs (auto-expires 30d)
│   │   └── <date>.jsonl
│   └── errors.jsonl             # Failed operations log
│
├── vault/                       # LONG-TERM KNOWLEDGE — loaded on demand
│   ├── wiki/                    # Articles organized by topic
│   │   └── <topic>/_index.md
│   ├── raw/                     # Ingested sources, clippings, dumps
│   ├── org/                     # CRM — companies + people profiles
│   │   ├── companies/           # ← SINGLE SOURCE for company data
│   │   └── people/              # ← SINGLE SOURCE for people data
│   ├── outputs/                 # Generated content (cascade, reports)
│   └── writing-style.md         # Voice and tone reference
│
├── connections/                 # WHAT'S WIRED
│   ├── registry.md              # Service status table
│   └── apis/                    # Endpoint references per service
│
├── skills/                      # WHAT THE SYSTEM CAN DO
│   ├── <name>/SKILL.md          # Agent-readable instruction sets
│   └── _registry.json           # Installed skills manifest
│
├── plugins/                     # EXTENSIONS (community or paid)
│   └── <name>/
│       ├── manifest.json        # Plugin contract
│       ├── SKILL.md
│       └── src/
│
├── schedules.yml                # Automation schedule definitions
├── decisions/log.md             # Architectural decision log
└── archives/                    # Deprecated material
```

### Architecture fixes (from Claude's feedback)

#### Fix 1: Entity collision resolved

**Problem**: The original plan had `memory/entities/companies/` AND `vault/org/companies/` — same data, two places, inevitable divergence.

**Fix**: **Single source of truth at `vault/org/`**. No `memory/entities/` directory. Company and people profiles live in one place. The agent routing logic determines *how often* to load them:
- Working on a job application for Onomondo? → Load `vault/org/companies/onomondo.md`
- General morning report? → Don't load any org files unless signals reference them
- CRM update from email? → Write to `vault/org/companies/` directly (with approval)

The **frequency** of access is a routing concern, not a storage concern.

#### Fix 2: Google Workspace stays `gws`-first for beta

**Problem**: Custom Google OAuth is too much surface area for the first public beta, and storing credentials inside DotAIOS would weaken the local-first trust story.

**Fix**: DotAIOS uses an explicit `npx dotaios connect google` command that detects and verifies the local Google Workspace CLI (`gws`). OAuth credentials stay in `gws`, not DotAIOS. The shipped beta path writes local read-first Gmail/Calendar/Drive guidance and defers custom OAuth or MCP Google connectors until after friend feedback.

#### Fix 3: Schema versioning

**Problem**: No migration path when AIOS v1.1 changes `identity.md` schema.

**Fix**: `aios.json` at the root:
```json
{
  "schema_version": "1.0.0",
  "created_at": "2026-05-06",
  "ai_tools": ["claude-code", "cursor"],
  "vault_path": null
}
```
`npx dotaios upgrade` command checks version and runs migration scripts if schema changed. Migrations are simple: add new fields to existing files without removing old content.

#### Fix 4: Token-trimmed event log

**Problem**: `events.jsonl` loaded every session will hit token limits as it grows.

**Fix**: Agent routing logic loads only the **last 50 events** (not the full log). The CLAUDE.md routing table specifies:
```markdown
## Memory routing
- events.jsonl: Load last 50 entries. Full history available via /search-memory skill.
- signals/: Load today + yesterday only. Older signals available on request.
```
Additionally, a `npx dotaios cleanup` command trims signals older than 30 days and compacts the event log (summarize old events into a `memory/events-archive.jsonl`).

---

## Memory Model (Final)

```
                    ┌─────────────────────────────┐
                    │     AGENT CONTEXT WINDOW     │
                    │  (what the AI sees each time) │
                    └─────────────┬───────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
    ┌─────────▼─────────┐  ┌─────▼─────┐  ┌─────────▼─────────┐
    │  context/          │  │ memory/   │  │  vault/            │
    │  (always loaded)   │  │ (recent)  │  │  (on demand)       │
    │                    │  │           │  │                    │
    │  identity.md       │  │ last 50   │  │  wiki articles     │
    │  work.md           │  │ events    │  │  org/companies     │
    │  priorities.md     │  │           │  │  org/people         │
    │  north-star.md     │  │ today +   │  │  raw ingested docs  │
    │  domains/ (routed) │  │ yesterday │  │  writing-style.md  │
    │                    │  │ signals   │  │  outputs/           │
    └────────────────────┘  └───────────┘  └────────────────────┘
         ALWAYS               TRIMMED          ROUTED BY TASK
```

**Write permissions (tiered safety model):**

| Data type | Auto-write? | Approval needed? |
|-----------|-------------|-----------------|
| `memory/signals/` (ephemeral classified inputs) | ✅ Yes | No — expires in 30 days |
| `memory/events.jsonl` (state changes) | ⚠️ By skills only | Reviewed in daily digest |
| `vault/org/` (CRM) | ❌ No | Human confirms via approval skill |
| `vault/wiki/` (knowledge) | ❌ No | Human confirms or writes directly |
| `context/` (identity, priorities) | ❌ No | Human edits directly |

---

## Plugin Manifest (v1)

```json
{
  "name": "gmail-triage",
  "version": "1.0.0",
  "description": "Email classification, triage, and daily digest",
  "license": "MIT",
  "aios_version": ">=1.0.0",
  
  "requires": {
    "connections": ["google-workspace"],
    "context": ["identity.md", "priorities.md"]
  },
  
  "provides": {
    "skills": ["gmail-triage", "gmail-digest"],
    "memory_writers": ["signals/email"],
    "scheduled_tasks": [
      {"name": "morning-triage", "cron": "0 8 * * *", "skill": "gmail-triage"}
    ]
  },
  
  "permissions": {
    "read": ["context/*", "vault/org/*"],
    "write": ["memory/signals/*", "vault/outputs/*"],
    "write_with_approval": ["vault/org/*", "memory/events.jsonl"],
    "connections": ["google-workspace:gmail.readonly"]
  }
}
```

---

## Realistic 7-Day Plan (Scope-cut per Claude's feedback)

### What v1 ships

- `npx dotaios init` — interactive scaffolding
- `npx dotaios status` — health check
- `npx dotaios ingest <file>` — save material to vault
- Auto-generated `CLAUDE.md`, `AGENTS.md`, `.cursorrules`
- 4 base skills (plan-today, audit, ingest, morning-digest)
- Clean README + MIT LICENSE + CONTRIBUTING.md
- Documented plugin manifest contract (for community devs)

### What v1 does NOT ship (pushed to v1.1)

- Gmail plugin (requires OAuth + googleapis — v1.1, ~week 3)
- Career Ops paid plugin (requires IP clarification — v1.1+)
- Payment gate / Gumroad integration
- `npx dotaios upgrade` (v1.1)
- `npx dotaios cleanup` (v1.1)

### Day-by-day

| Day | Focus | Deliverable | Acceptance criteria |
|-----|-------|-------------|-------------------|
| 1 | Monorepo + CLI skeleton | `packages/cli` + `packages/core`, `npx dotaios --help` works | Can run `npx dotaios --version` from anywhere |
| 2 | `aios init` + templates | Interactive prompts → `~/.aios/` with filled context files | Fresh directory gets working AIOS in 2 min |
| 3 | Agent file generation | CLAUDE.md, AGENTS.md, .cursorrules auto-generated from context | Open Claude Code in `~/.aios/` → it reads the context |
| 4 | `aios status` + `aios ingest` | Health check + file ingestion to vault/raw/ | Status shows ✅/⚠️, ingest copies + indexes files |
| 5 | Base skills | Port plan-today, audit, ingest, morning-digest (generalized) | Skills run against template context without errors |
| 6 | aios.json + plugin contract | Schema versioning, documented manifest.json spec, `npx dotaios install` for local plugins | A developer can create + install a plugin |
| 7 | README + polish + release | README with install demo, LICENSE, CONTRIBUTING, security audit, v1.0.0 tag | A stranger can install + configure AIOS without reading source |

### Definition of done

A student who uses Claude Code can:
1. Run `npx dotaios init` and answer 5 questions
2. Open Claude Code — it reads their context automatically
3. Ask Claude "what am I working on?" — Claude answers correctly from their `work.md`
4. Run `/plan-today` — gets a structured day plan
5. The whole thing took under 5 minutes

---

## Business Model

| Component | License | Price |
|-----------|---------|-------|
| AIOS core (CLI, templates, memory, base skills) | MIT | Free |
| Gmail triage plugin | MIT | Free |
| Career Ops plugin | Commercial | $29 one-time or $5/mo |
| Advanced Gmail (auto-label, status detection) | Commercial | $5/mo |
| GTM Research plugin | Commercial | $9/mo |
| Content Cascade plugin | Commercial | $5/mo |

**Distribution**: npm registry (`npx dotaios init`). Paid plugins via Gumroad/LemonSqueezy with license key.

---

## What to build where (repo structure)

```
aios/                              # New public repo
├── packages/
│   ├── cli/                       # @aios/cli — the npx command
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── init.mjs
│   │   │   │   ├── status.mjs
│   │   │   │   ├── ingest.mjs
│   │   │   │   └── install.mjs
│   │   │   └── index.mjs
│   │   └── package.json
│   │
│   └── core/                      # @aios/core — schema validators + utils
│       ├── src/
│       │   ├── schema.mjs
│       │   ├── memory.mjs
│       │   └── manifest.mjs
│       └── package.json
│
├── templates/                     # Scaffolding templates
│   ├── context/
│   │   ├── identity.md.hbs
│   │   ├── work.md.hbs
│   │   ├── priorities.md.hbs
│   │   └── north-star.md.hbs
│   ├── CLAUDE.md.hbs
│   ├── AGENTS.md.hbs
│   ├── cursorrules.hbs
│   ├── aios.json.hbs
│   └── .gitignore
│
├── skills/                        # Base skills (MIT)
│   ├── plan-today/SKILL.md
│   ├── audit/SKILL.md
│   ├── ingest/SKILL.md
│   └── morning-digest/SKILL.md
│
├── docs/
│   ├── getting-started.md
│   ├── plugin-development.md
│   └── architecture.md
│
├── README.md
├── LICENSE                        # MIT
├── package.json                   # Monorepo root
└── pnpm-workspace.yaml
```

---

## Unresolved (needs your call)

| Decision | Options | My recommendation |
|----------|---------|-------------------|
| **npm package name** | `aios`, `aios-os`, `dotaios`, `aios-memory` | Check `npm view aios` — if taken, go with `aios-os` |
| **GitHub org vs personal** | `filocosta46/aios` vs new org `aios-os/aios` | New org looks more professional for an OSS product |
| **Career-ops IP** | `santifer/career-ops.git` ownership | Must resolve before Day 6. If shared, can't monetize. |
| **Vault path config** | `vault/` inside `~/.aios/` vs configurable external path | Add `vault_path` to `aios.json` — default `null` means inside `~/.aios/`, or point to e.g. `~/Brain/Obsidian-Mind/` |
