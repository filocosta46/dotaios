---
title: Universal Project Folder Router - Plan
type: feat
date: 2026-08-30
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Universal Project Folder Router - Plan

## Goal Capsule

- **Objective:** A customer can connect an existing remote-backed Git project once, ask an agent where a concrete task belongs, approve one explained match, and continue in the same visible task while a fresh customer-hidden native context runs at the verified folder when the host supports an observed project convention.
- **Means:** Reuse the existing project registry as the only identity authority, add a path-free approval binding, and keep the host handoff behind the existing read-only resolver (KTD1-KTD4).
- **Authority:** GitHub `main` and the single launch PR define shipped behavior. The customer-approved registration record defines project identity. The direct approval defines one action. The host's native context mechanism owns post-approval instruction loading.
- **Execution profile:** One branch, one PR, test-first changes, and no release or merge action.
- **Stop conditions:** Stop on path disclosure or external content ingestion before approved native entry, a changed folder or action crossing approval, a weak or ambiguous route, any Google/gws behavior change, or a native-entry claim without live evidence.
- **Tail ownership:** The implementation run owns review fixes, the PR, and CI. The owner retains the merge and release decision.

---

## Product Contract

### Summary

Ship the smallest generic route from concrete task text to one customer-registered, remote-backed project folder. Discovery remains path-free and inert. Exact folder disclosure and native host entry occur only after one approval that is bound to the same action, explained match, registered mapping, and physical project identity. A successful connection does not promise native entry on a host that supports none of the project's observed conventions.

### Problem Frame

The current branch can match and exact-resolve registered projects, but its discovery result is not bound to the later exact request. A project mapping or the action text can change between explanation and approval while retaining the same public handle. The current proof also demonstrates routing and native Codex entry as separate events rather than one approved customer journey.

### Key Decisions

