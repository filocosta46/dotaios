# DotAIOS Flagship + Lean Sync Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`)
> syntax. Match the repo's existing patterns (node:test, ESM `.mjs`, no em dashes
> in shipped docs). No `git add -A` in the dotaios repo, explicit paths only.

**Goal:** Ship native intent-to-skill routing (`dotaios skills resolve` + MCP
`resolve_skill` + skills-first inline boot context) and a leaner sync + high-signal
brief surface, on a branch, PR-ready, no main merge.

**Architecture:** A new `packages/core/src/skill-resolver.mjs` holds the
deterministic plain-text scoring function shared by the CLI and the MCP server.
`activate --skills-first` persists a preference in `aios.json` that `bridgeContent`
reads to inline the catalog. Sync switches from `git add -A` to explicit-path
commits. A new `dotaios plan` command + lean `--lean` brief surface round out the
high-signal default load.

**Tech Stack:** Node.js (ESM), `node:test`, plain Markdown/JSONL. No new deps.

---

## File Structure

- Create: `packages/core/src/skill-resolver.mjs` — scoring + boot-context renderer
- Create: `tests/core/skill-resolver.test.mjs` — resolver unit tests
- Create: `tests/cli/skills_resolve.test.mjs` — CLI resolve tests
- Modify: `packages/cli/src/commands/skills.mjs` — add `resolve` subcommand
- Modify: `packages/cli/src/commands/activate.mjs` — `--skills-first` flag + persist
- Modify: `packages/core/src/bridges.mjs` — `bridgeContent` inlines catalog when skills-first
- Modify: `packages/mcp/src/server.mjs` — `resolve_skill` tool + instructions
- Modify: `tests/mcp/server.test.mjs` — add `resolve_skill` to expected tools list
- Modify: `packages/cli/src/sync/git.mjs` — explicit-path `commitChanges`
- Modify: `packages/cli/src/sync/tick.mjs` — call explicit-path commit
- Modify: `tests/cli/sync_git.test.mjs` — update for explicit paths
- Create: `packages/cli/src/commands/plan.mjs` — `dotaios plan` artifact command
- Create: `tests/cli/plan.test.mjs` — plan command tests
- Modify: `packages/cli/src/commands/brief.mjs` — `--lean` high-signal surface
- Modify: `packages/cli/src/index.mjs` — register `plan` command
- Modify: `templates/AGENTS.md.hbs` — document `dotaios skills resolve`
- Modify: `README.md`, `CHANGELOG.md` — release notes
- Create: `docs/gitsync-mobile.md` — mobile GitSync guidance
- Modify (user's `~/aios`, separate repo): `projects/dotaios-product/ROADMAP.md`,
  `projects/hermes-fleet/reports/2026-06-28-dotaios-flagship-shipped.md`

## Scoring design (no embeddings, no network)

For each skill, compute a score from the intent string:

- **Exact-name hit** (+100): the intent equals the skill `name` or `dir`.
- **Trigger token overlap**: tokenize intent + each trigger on whitespace,
  lowercase, drop stopwords. Score = sum over triggers of
  `2 * (shared tokens) / (intent tokens + trigger tokens)` (Jaccard-ish), weighted
  by trigger length. A trigger that is a substring of the intent (or vice versa)
  gets a +0.5 bonus.
- **Description overlap**: Jaccard of intent tokens vs description tokens, capped
  at 0.5 contribution.
- **Specificity tiebreak**: more declared triggers wins; then name alpha.

A skill scores above 0 only if it shares at least one non-stopword token with a
trigger or description, or is an exact-name hit. Below a small threshold
(`MIN_SCORE = 0.05`) it is not returned. Exit 2 when nothing clears the bar.

---

## Task 1: skill-resolver.mjs core

**Files:**
- Create: `packages/core/src/skill-resolver.mjs`
- Test: `tests/core/skill-resolver.test.mjs`

Steps: write failing tests (trigger overlap, exact-name, no-match empty, --json
shape via `rankSkills`, boot-context render), run, implement, run, commit.

## Task 2: CLI `dotaios skills resolve`

**Files:**
- Modify: `packages/cli/src/commands/skills.mjs`
- Test: `tests/cli/skills_resolve.test.mjs`

`resolve` is a positional subcommand: `dotaios skills resolve "<intent>" [flags]`.
Flags: `--json`, `--full`, `--all`, `--boot-context`, `--path <dir>`, `--limit <n>`.
Default prints top match (name, dir, confidence, triggers, SKILL.md path). `--full`
also prints the SKILL.md body. `--all` prints the ranked list. Exit 2 on no match.

## Task 3: MCP `resolve_skill`

Insert `resolve_skill` into `tools()` right after `list_skills`; wire `callTool`;
update `instructions` string; update `tests/mcp/server.test.mjs` expected array.

## Task 4: `activate --skills-first` + inline bridgeContent

Add `--skills-first` to `activate.mjs` parseOptions; persist
`skills_first: true` in `aios.json`. `bridgeContent(agent, aiosPath, { skillsFirst })`
reads the file (or accepts an override) and inlines `INDEX.md` + `RESOLVER.md` text
inside the managed block when true. Default stays pointer-mode.

## Task 5: `--boot-context` output

`renderBootContext(skills, aiosPath)` in `skill-resolver.mjs` prints a
`## Skills first` block: the resolver rule + the catalog (name + triggers + path),
as Markdown prompt context. Fleet scripts capture it as text with
`BOOT_CONTEXT="$(dotaios skills resolve --boot-context)"` and append that variable
to the agent prompt.

## Task 6: sync explicit-path commits

Replace `commitAll`'s `git add -A` with `git status --porcelain -z` parse ->
explicit `git add -- <path>` per entry (handles A/M/D/R/C). Keep `commitAll` name
for API compat but implement via explicit paths. Update the two `sync_git` tests
that assert `add -A`.

## Task 7: lean brief + `dotaios plan`

`dotaios brief --lean` prints a small high-signal surface: identity + priorities +
north-star + today's daily note + active project README (first project README
found). `dotaios plan [name]` writes/prints a `plan.md` (or `plans/<name>.md`)
artifact: title, goal, steps checkboxes, status. Agents pick it up across
sessions because it lives in the AIOS folder.

## Task 8: docs + roadmap + ship report

README, CHANGELOG "Added" section, AGENTS.md.hbs skills section,
`docs/gitsync-mobile.md`, user's `~/aios` ROADMAP + hermes-fleet report.

## Task 9: run suite, commit, push branch

`node --test tests/**/*.test.mjs`. Commit with explicit paths. Push branch to
origin if auth allows. No merge.
