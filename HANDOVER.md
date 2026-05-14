# DotAIOS Project State & Handover

> **Date:** 2026-05-14
> **Latest Release:** `v1.10.0` (Live on npm and GitHub)

This document is meant to be read by the next AI Agent that resumes work on the DotAIOS project. It contains the exact state of the repository, recent decisions, and the immediate next steps.

---

## 1. Current State of the Codebase

- **Core CLI (`packages/cli/`)**: Stable at `v1.10.0`. Ships the one-shot `setup` wizard, the `doctor` health check, the `skill`/`market`/`license` command surfaces, git-URL plugin installs, and the monetization manifest fields.
- **Document ingestion**: The Universal Knowledge Router (`dotaios ingest`) is implemented and working. PDF/DOCX/PPTX/EPUB use Marker (`marker_single`) when installed, with a built-in `unpdf` fallback for PDF only. See `packages/cli/src/ingest/pdf.mjs`.
- **Website (`website/`)**: Static landing page in the monorepo, deployed to Vercel (Root Directory `website`, Framework Preset `Other`, no `vercel.json`, no fake `build` script).

## 2. Built Ahead Of Need — Keep Frozen

The skill **marketplace**, **license-key system**, and **Windows installer** were built ahead of demand. There are no paid skills yet. Do not extend or refactor these — leave them alone and focus elsewhere. This is a go-to-market sequencing call for Filippo, not an engineering problem.

## 3. Active Work — Make The Folder Agent-Agnostic

The current focus. Today DotAIOS only knows how to connect three AI tools (Claude Code, Codex, Gemini) — the list is frozen in code, so a new agent gets nothing, a mid-task tool switch hits a wall, and installed skills only ever reach Claude.

Approved direction: **Approach C built on A.**
- **A** — move the frozen tool list out of code into an editable registry (`packages/core/src/agents.json`, extendable per-user via `~/aios/agents.json`); only connect tools actually installed on the machine.
- **C** — make `AGENTS.md` inside the AIOS folder the single canonical, agent-neutral front door; `CLAUDE.md` shrinks to a one-line pointer at it. Every bridge file points at `AGENTS.md`.

Shipped in two releases:
- **Release 1 (shipped):** editable registry, connect-only-installed, `AGENTS.md` as canonical front door, `CLAUDE.md` thin pointer. Plus housekeeping.
- **Release 2 (shipped):** `skills/INDEX.md` — an auto-generated live skill list every agent can read and run (regenerated on `init`, `activate`, `skill add`, `skill remove`); `AGENTS.md` points at it. Plus a copy-paste line printed by `activate` and `doctor` for tools DotAIOS has never heard of.

The agent-agnostic pillar is now **delivered**: any agent — known, unknown, or switched-to mid-task — can read the folder, understand it, and run the installed skills.

> **Framing rule — do not let this drift.** `agents.json` is **Filippo's lever and a power-user escape hatch — never the user's job.** Our ICP is non-technical; hand-editing JSON is unsafe (a missing comma breaks it silently). The honest story: new AI tools are added by Filippo in shipped updates, and the user just re-runs `dotaios setup`. Never pitch "any user can add a tool by editing agents.json." If user-added tools ever become a real need, it must be a guided command (`dotaios agents add` asking plain questions), not hand-edited JSON.

## 4. After That — Smarter Memory Routing (investigate, do not start)

Today a dropped PDF/document always lands in `vault/raw` — it routes by file *type*, not by *purpose*. Goal: a dropped source should land on the right shelf (transient/operational note vs lasting reference) with minimal friction for a non-technical person. Marker already handles the file conversion; the gap is the "which shelf" decision. Investigate and propose only after the agent-agnostic work is shipped and approved.

## 5. Guardrails

- Stay narrow. No web app, no GUI framework, no multi-agent orchestration.
- Do not touch the frozen marketplace / license / installer code.
- Keep `npm test` and `npm run smoke` green.
- Filippo is the non-technical founder. Lead updates with user/business impact, not file names.