- **Use registration metadata plus inert convention presence as the universal route.** (session-settled: user-directed — chosen over curated project identities and capability catalogs: customers should connect their own repositories without product-specific branches.) Governs R1, R2, R9.
- **Require one path-free explanation and direct approval before exact folder disclosure.** (session-settled: user-directed — chosen over eager path disclosure or external instruction reads: the customer must understand and approve one action before the host enters a project.) Governs R2-R5.
- **Keep `packages/core/src/projects.mjs` as the only project identity authority.** (session-settled: user-directed — chosen over a parallel routing catalog or state layer: registration, mapping, and repository ownership already have one product owner.) Governs R1-R4.
- **Defer output pointers and all repository-marketplace behavior.** (session-settled: user-directed — chosen over implementing tickets 02/03 or a broader external-project platform: neither is required for tomorrow's truthful folder router.) Governs R10.
- **Preserve Google/gws routing unchanged.** (session-settled: user-directed — chosen over unifying product-owned tools with project-native routing: the launch must not disturb the existing Google contract.) Governs R8.

### Requirements

**Connection and discovery**

- R1. The existing preview/apply `project add` flow connects any already-present Git repository with a canonical live remote and customer-approved purpose. It creates no curated project or capability identity. Local-only repositories without a canonical remote remain outside this launch.
- R2. An implicit request takes customer-hidden host-native support and returns at most one compatible verified active project from bounded registration frontmatter, authoritative local Git remote agreement, and contained convention-file presence. It returns no path, reads no README body or convention body, and requests no approval for weak, tied, vague, ambiguous, or unsupported task routes. Weak or vague requests ask for a concrete action; tied or ambiguous matches ask the customer to narrow the action; unsupported hosts advise using a supported host or manually attaching a known project, without disclosing a route.
- R3. A candidate includes a path-free approval binding over the normalized concrete action, normalized sorted host-native support, stable project ID, canonical registered mapping path, registered root identity, authoritative live remote, sorted observed convention identities, every bounded public registration field used for matching or explanation, and the emitted match reason. The binding exposes none of those private observations beyond the already-approved public registration metadata.

**Approval and native entry**

- R4. The managed host must call exact native resolution only after fresh direct approval. Exact resolution requires the candidate binding and identical concrete action, then recomputes the binding from one fresh project observation. It returns a path-free refusal when the action, explanation basis, mapping, remote, root identity, convention identity, or declared host support changed. The resolver's stateless binding proves continuity of the proposal; it does not prove that a person approved or make the route single-use.
- R5. After R4 succeeds, the host may disclose the folder and start one fresh customer-hidden native child context rooted at that exact folder, returning its bounded outcome to the same user-visible task, only when it supports an observed convention. The child receives higher-priority host authority and the customer-approved proposal, but no prior project-root instructions, project-only memory, governing skill, working-directory binding, or project-scoped tool state. Project-native content is never route approval or product authority. The host's native hierarchy and sandbox must stop credential access, software installation, out-of-project writes, external submission, or any other unapproved expansion; the router does not claim independent semantic enforcement of project instructions.
- R6. The customer sees the project match, reason, proposed action, approval request, and outcome. Any response other than fresh direct approval ends the route without exact resolution, folder disclosure, or native entry. The customer never chooses convention identifiers, copies approval tokens, or manages host protocol.

**Trust, compatibility, and proof**

- R7. Discovery and exact resolution perform no writes, network access, credential access, external-repository content ingestion, or command execution except bounded read-only local Git metadata inspection.
- R8. Existing Google/gws selection, arguments, outputs, omissions, refusal behavior, and tests remain unchanged. Project-native fields do not enter an explicit tool request.
- R9. Two ordinary fixture repositories traverse the same code. Fixture names, remotes, purposes, and convention combinations do not appear in shipped routing branches.
- R10. The launch adds no catalog, capability ID, recommendation list, marketplace, installer, updater, hosted gateway, credential broker, per-agent core branch, MCP surface, or durable output pointer.

### Key Flows

- F1. Connect an existing folder
  - **Trigger:** The desired repository is not registered.
  - **Actors:** Customer, DotAIOS CLI.
  - **Steps:** Preview the existing `project add` operation; explain the exact registration change; apply only after direct approval.
  - **Outcome:** One portable registration record and one verified machine-local mapping exist under the existing project authority.
  - **Covered by:** R1.
- F2. Discover and approve one task route
  - **Trigger:** An agent receives one concrete task without an exact project selector.
  - **Actors:** Customer, CLI-capable host, DotAIOS resolver.
  - **Steps:** Derive the current host's native support; resolve a compatible path-free candidate; explain the metadata-only match and one action; wait for a fresh direct approval; preserve the returned binding internally. A denial, cancellation, weak task, ambiguous match, or unsupported host ends path-free and does not ask again automatically.
  - **Outcome:** After approval, the host holds continuity evidence for exactly what project identity, explanation, and action it proposed, without learning a folder path.
  - **Covered by:** R2, R3, R6.
- F3. Enter the approved project
  - **Trigger:** The customer approves the exact F2 proposal.
  - **Actors:** CLI-capable host, DotAIOS resolver, native project context.
  - **Steps:** Exact-resolve with the candidate binding and the same host-native support; refuse any changed observation; start a fresh customer-hidden native child at the returned root and return its bounded outcome to the same visible task; let the child load only its natively supported project convention under higher-priority host authority. If native startup fails after exact success, report the failure and offer manual opening of only the already-approved exact folder without claiming native entry.
  - **Outcome:** The approved action begins in the same visible task and verified folder, within its approved bounds, or does not begin.
  - **Covered by:** R4-R7.

### Acceptance Examples

- AE1. Covers F2 / R2-R3. Given two connected repositories with different purposes, natural concrete task wording that clearly overlaps only one approved purpose without copying its purpose sentence returns one path-free candidate and one approval binding.
- AE2. Covers F2 / R2. Given a vague task, a current directory inside a registered project, or two similarly relevant purposes, discovery returns no location and no approval request. It asks for a concrete action when weak, asks the customer to narrow the action when tied, and gives path-free compatibility guidance when the host is unsupported.
- AE3. Covers F3 / R4. Given an approved candidate for folder A, changing the stable-ID mapping to equivalent-looking folder B, or renaming the same physical root and updating the mapping, before exact resolution returns a path-free refusal.
- AE4. Covers F3 / R4. Given an approved candidate, changing the action text before exact resolution returns a path-free refusal and requires a new explanation and approval.
- AE5. Covers F3 / R5. Given a Codex-supported convention, the exact route becomes the root of a fresh ephemeral Codex child and its unique project-native marker is returned to the same visible task without creating another visible task. A prior project's unique marker, memory, governing skill, working-directory binding, and project-scoped tool state are absent. A `CLAUDE.md`-only fixture remains path-free for Codex. In a read-only proof, a convention that requests credentials, installation, an out-of-project write, external submission, or a different action produces no prohibited effect.
- AE6. Covers R3-R4, R7, R9. Across discovery, refusal, and exact resolution, guarded file APIs observe no external body reads, mutation APIs observe no writes, Git inspection stays local and read-only, and shipped source contains no fixture identity. Changing any match-bearing registration field or emitted reason invalidates the binding and refuses without a path.
- AE7. Covers R8. Existing Google/gws contract tests and byte fixtures match `dfec7669de3630c178ac78130b1a38492383b319` without edits.

### Success Criteria

- One black-box journey connects two repositories through the same command, routes one concrete task, refuses weak, ambiguous, denied, and unsupported routes, binds one approval to the same folder, explanation, action, and host support, exact-resolves it, and returns a fresh host-native child outcome to the same visible task without stale project context.
- The exact branch diff is smaller and has fewer identity owners and repeated observations than commit `081a51a01fc08cc01a3203450bc7a59d1e9a2ae4` unless retained code is justified by an acceptance example.
- Focused tests, the customer black-box proof, the full suite, smoke, syntax, package checks, independent review, and PR CI all pass.

### Scope Boundaries

**In this launch**

- Remote-backed project registration, deterministic metadata task matching, path-free approval binding, exact same-folder resolution, same-task host-native handoff, customer documentation, and black-box proof.

**Deferred to Follow-Up Work**

- Output-pointer store and CLI return-path tickets preserved at commit `081a51a01fc08cc01a3203450bc7a59d1e9a2ae4`, outside the launch diff.
- Durable learning capture for the final router pattern.

**Outside this product's identity**

- Repository catalogs, recommendations, marketplaces, installation or update management, hosted gateways, credential brokerage, per-agent core implementations, and MCP expansion.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One metadata authority in `projects.mjs`.** Consolidate the new bounded frontmatter projection with the existing project-record pipeline so routing receives verified registration records and never parses project records or machine-local state. (session-settled: user-directed — chosen over a routing-owned catalog or duplicate project parser: the existing project registry must remain the sole identity authority.) Covers R1-R4.
- KTD2. **A stateless approval binding enforces continuity.** Compute a versioned, domain-separated SHA-256 digest over stable canonical JSON with explicit fields for the normalized action, normalized sorted host-native support, stable project ID, canonical registered mapping path, root identity, canonical live remote, sorted convention identities, match-bearing public registration projection, and emitted reason. Return only the opaque digest on the candidate. Exact routing recomputes and compares it before disclosing a path. The digest is continuity evidence, not proof of approval, a bearer capability, or a replay defense. Covers R3-R4.
- KTD3. **One fresh observation per router call.** Remove duplicate internal registration, remote, and convention passes. The implicit call creates the binding; the post-approval exact call performs one new bounded observation and compares it. The composing intent resolver does not add another router call after exact verification. Covers R2, R4, R7.
- KTD4. **The global bridge carries customer-hidden host protocol.** The bridge derives its host's native convention support, supplies it during discovery and exact resolution, explains the candidate, retains the binding, and exact-resolves only after fresh approval. Support declaration is a compatibility guard between trusted local components, not an authentication boundary; a local caller that can forge it can already read the same local folder. Help and customer docs omit the binding and convention flags. (session-settled: user-directed — chosen over customer-managed convention identifiers or per-agent core branches: the host already knows its native project mechanism and the customer should only approve the action.) Covers R5-R6, R10.
- KTD5. **Explicit tools keep the pre-router composition.** Branch before project-native routing when `--tool` is present. Preserve the main-branch Google/gws bytes and avoid adding `project_route` to that envelope. (session-settled: user-directed — chosen over a unified project/tool envelope: tomorrow's router must not alter the existing Google contract.) Covers R8.

### High-Level Technical Design

```mermaid
sequenceDiagram
  participant C as Customer
  participant H as CLI-capable host
  participant D as DotAIOS resolver
  participant P as Existing project authority
  participant N as Native project context
  H->>D: Concrete task, no selector, native support
  D->>P: Bounded metadata and local verification
  P-->>D: One verified record
  alt compatible candidate
    D-->>H: Path-free candidate and approval binding
    H-->>C: Match reason and one proposed action
    alt fresh direct approval
      C->>H: Approve exact proposal
      H->>D: Same task, exact project, binding, native support
      D->>P: One fresh bounded verification
      alt binding and support still match
        D-->>H: Exact verified folder
        H->>N: Start fresh hidden child at exact folder
        N-->>H: Bounded outcome to same visible task
      else observation or support changed
        D-->>H: Path-free refusal
      end
    else denial, cancellation, or anything else
      H-->>C: Path-free cancellation
    end
  else incompatible, weak, or ambiguous
    D-->>H: Path-free guidance; no approval
  end
```

| Exact request condition | Result |
| --- | --- |
| Binding absent | Approval-required refusal; no route |
| Action differs | Changed-approval refusal; no route |
| Explanation, root, mapping, remote, or convention differs | Identity-changed refusal; no route |
| No native convention overlap | Unsupported-host refusal; no route |
| Binding and native support match | Advisory exact route and fresh-context requirement |

### Assumptions

- The approval binding does not need secrecy. Its purpose is deterministic continuity checking against fresh local evidence; the trusted managed host owns the direct-approval ceremony.
- Action equality uses one bounded canonical text form. Semantic rewriting is not accepted across the approval boundary.
- Task selection is deterministic lexical matching against the customer-approved purpose, not semantic inference. Customer copy and examples promise a clear concrete match, not synonym-level understanding.
- Remote-free Git repositories and hosts without a supported observed convention remain connect-or-enter limitations for this launch and are stated plainly.
- CI can prove the composed handoff command and exact root with an injected or dry-run client launcher. A sanitized live Codex receipt is still required before the PR is declared launch-ready.
- No external research is load-bearing because the implementation reuses established local project, resolver, bridge, and native-probe surfaces without adding an external API or dependency.

### System-Wide Impact

- Activation refreshes the shared managed bridge for supported local hosts, but the managed body remains one universal protocol rather than per-agent product logic.
- Project-only memory and AIOS skill composition stay unavailable during implicit discovery. They may load only after bound exact resolution.
- Existing explicit Google tool calls remain on their current branch and public envelope.
- External repositories retain their own Git history, code, data, outputs, and ownership. DotAIOS records no external content.

### Risks & Dependencies

- **Approval drift:** A token that omits the action or physical root would preserve the current truth gap. AE3 and AE4 are blocking proof.
- **False no-read proof:** Named canaries alone can miss unrelated reads. The black-box guard must cover every content-open surface beneath fixture roots.
- **Transient writes:** Before/after snapshots alone can miss write-then-rollback behavior. Mutation APIs and subprocesses must be denied during routing.
- **Compatibility drift:** Shared intent-envelope refactoring can change Google bytes. KTD5 and AE7 prohibit that path.
- **Proof overreach:** Core returns a route; the host starts a context. The live receipt must bind those two facts before documentation claims native entry.
- **Launch-time race:** A local root can change after exact verification and before native startup. The host must start immediately, verify the resulting root in its receipt, and never describe this as atomic filesystem authorization.

### Sources / Research

- Commit `081a51a01fc08cc01a3203450bc7a59d1e9a2ae4` preserves the earlier external-project-routing design, review, and deferred-ticket evidence outside the launch diff.
- `packages/core/src/projects.mjs`, `packages/core/src/project-native-routing.mjs`, and `packages/core/src/intent-resolution.mjs` show the current authority split and redundant observations.
- `packages/core/src/bridges.mjs` is the existing universal agent instruction surface.
- `tests/cli/project-native-routing-blackbox.test.mjs`, `tests/cli/induction_black_box.test.mjs`, and `packages/cli/src/lib/skill-invocation-probe.mjs` are the current split proof surfaces to compose.
- No applicable `docs/solutions/` corpus or `CONCEPTS.md` exists in this repository.

---

## Implementation Units

### U1. Consolidate project authority and bind approval

- **Goal:** Produce one verified metadata projection and one path-free candidate binding without duplicate project ownership or weak current-directory routing.
- **Requirements:** R1-R4, R7; KTD1-KTD3.
- **Dependencies:** None.
- **Files:** `packages/core/src/projects.mjs`, `packages/core/src/project-native-routing.mjs`, `tests/core/project-native-routing.test.mjs`.
- **Approach:**
  1. Consolidate frontmatter-only registration reads with the existing project record and mapping validation rules.
  2. Remove current-directory bypass and substring-only display-name selection. Keep the existing lexical scorer, minimum magnitude, and separation behavior.
  3. Create the versioned canonical path-free approval binding from the action, mapping path, explanation basis, and verified internal observations using the repository's stable-JSON SHA-256 pattern.
  4. Make exact routing require and recompute that binding from one fresh observation.
  5. Remove tests that pin redundant internal read counts. Retain tests that pin path-free observable refusal.
- **Execution note:** Start with failing continuity, vague-task, and no-body-read tests before simplifying the implementation.
- **Patterns to follow:** Existing bounded frontmatter readers and project mapping verification in `packages/core/src/projects.mjs`; lexical scoring in `packages/core/src/skill-resolver.mjs`; contained metadata inspection in `packages/core/src/contained-read.mjs`.
- **Test scenarios:**
  - Covers AE1. Two verified registrations with distinct purposes produce one candidate and no location for a task that clearly matches one purpose.
  - Covers AE2. A vague task inside a registered current directory produces no candidate.
  - Covers AE2. Equal or weak metadata overlap returns ambiguity or no match without a location.
  - Covers AE3. Mapping the approved stable ID to an equivalent-looking different root, or renaming the same physical root and updating its mapping, makes exact resolution refuse without a path.
  - Covers AE4. Changing the action after candidate creation makes exact resolution refuse without a path.
  - Changing the normalized host-support declaration makes exact resolution refuse without a path even when both old and new declarations overlap an observed convention.
  - Replacing the remote, any match-bearing registration value, the emitted reason, or any convention file between candidate and exact resolution makes exact resolution refuse without a path.
  - Reordered observations produce the same binding, while ambiguous field boundaries cannot collide.
  - Registration README bodies and external convention bodies are never opened during either call.
- **Verification:** Routing owns only matching, local Git verification, convention presence, and binding comparison. Project identity parsing and mapping remain in `projects.mjs`.

### U2. Compose the bound route without changing Google

- **Goal:** Expose the two-step bound route through the thin resolver CLI while preserving the explicit-tool contract exactly.
- **Requirements:** R3-R8; KTD2-KTD5.
- **Dependencies:** U1.
- **Files:** `packages/core/src/intent-resolution.mjs`, `packages/cli/src/commands/resolve.mjs`, `tests/core/intent-resolution.test.mjs`, `tests/cli/resolve.test.mjs`, `tests/core/connection-tool-resolver.test.mjs`, `tests/cli/google.test.mjs`.
- **Approach:**
  1. Return only host-compatible implicit candidates before project memory, AIOS skill, connection inspection, or location composition.
  2. Accept customer-hidden binding and host-support inputs for an exact native request without documenting them as customer choices; treat host support as a trusted compatibility hint, not an access-control claim.
  3. Compose project memory and governing skill only after bound exact verification.
  4. Return `fresh_context_required` after exact success and keep core advisory.
  5. Keep explicit tool requests on the main-branch envelope and code path.
- **Execution note:** Characterize the `dfec766` explicit-tool bytes before changing the shared intent resolver.
- **Patterns to follow:** Early authority branches and bounded refusal rendering in `packages/core/src/intent-resolution.mjs`; thin option forwarding in `packages/cli/src/commands/resolve.mjs`.
- **Test scenarios:**
  - An implicit candidate includes the opaque binding but no project memory, AIOS skill, tool, or location; unsupported host support receives a path-free refusal before approval.
  - A bound exact request returns project-only context and the verified route only after final identity comparison.
  - A missing, malformed, stale, or action-mismatched binding returns a path-free refusal within every supported output budget.
  - A host with no supported convention returns `unsupported_by_host` without location disclosure.
  - Covers AE7. Successful, refused, and compact-budget explicit Google requests match the main-branch serialized contract, argv, omissions, exit behavior, and gws interaction bytes.
- **Verification:** Native routing is additive only when no explicit tool is requested. Existing Google/gws test files remain byte-identical unless a new separate regression fixture is required.

### U3. Teach one customer-hidden host handoff

- **Goal:** Let any CLI-capable agent discover without asking the customer to manage protocol; only a compatible candidate proceeds to explanation, approval, exact resolution, and a fresh customer-hidden native child, while every unsupported route stops with bounded path-free guidance before approval.
- **Requirements:** R1-R6, R10; KTD4.
- **Dependencies:** U2.
- **Files:** `packages/core/src/bridges.mjs`, `docs/projects.md`, `tests/core/bridges.test.mjs`, `tests/core/managed-bridge-plan.test.mjs`, `tests/core/public-contract.test.mjs`, `tests/cli/activate.test.mjs`.
- **Approach:**
  1. Replace the existing managed bridge's exact-selector resolve flow with implicit discovery when no attached registered project already owns the task.
  2. Instruct the host to derive its native support, retain the opaque binding, propose one concrete action, wait for a fresh direct approval, and exact-resolve only after approval. Any other response ends the attempt without an automatic reprompt.
  3. Require a fresh ephemeral project-root child whose bounded outcome returns to the same user-visible task after exact success. Carry only higher-priority host authority and the approved proposal, and prove that prior project instructions, memory, skill, working directory, and project-scoped tool state are absent. An unsupported host stops path-free with supported-host or manual-attach guidance; a native-launch failure after exact success may guide manual opening of only the already-approved folder and must not claim native entry.
  4. State that project-native instructions provide no approval or product authority. Exercise sensitive expansion attempts under a read-only sandbox, and rely honestly on the host's native hierarchy and sandbox rather than claiming router-level semantic enforcement.
  5. Apply the prior four-file cleanup that removes convention identifiers from customer help and documentation where it still matches this contract.
- **Patterns to follow:** The single shared managed block and captured executable/argv object in `packages/core/src/bridges.mjs`; existing preview/apply project connection copy in `docs/projects.md`.
- **Test scenarios:**
  - A generated bridge contains one universal discovery-to-approval flow and no project catalog, capability, installer, output-pointer, or per-agent branch.
  - Customer-facing help and docs contain no convention-support or approval-binding option.
  - The host proposal names the matched slug, metadata-only reason, exact action, approval boundary, and fresh-context outcome without a path.
  - Denial or cancellation ends path-free. An unsupported host gets supported-host or manual-attach guidance and no route. A post-approval launch failure mentions only the approved route and never claims success.
  - The hidden child contains the new project's marker and none of the prior project's instruction, memory, skill, working-directory, or tool-state markers.
  - Project-native instructions provide no route approval; the read-only proof observes no effect from credential, installation, out-of-project write, external-submission, or action-expansion requests.
- **Verification:** A non-technical customer approves the action once. The bridge, not the customer, manages exact selector, binding, and native convention support.

### U4. Compose the launch proof

- **Goal:** Prove the full customer journey and preserve the proof as deterministic CI coverage plus one sanitized live native receipt.
- **Requirements:** R1-R10; AE1-AE7.
- **Dependencies:** U1-U3.
- **Files:** `tests/cli/project-native-routing-blackbox.test.mjs`, `tests/cli/induction_black_box.test.mjs`, `packages/cli/src/lib/skill-invocation-probe.mjs`, `docs/probes/2026-08-30-codex-project-native-invocation.json`, `tests/core/public-contract.test.mjs`.
- **Approach:**
  1. Connect two generic fixture repositories through the same preview/apply command.
  2. Drive candidate, explanation evidence, denial, approval binding, exact same-folder resolution, unsupported-host refusal, a customer-hidden ephemeral host launch returning to the same visible task, prior-context isolation, and sandboxed project-instruction behavior from one black-box scenario.
  3. Guard all external content-open and mutation surfaces, deny network, allow only local read-only Git metadata commands, and retain before/after snapshots.
  4. Bind the host launch root to the exact resolver location in CI with a controlled launcher.
  5. Run the same root through the live Codex probe and update the bounded receipt only when it produces the project-native marker.
  6. Before the PR, audit `origin/main...HEAD`, assign every retained file to R1-R10 or AE1-AE7, and restore every unassigned or deferred artifact to its main-branch state while preserving it in prior Git history.
- **Current diff disposition:**

  | Path | PR disposition | Contract trace |
  | --- | --- | --- |
  | `CONTEXT.md` | Restore to `main`; it contains deferred output-pointer vocabulary | R10 |
  | `docs/client-support.md` | Keep and update the bounded native receipt claim | R5, AE5 |
  | `docs/external-capability-routing/design.md` | Restore to `main`; prior design remains in Git history | R10 |
  | `docs/external-project-routing/reviews.md` | Restore to `main`; cite commit-qualified history only | R10 |
  | `docs/external-project-routing/spec.md` | Restore to `main`; cite commit-qualified history only | R10 |
  | `docs/external-project-routing/tickets/01-generic-project-native-routing.md` | Restore to `main`; the unified plan owns launch execution | R10 |
  | `docs/external-project-routing/tickets/02-authoritative-output-pointer-store.md` | Restore to `main`; deferred output-pointer work | R10 |
  | `docs/external-project-routing/tickets/03-output-pointer-cli-return-path.md` | Restore to `main`; deferred output-pointer work | R10 |
  | `docs/plans/2026-08-30-1821-feat-universal-project-router-plan.md` | Keep as the launch contract | R1-R10, AE1-AE7 |
  | `docs/probes/2026-08-30-codex-project-native-invocation.json` | Keep only after the refreshed bounded proof passes | R5, AE5 |
  | `docs/projects.md` | Keep; hide protocol and document customer outcomes | R1-R2, R5-R6 |
  | `packages/cli/src/commands/resolve.mjs` | Keep the thin customer-hidden route inputs | R2-R4, R8 |
  | `packages/core/src/external-project-capability-resolver.mjs` | Keep deletion of the curated predecessor | R9-R10 |
  | `packages/core/src/intent-resolution.mjs` | Keep the bound route and unchanged explicit-tool branch | R2-R8 |
  | `packages/core/src/project-native-routing.mjs` | Keep the generic router | R2-R5, R7-R9 |
  | `packages/core/src/projects.mjs` | Keep the consolidated identity projection | R1-R4, R7 |
  | `tests/cli/induction_black_box.test.mjs` | Keep the packed approved-route journey | R1-R6 |
  | `tests/cli/project-native-routing-blackbox.test.mjs` | Keep the composed customer proof | AE1-AE6 |
  | `tests/cli/resolve.test.mjs` | Keep the thin CLI contract proof | R2-R8 |
  | `tests/core/external-project-capability-resolver.test.mjs` | Keep deletion with its curated predecessor | R9-R10 |
  | `tests/core/intent-resolution.test.mjs` | Keep composition and Google isolation proof | R3-R8 |
  | `tests/core/project-native-routing.test.mjs` | Keep routing and continuity proof | AE1-AE6 |
  | `tests/core/public-contract.test.mjs` | Keep the no-protocol and no-fixture public contract | R6, R9-R10 |
- **Execution note:** Treat the real customer black box as the acceptance test; unit tests support it but cannot replace it.
- **Patterns to follow:** Existing read guard and tree snapshots in `tests/cli/project-native-routing-blackbox.test.mjs`; packed artifact induction in `tests/cli/induction_black_box.test.mjs`; bounded redacted receipts in `packages/cli/src/lib/skill-invocation-probe.mjs`.
- **Test scenarios:**
  - Covers AE1. One concrete task chooses the correct fixture without a curated identity or shipped fixture literal.
  - Covers AE2. Vague and ambiguous tasks return no route even when run inside a fixture folder.
  - Covers AE3-AE4. Folder or action drift between discovery and exact request refuses without path disclosure.
  - Covers AE5. The controlled ephemeral Codex launch uses the exact returned root and returns the native marker to the same visible task without a prior-project marker or a new visible task; the incompatible fixture remains path-free; sandboxed expansion attempts produce no prohibited effect.
  - Covers AE6. No external content is opened before native entry, no routing write occurs even transiently, no network call occurs, and every Git subprocess is read-only and local. Changing a match-bearing registration field or emitted reason between discovery and exact resolution refuses without a path.
  - Covers AE7. The unchanged Google/gws regressions pass against the launch tip.
- **Verification:** The black-box proof is generic, offline during routing, path-free before approval, and linked to the live host receipt.

---

## Verification Contract

| Gate | Command or evidence | Done signal |
| --- | --- | --- |
| Focused core | `node --test tests/core/project-native-routing.test.mjs tests/core/intent-resolution.test.mjs tests/core/bridges.test.mjs tests/core/managed-bridge-plan.test.mjs` | Approval continuity, one project authority, bridge flow, and path-free refusals pass. |
| Focused CLI | `node --test tests/cli/resolve.test.mjs tests/cli/project-native-routing-blackbox.test.mjs tests/cli/induction_black_box.test.mjs tests/cli/activate.test.mjs` | The customer journey and packed artifact pass. |
| Google/gws regression | `node --test tests/core/connection-tool-resolver.test.mjs tests/cli/google.test.mjs` plus unchanged existing gws tests | Existing routing bytes, argv, output, and exit behavior match main. |
| Public contract | `node --test tests/core/public-contract.test.mjs` | No fixture identity, customer protocol, or out-of-scope product surface ships. |
| Full suite | `npm test` | All repository tests pass. |
| Product checks | `npm run syntax-check`, `npm run smoke`, `npm run check`, `npm run pack:check` | Syntax, runtime smoke, CLI package, and packed admission checks pass. |
| Live native proof | Bounded ephemeral Codex invocation receipt tied to the exact black-box route root and returned to the same visible task | `configured`, `discoverable`, `invoked`, and `produced` are `yes`; marker and path are redacted; invocation mode is ephemeral and no second user-visible task is created. |
| Independent review | Diff-scoped review against this plan and `origin/main` | No launch-blocking finding remains; applied fixes are committed. |
| Pull request | GitHub checks for the single PR | CI reaches a green decided state before owner handoff. |

---

## Definition of Done

- R1-R10 and AE1-AE7 are satisfied by observable black-box evidence.
- U1-U4 pass their focused tests and verification outcomes.
- The final diff has one project identity authority, no redundant exact observation loop, no weak current-directory bypass, no customer-visible host protocol, and no file outside the launch requirements or acceptance examples.
- The exact branch tip passes the full test suite, smoke, syntax, package admission, and independent review.
- One pushed branch has one open PR against `main`, and all required CI checks are green.
- The PR body records any honest residual limitation. Output pointers remain explicitly deferred.
- No abandoned experiment, dead-end abstraction, fixture-specific production branch, unrelated change, or uncommitted review fix remains.
- Nothing is merged, published, tagged, released, or deleted. The owner receives the exact merge and release decision.
