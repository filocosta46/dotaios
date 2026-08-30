# 01 — Generic project-native routing

**What to build:** Replace the curated external-capability gate with one customer-first, read-only route from ordinary task text to a verified registered project. Discovery may identify at most one project from validated customer registration metadata and inert convention presence; exact selection returns a freshly revalidated advisory route only when the calling host supports an observed convention.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Requirements:** EPR-001, EPR-002, EPR-003, EPR-004, EPR-005, EPR-012, EPR-013, EPR-014, EPR-015.

**Cold context:** `origin/main` at `dfec7669de3630c178ac78130b1a38492383b319` contains an isolated curated Career Ops resolver from PR #126 but no merged CLI composition. The local `codex/task-2-external-capability-routing` branch is superseded and must remain read-only. Reuse only its high-seam testing lessons: live-root/remote rechecks, contained-file metadata observation, path-free race refusals, no-content canaries, and filesystem snapshots. Do not carry forward its catalog, capability card, `--capability` selector, or repository-specific prose.

**Likely seams:** replace or retire `packages/core/src/external-project-capability-resolver.mjs`; compose through `packages/core/src/intent-resolution.mjs` and the existing resolve CLI; reuse bounded project identity/frontmatter helpers from `packages/core/src/projects.mjs`; extend core/CLI resolver tests and `docs/projects.md`. Keep the generic module deep and the CLI thin.

- [ ] Ordinary task text can identify one uniquely relevant active registered project using only exact/lexical matches against bounded validated frontmatter, with the required `0.67` separation; implicit discovery returns no location and never falls back to README body text.
- [ ] Eligibility revalidates root identity and uses live `origin` as the authoritative fetch remote, or exactly one safe non-`origin` fetch remote when `origin` is absent; zero, unsafe, conflicting, or multiple fallback remotes yield no route.
- [ ] Exact slug or stable-ID selection returns one advisory project-native route only after root identity, stored/live canonical remote, convention presence, and declared host support revalidate. Exact missing conventions refuse as `project_not_routable`; implicit absence is `no_match`.
- [ ] Convention discovery recognizes only contained regular `AGENTS.md`, `CLAUDE.md`, and `.agents/skills/*/SKILL.md` resources, stable-sorts them, observes no more than the specified bound, and never reads their bodies.
- [ ] Registration is reported as `registered-user-owned`, effect stays `unknown`, and the result contains no external outcome claim, command, argv, environment, credential, or parsed file content.
- [ ] Implicit discovery enforces the specified 32-project, eight-Git-observation concurrency, 64-KiB metadata, and 66-convention-per-project bounds; overflow returns path-free `discovery_bound_exceeded` and requests an exact handle.
- [ ] Ambiguous handles or intent, weak matches, unsafe/missing conventions, forged mappings, and root/remote/file replacement produce no route; identity failures are path-free.
- [ ] The host-facing next action explains one concrete action, the direct approval, immediate exact re-resolution, and the requirement to start a fresh context rooted at the verified project. A simple directory change inside the current run is not represented as sufficient.
- [ ] Host support is adapter-declared. Codex accepts `AGENTS.md` and repository skills, refuses a `CLAUDE.md`-only fixture as `unsupported_by_host`, and provides manual-open recovery without disclosing a route.
- [ ] The composition matrix is literal-tested: implicit candidate/ambiguity does not evaluate project memory or AIOS skill; exact ready does; AIOS skill `no_match` does not suppress the route; exact refusal has no location.
- [ ] Explicit existing `--tool` requests return `project_route: not_evaluated` with `tool_selector_precedence`; existing Google fields, argv, omissions, location, and next-action behavior pass byte-for-byte contract tests.
- [ ] Career Ops and Agent-Reach fixtures both pass through the same generic resolver, while shipped core/CLI source contains neither repository identity nor a curated project list.
- [ ] Black-box tests prove resolution is read-only, bounded, offline except for the existing local Git inspection, and does not read convention or project data canaries.
- [ ] Customer documentation says to keep a repository wherever it is and connect its folder once through the existing preview/apply `dotaios project add <folder> --purpose <purpose>` flow, uses “match” rather than endorsement language, gives an exact-registration recovery on no match, uses the approved first-action wording, and never tells customers to download a particular repository.
