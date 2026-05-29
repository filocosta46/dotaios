# Onboarding light payoff — design spec

**Status:** approved 2026-05-29. Scope: minimal, additive. Branch `audit/overnight-2026-05-28`.

## Goal
End onboarding with a short, honest **reflective close** that proves the system heard the user — grounded only in what they just provided, claiming nothing it can't back up. Replaces the current "list features" ending as the emotional close. Keeps the team's existing "don't over-promise on thin memory" stance (`INSTALL.md` Step 5).

## Decision
Chosen direction: **minimal 3-Q + light payoff** (not richer capture, not two-track). Lowest risk, smallest change.

## Changes

### Change 1 — agent-led path: `INSTALL.md` Step 5 (docs only)
After the 3 answers, **before** the feature rundown, the agent gives a short reflective close adapted to the user's words:

> "Quick recap so you know it landed: you're **{name}**, working on **{work}**, and this week is really about **{priority}**. If I had to pick one thing to start on today, it'd be **{one concrete thing pulled from their priority}** — want me to take a first pass at it now?"

Instruction rules (baked into the step):
- Use **only** what they told you in the 3 answers.
- Pick **exactly one** thing. If you genuinely can't infer one, ask *"what's the first step?"* — do not invent.
- **No** capability over-claims ("I can run your week"). It's a reflection + one grounded suggestion.
- Then continue to the existing "here's what you now have" rundown (unchanged).

### Change 2 — human path: `dotaios interview` (small code)
`setup` does **not** collect an interview (context stays placeholder there) → **no change to `setup`**. Only `interview` collects work/priorities, so the recap lives there.

After a successful write, print a recap built from the merged context, then a single handoff line (the CLI can't reason to pick "one thing" — the agent can):

```
Here's what I've got: {name}, {role} — working on {first line of work}.
This week: {first line of priorities}.
Open your AI agent and ask: "Based on my context, what's the one thing to focus on today?"
```

Implementation: a pure exported helper `renderInterviewRecap({ name, role, work, priorities })` → string | null.
- Omits missing pieces gracefully (no leading commas, no empty labels).
- Uses the **first non-empty line** of multi-line work/priorities (recap, not a dump).
- Returns `null` when there's no role/work/priorities to reflect → caller prints nothing.
- Called at the end of `interviewCommand` on the write-completion path only (not on the early "nothing changed" / cancelled-review paths).

## Testing
`tests/cli/interview.test.mjs`: `renderInterviewRecap` — (1) full input includes name/role/work/priorities + the handoff line; (2) missing name degrades cleanly (no leading comma); (3) all-empty → `null`; (4) multi-line work/priorities → only first line used.

## Out of scope (parked — separate tracks)
Richer capture / voice samples; long-term-memory & indexing upgrade (semantic guardrail fork — needs founder decision); integration/plugin/user-skill robustness verification; the cold-machine "do agents faithfully follow INSTALL.md" test.

## Acceptance
`npm test` + `npm run smoke` green; `INSTALL.md` Step 5 reads as above; running `dotaios interview` with answers prints the recap; `--yes`/non-interactive and `setup` unchanged.
