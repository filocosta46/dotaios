# 03 — Output-pointer CLI and router return path

**What to build:** Expose the pointer store through explicit project-scoped preview/apply/list/resolve/remove commands and compose bounded pointer summaries into exact ready project routes. Complete the customer loop from one approved project-native action to a later fresh agent finding the result, without copying or indexing it.

**Blocked by:** 02 — Authoritative output-pointer store.

**Status:** ready-for-agent

**Requirements:** EPR-006, EPR-009, EPR-010, EPR-011, EPR-012, EPR-014, EPR-016, EPR-017.

**Cold context:** Route resolution remains read-only. Pointer mutation is a separate CLI authority and never enters MCP. The action approval may cover exactly one same-project pointer only when the pre-action explanation disclosed it; the CLI still uses preview/apply proof binding, but no artificial second customer approval is required for that unchanged plan.

**Likely seams:** add a thin output command under `packages/cli/src/commands/` and register it in the existing CLI dispatcher; add bounded pointer summaries only in `packages/core/src/intent-resolution.mjs`; exercise public CLI behavior in `tests/cli/` and preserve the closed MCP surface in `tests/mcp/server.test.mjs`; document the connect/action/result flow in `docs/projects.md`.

- [ ] Add project-scoped `output add`, `list`, `resolve`, and `remove` commands. Add/update/remove preview by default and apply only the identical operation ID and plan fingerprint; list/resolve are bounded and read-only.
- [ ] Add/apply accepts only a freshly verified exact project, declared kind, contained locator, and inert label. A changed project, kind, scope, target, label, store generation, or disclosed behavior invalidates the plan and requires preview again; a changed approval boundary requires fresh user approval.
- [ ] Exact idempotent add reports no collection change. Label update preserves pointer ID. Remove deletes only the record and works when the root is unavailable; snapshots prove targets and external repositories are untouched.
- [ ] Exact `ready` project routes include bounded pointer summaries from that project only. Candidate, ambiguous, refused, unsupported, Google-tool, working-context, search/index, and MCP envelopes contain no pointer data.
- [ ] Available results may disclose a recomputed contained absolute location only after exact project revalidation. Missing, unsafe, unavailable, or orphaned pointers withhold it and use the approved stale wording.
- [ ] The pre-action message says the match comes from customer registration rather than AIOS endorsement, names one action, and discloses the one constrained pointer. Completion says AIOS saved only the relative location and label and did not copy/index the result.
- [ ] A Career Ops-shaped fixture completes: match registered project, approve one evaluation without applying, re-resolve into a supported fresh context, create a contained report fixture, register its pointer under that approval, then find it from a later exact route. Production code contains no Career Ops identity or special case.
- [ ] An Agent-Reach-shaped `CLAUDE.md`-only fixture proves generic discovery without pretending Codex can execute it; a compatible host fixture proves the same generic route and pointer path without repo-specific logic.
- [ ] Existing Google, project registration, project-only memory, AIOS skill, budget, omission, location-refusal, and output-budget contract tests remain green.
