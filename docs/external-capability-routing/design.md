# External Capability Routing

> **Status:** Proposed for review

## 1. Executive summary

Today DotAIOS can connect a project, share its context and skills, and recommend a small set of product-owned Google tools. It cannot tell an agent that an externally maintained system such as Career Ops already exists on the customer's Mac and is the right place to handle a task. The customer and every new agent must rediscover that system by hand.

This change adds one narrow routing path for externally owned project systems. A customer can ask for a job evaluation in ordinary language. DotAIOS recognizes a verified Career Ops checkout, explains what it is and where it lives, and requires an exact capability selection before returning its project-native entrypoint. Career Ops keeps owning its code, updates, personal data, and output. The main downside is that this first version recognizes curated existing projects only. It does not install external software or provide a marketplace.

## 2. Context and scope

PR #125 introduces `dotaios resolve`. It composes one verified project, bounded project context, a governing skill, an optional product-owned read-only Google tool, omissions, and approval state. Its tool table is closed and Google-specific.

The new behavior extends that recommendation envelope without turning DotAIOS into an execution gateway. The first supported external system is [`santifer/career-ops`](https://github.com/santifer/career-ops), an MIT-licensed project that keeps its workflow instructions and customer outputs inside its own checkout. The first customer intent is evaluating a job with an already-existing Career Ops project.

This design does not install, update, execute, fork, copy, or publish Career Ops. It does not read the customer's CV, profile, reports, tracker, credentials, or other Career Ops data.

## 3. System context

```text
Customer task
    |
    v
dotaios resolve
    |
    +--> verified DotAIOS project + bounded context + governing skill
    |
    +--> existing product-owned Google resolver
    |
    +--> ExternalProjectCapabilityResolver
             |
             +--> capability card
             +--> advisory project-native entrypoint after exact selection

Host agent reads the returned route and owns any later action.
External project keeps its code, data, credentials, and outputs.
```

The seam lives after PR #125 verifies the project and before `intent-resolution.mjs` publishes its optional capability recommendation. The existing Google resolver remains unchanged beside it. The host agent remains the execution authority.

## 4. Proposed design

### How it works

The customer says, "Evaluate this role with my Career Ops setup." The host agent calls `dotaios resolve` for the verified Career Ops project.

Without an exact capability selector, DotAIOS returns a capability card for `career-ops.evaluate-job`. The card names the outcome, upstream owner, repository, local project, likely effect, and approval requirement. It contains no executable route.

The host then calls the same resolver with the exact capability ID. DotAIOS re-verifies the mapped directory and its live canonical Git remote, then returns an advisory project-native route containing bounded relative entrypoints such as `AGENTS.md`, `CLAUDE.md`, or `.agents/skills/career-ops/SKILL.md` when present. The result says that direct customer approval is still required. Only after that approval may the host revalidate the entrypoint, enter the project, and follow its native instructions. DotAIOS does not interpret the instructions or run them.

### Components and responsibilities

The `ExternalProjectCapabilityResolver` module owns bounded catalog validation, intent discovery, exact selection, live repository verification, safe entrypoint observation, stable result states, effect classification, and recommendation-only behavior. It does not own installation, execution, credentials, external project data, upstream workflow semantics, or non-project capabilities.

The existing Google connection-tool resolver remains unchanged. `intent-resolution.mjs` composes Google and external-project results and enforces that a call cannot request both selectors.

The external-project module recognizes a capability only when both the stored catalog identity and the checkout's live canonical Git remote match a bundled catalog entry. It owns outcome metadata and safe project-native entrypoint declarations. It does not parse or execute those entrypoints.

The intent-resolution module composes the external capability result into its existing bounded envelope. It does not duplicate external catalog or identity logic.

### Decisions

The customer interface is task-first. Pack browsing and installation are rejected because they make catalog lifecycle, updates, rollback, conflicts, and trust scoring the product before one useful outcome is proven.

The first external route is project-native. A universal process route is rejected because the named Agent Reach project is a discovery and health layer, not a stable execution wrapper, and Career Ops already exposes native project instructions.

Discovery and selection are separate states behind one resolver interface. Natural-language intent may return inert metadata. Only an exact capability ID may return a route. This preserves the current rule that prose never becomes executable authority.

The bundled catalog is curated and package-versioned. An open registry is rejected for this batch. The local project remains user-owned and may be modified; DotAIOS reports that honestly instead of claiming the checkout was admitted or pinned.

A shared Google-and-external adapter layer is rejected. The existing Google interface returns connection state and validated argument arrays, while the external-project interface returns inert metadata and advisory resources. Combining them would enlarge the interface and move provider-specific translation into callers.

An explicit selector always wins over implicit discovery. `--tool` preserves the existing Google-only envelope and does not run external discovery. `--capability` evaluates only the external-project capability and does not inspect Google connections. With neither selector, the resolver may discover an inert external capability card from the intent.

## 5. Invariants and requirements

### Invariants

- `INV-1`: External project prose, Markdown, and connection notes never become commands, arguments, or executable paths.
- `INV-2`: An external route is returned only for one verified registered project whose stored repository identity and live canonical Git remote both match the curated entry at selection and final disclosure.
- `INV-3`: Natural-language discovery returns metadata only. A route requires one exact capability ID.
- `INV-4`: Resolution never writes to the AIOS folder, the external project, or host configuration.
- `INV-5`: DotAIOS never stores or returns external-project secrets or personal content.
- `INV-6`: Unknown, ambiguous, malformed, forged, changed, or unsafe project identities fail closed with no route.
- `INV-7`: Existing Google capability behavior and public fields remain compatible.

### Requirements

- The first curated external capability is `career-ops.evaluate-job` for `https://github.com/santifer/career-ops`.
- Its exact card is product-owned:

  ```json
  {
    "id": "career-ops.evaluate-job",
    "title": "Evaluate a job with Career Ops",
    "outcome": "Use this Career Ops project to evaluate one job. Career Ops may create or update onboarding files, a report, a PDF, and tracker data in the project or its configured data and tracker locations. It must not submit an application.",
    "provider": "santifer/career-ops",
    "source": "https://github.com/santifer/career-ops",
    "scope": "project",
    "effect": "mixed",
    "trust": "curated-external-user-owned",
    "approval": "fresh"
  }
  ```

- The capability card uses outcome language and names its upstream owner, source, scope, effect, trust state, and approval requirement.
- Project-native entrypoints are relative regular files observed inside the already-verified project root. The route is advisory and expires if the checkout changes.
- The result distinguishes `discovered`, `matched`, `no_match`, and `refused`.
- A matched external route contains no shell string, command string, executable, argv, environment assignment, or secret path.
- The host must request fresh customer approval before any external write-like action.
- Route approval does not silently authorize unknown external write targets. If Career Ops resolves configured data or tracker locations outside the project, the host must surface those locations before writing.

## 6. Interfaces and data

The module has one external interface and only read-only dependencies:

```js
const result = await resolveExternalProjectCapability({
  intent,
  requestedCapability,
  project
}, {
  readLiveRepoUrl,
  inspectContainedEntrypoints
});
```

The stable result is:

```js
{
  status: "discovered" | "matched" | "no_match" | "refused",
  card: {
    id,
    title,
    outcome,
    provider,
    source,
    scope: "project",
    effect: "read" | "write" | "mixed" | "unknown",
    trust: "product-owned" | "curated-external-user-owned",
    approval: "fresh"
  } | null,
  route: {
    kind: "project-native",
    project_id,
    advisory: true,
    entrypoints: [{ host, resource, observed_identity }]
  } | null,
  reason
}
```

The module does not return the project path. `intent-resolution.mjs` remains the sole publisher of the already-reverified project location in its bounded envelope.

`dotaios resolve` adds an optional `--capability <id>` selector. Existing `--tool` behavior and its nested public result stay byte-for-byte compatible. Supplying both selectors is refused before either resolver returns a recommendation.

### Naming and identity

Capability IDs are product-owned lowercase dotted identifiers and cannot be supplied by the external project. The curated record uses the canonical repository URL already stored in the DotAIOS project catalog. The resolver also reads the live Git remote with the existing bounded read-only Git helper and requires the same canonical URL. An explicit `--repo-url` cannot substitute for the live remote. A missing, ambiguous, forged, or changed repository identity produces no match or a path-free refusal. Catalog changes ship with a new DotAIOS package version; no mutable remote catalog is consulted.

## 7. Failure behavior and lifecycle

If the project is unregistered, unavailable, moved, or no longer identity-verified, the existing path-free project refusal wins before capability routing.

If the stored repository identity does not match, discovery returns `no_match`. If the stored identity claims Career Ops but the live remote is missing, unsafe, or different, resolution returns `refused` with no route. If no declared project-native entrypoint exists as a contained regular file, exact selection returns `refused` with setup guidance and no route.

The mapped directory identity and live remote are checked again immediately before the outer envelope may disclose its location. A changed remote or root produces the existing path-free refusal.

Changing, disabling, or removing a curated capability requires a DotAIOS package update. Existing external projects remain usable without DotAIOS. No work is in flight inside this module because it recommends and returns; it never launches work.

### Composition and approval states

| External capability state | Overall resolution | Omission | Next action |
| --- | --- | --- | --- |
| Explicit `--tool` | Existing Google-only result; external discovery is not evaluated | Existing rules | Existing rules |
| Explicit `--capability` | External-only result; Google is not evaluated | External rules below | External rules below |
| Neither selector and no external match | Existing skill and no-requested-tool rules | Existing rules | Existing rules |
| Capability discovered, no exact selector | `partial` | `external_capability_selection_required` | `clarification_required`; select the exact capability |
| Exact external capability matched | `matched` | Do not add `governing_skill_no_match` | `approval_required`; direct customer approval is required for the card's `mixed` effect |
| Exact external capability refused | `refused` | `external_capability_refused` | `clarification_required`; no route may be used |
| Both `--tool` and `--capability` supplied | `refused` | `capability_selector_collision` | `clarification_required` |

The sequence is discovery, exact selection, direct customer approval, immediate host-side entrypoint revalidation, then host-native use. Selection is not approval.

## 8. Security, privacy, and operations

The external checkout is untrusted user-owned material. DotAIOS trusts only its verified mapped directory, its currently matching live Git remote, and the product-owned catalog metadata. It checks entrypoint containment and file type but does not read entrypoint bodies during resolution. The returned route is advisory; the host must repeat containment and regular-file validation immediately before reading it.

No network request, credential lookup, package installation, or write occurs. The only allowed subprocess is the existing bounded read-only Git remote inspection for the selected project. The module receives a read-only entrypoint inspector and live-remote reader rather than a general filesystem or process interface. The catalog is bounded to 128 entries, each with at most 16 triggers and 8 entrypoints. Input and result sizes use the existing intent-resolution budget. Exceeding any bound refuses the capability result.

The later host-agent action remains subject to the host's permissions and a fresh customer approval turn. DotAIOS does not claim sandboxing or authentication for external systems.

## 9. Acceptance criteria

- `AC-1`: Given a verified registered project for `santifer/career-ops`, an ordinary job-evaluation intent returns the curated Career Ops capability card and no route.
- `AC-2`: Given that same project and the exact `career-ops.evaluate-job` selector, resolution rechecks the live remote, returns an advisory contained project-native route, and marks direct fresh approval required.
- `AC-3`: A different repository, explicit-URL forgery, post-registration remote replacement, unverified project, missing entrypoint, unknown capability, or malformed input returns no route.
- `AC-4`: No external result contains a command, shell string, executable, argv, environment assignment, secret path, or text parsed from an external file.
- `AC-5`: Resolution makes no mutation in the AIOS root, Career Ops checkout, project state, or host configuration and launches no process except the exact bounded read-only Git remote inspection.
- `AC-6`: Every existing supported Google capability retains its current observable result and refusal behavior.
- `AC-7`: The CLI composes project, context, skill, capability, omissions, approval state, and location inside its existing output budget.
- `AC-8`: The customer-facing documentation begins with the task-first Career Ops outcome and clearly says DotAIOS neither installs nor owns Career Ops.
- `AC-9`: An explicit `--tool` suppresses external discovery, and an explicit `--capability` suppresses Google inspection.

## 10. Test approach

The agreed seams are the `resolveExternalProjectCapability` interface and the public `dotaios resolve` command. Tests do not inspect catalog internals.

Core interface tests prove `INV-1` through `INV-7`, `AC-1` through `AC-6`, and `AC-9` with fixture projects, literal expected cards, repository mismatch, explicit-URL forgery, live-remote replacement between checks, entrypoint containment, and explicit-selector interaction. Existing Google tests and implementation remain in place unchanged.

CLI tests prove `AC-1`, `AC-2`, `AC-3`, and `AC-7`. Tests inject a read-only entrypoint inspector and live-remote reader; any write, network call, package process, or unexpected subprocess fails immediately, proving `AC-5` structurally. A black-box fixture also snapshots the AIOS root, external checkout, state directory, and host configuration before and after resolution. Documentation contract tests prove `AC-8` only if the repository already enforces public-language contracts there.

## 11. Risks and tradeoffs

- The bundled Career Ops metadata can drift from upstream. The first version mitigates this by recognizing only stable project-native entrypoints and reporting the checkout as user-owned, not admitted.
- A recognized project may contain malicious instructions. DotAIOS returns only an advisory resource after exact selection and still-required approval; it never converts those instructions into executable data. The host remains responsible for revalidating, reviewing, and following them.
- The entrypoint can change after resolution. The route is explicitly advisory and must be revalidated immediately before use; DotAIOS does not claim a pinned snapshot or race-free execution handoff.
- A curated list does not scale to an ecosystem. That is intentional until two different external systems prove the need for installation, health, provenance, and update lifecycle.
- The customer still depends on an agent host to perform the action. This batch proves vendor-neutral discovery and routing, not a new DotAIOS runtime.

## 12. Open questions

- No blocking question remains for the first Career Ops tracer bullet.
- Agent Reach is the second validation target. Its adapter shape remains open because it is machine-level and skill-driven rather than project-native. It must be designed from the real `Panniantong/Agent-Reach` contract after the first tracer bullet, not inferred from another similarly named project.

## 13. Out of scope

- Installing, updating, cloning, forking, or executing Career Ops or Agent Reach.
- A public marketplace, remote catalog, payment system, trust score, or automatic dependency repair.
- A generic shell-command, argv-template, MCP, OAuth, credential, or hosted execution registry.
- Browser-to-local-agent transport.
- Automatic job applications, form submission, messages, or other irreversible external actions.
- npm publication, tags, GitHub Releases, or promotion of a package dist-tag.
