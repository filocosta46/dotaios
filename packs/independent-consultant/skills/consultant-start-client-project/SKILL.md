---
name: consultant-start-client-project
description: Prepare a reviewable local project structure for one named consulting client.
triggers:
  - start a consulting client project
  - set up a client workspace
  - organize a new client engagement
---

# Start a client project

## Purpose

Prepare a local project draft for one confirmed client without mixing context from other engagements.

## Inputs

- The exact client name or local client ID.
- The engagement name and human-confirmed boundary.
- Any source material the human permits for this project.

## Steps

1. Ask for the exact client and engagement. If either is missing or ambiguous, stop.
2. Check whether a matching project already exists. Do not merge projects or reuse another client's directory.
3. Draft a new project from `fixtures/client-project/README.md` without writing it yet.
4. Fill only human-confirmed scope, constraints, and dates. Mark missing facts as `[Assumption]` or leave a human-owned placeholder.
5. Add each permitted input to the source register with its provenance label and local path or public citation.
6. Show the proposed path and full draft. Write only after explicit human approval.

## Output

A proposed local client project README plus a short list of unresolved inputs. The output is a draft, not an active engagement or external commitment.

## Safety boundary

- Work inside one named client project only. If the client scope is missing or ambiguous, stop and ask.
- Label every material input and claim as `[Client-provided]`, `[Internal note]`, `[Public source]`, or `[Assumption]`. Include a local path or citation and access date when available.
- Do not send, publish, upload, or message any output. Produce a local draft only.
- Do not recommend, set, change, or approve pricing. Leave pricing and commercial terms to the human.
- Do not read, request, store, or expose credentials or secrets. Stop and redact if one appears.
- Do not create, configure, schedule, or run automation, hooks, jobs, or background loops.
- Do not delete or overwrite source material or an existing deliverable. Propose a new draft path.
- Require explicit human review before any durable write or external action. A draft is never approval.
