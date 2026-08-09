# DotAIOS Foundation Reliability — Product Brief

Status: evidence-framing draft; not yet the approved Product Contract
Date: 2026-08-09

## Product truth carried forward

DotAIOS Foundation is the free, local-first, plain-file context and workflow foundation for an individual or very small team. The person's AIOS folder is durable; agents, models, bridges, indexes, and replication mechanisms are replaceable clients or projections. Canonical user knowledge must remain readable offline and must never depend on an opaque derived store.

The current programme owns Foundation reliability only. Paid packs, checkout, customer delivery, commercial operations, and publication are outside its authority.

## Sharp user

The primary user is a non-expert knowledge worker who already uses ChatGPT, Claude, or similar agents as disconnected chats. They avoid configuration and should not need to understand prompt engineering, context windows, skill routing, Git, MCP, or retrieval infrastructure.

## Jobs to be done

1. When I reopen a project with a different agent, help me continue without retelling the project's history.
2. When I need an earlier decision, return the relevant decision with visible source and provenance rather than a plausible reconstruction.
3. When important context is omitted from the bounded packet, tell me what class of material was omitted and how the agent can retrieve it.
4. When I attach source material, preserve the files I own and make their current state discoverable without turning a derived index into the only copy.
5. When I use a supported host, make context and project skills discoverable through that host's native contract and produce an observable receipt.
6. When I move to a second device or recover a clean machine, restore the canonical allowlisted knowledge without silent overwrite, secret leakage, or unexplained conflict loss.

## Reliability scenarios to settle

- Cross-agent resume on one device.
- Decision retrieval with source/provenance.
- Bounded-context omission and follow-up retrieval.
- Project-skill discovery and invocation on a fresh host.
- Source-folder revisit after change or disconnection.
- Second-device divergence, conflict handling, and clean restore.

The first release-candidate slice will prove one scenario end to end. The evidence-backed working hypothesis is: given a project and the user's current task, a fresh agent receives the normal bounded continuity packet plus the smallest relevant project evidence, with visible provenance and enough context to continue without retelling.

This is a composition problem before it is an algorithm problem. The current bounded packet misses a synthetic project decision placed beyond its fixed excerpt, while the existing lexical reader retrieves the same decision and source from the same task query. The first slice should connect task intent, project-scoped retrieval, budget admission, evidence rendering, omission accounting, and the portable host contract through the canonical working-context seam.

The core verdict stops at evidence availability. It proves that the correct source was offered to the agent inside budget; it does not use another LLM to grade the agent's prose as a substitute for retrieval evidence.

Competing shapes remain explicit until scope confirmation:

- A heading-only project decision parser is smaller, but current project records do not consistently use one decision heading.
- A new vector/graph retrieval layer is larger, and the lexical baseline has not failed the representative fixture.
- Cross-device replication is important, but current divergence and recovery evidence makes it a risk-hardening track rather than the first daily-value proof.
- Host onboarding and adapter defects are mandatory launch gates, but fixing them alone would not prove that Foundation solves the continuity job.

## Success evidence

- A synthetic, non-private fixture reproduces the current failure.
- The task-aware lexical baseline is recorded before introducing new ranking infrastructure.
- The baseline records offered, admitted, omitted, bytes, latency, and task recall.
- The result names its source/provenance and fails safely when evidence is missing or stale.
- A supported fresh host discovers the distributed artifact and produces an observable receipt.
- A clean second-host or second-device run verifies the claimed scope.
- No canonical file, user-authored bridge content, secret, or unrelated home path is overwritten or exposed.

## Non-goals

- A hosted memory SaaS or mandatory account.
- Vector, graph, cloud-database, or LLM-writer infrastructure without a measured failure that the lexical/plain-file baseline cannot solve.
- Enterprise teams, permissions administration, company memory, or an autonomous company OS.
- Automatic promotion of session evidence into durable user truth.
- Claiming every configured host, adapter, or device path is supported without a fresh observable receipt.
