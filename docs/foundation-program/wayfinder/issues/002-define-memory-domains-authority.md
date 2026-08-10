---
title: Define memory domains and authority
label: wayfinder:grilling
status: closed
assignee:
blocked_by: []
---

## Question

Which records are canonical user memory, session evidence, source material, working-context projections, derived indexes, or replicas, and which actors may read, propose, approve, or write each domain?

## Resolution

Accepted [ADR 0003](../../../adr/0003-keep-canonical-memory-separate-from-derived-views.md).
User-owned files remain authoritative. Session Markdown is canonical evidence;
its JSONL index is rebuildable. Working context, retrieval results, generated
indexes, operational evidence, and replicas are bounded views or transport, not
memory authorities. Agents and read adapters may inspect; they may propose but
cannot promote a result into durable memory without the person's explicit write
or approval. This closes the ownership decision required by the transactional
SessionStore slice without approving the separately blocked task-aware context
proposal.
