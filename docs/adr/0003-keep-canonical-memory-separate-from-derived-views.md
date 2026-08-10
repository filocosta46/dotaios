---
status: accepted
---

# Keep canonical memory separate from derived views

The user-owned AIOS files are the authority; projections, indexes, receipts,
metrics, quarantines, and replicas never become a second memory store. This
preserves inspectability and recovery, while allowing DotAIOS to build fast or
host-specific views without making their loss or corruption a loss of memory.

## Authority matrix

| Domain | Canonical form | Who may mutate it | Derived or transport forms |
| --- | --- | --- | --- |
| Durable user context | User-authored files under `context/`, project records, decisions, and daily memory | The person directly, or a command they explicitly invoke for that exact record | Working context, search results, generated summaries |
| Source material | Provenance-bearing files under `vault/` and other explicit imports | Explicit ingest/capture commands; later edits remain the person's | Search snippets, source indexes |
| Recent event and signal memory | Append-only records under `memory/` | Explicit capture/log workflows and configured local automations with a named write contract | Bounded startup selection, search results, archives produced by explicit maintenance |
| Session evidence | Readable session Markdown under `memory/sessions/<date>/` | Explicit save/import or a separately enabled host-capture workflow | `memory/sessions/index.jsonl`, working-context selections, search results |
| Managed scaffold | Files or marked regions DotAIOS can prove it owns | Previewed setup, activation, migration, repair, disconnect, or removal operations | Installation inventory and health reports |
| Operational evidence | Receipts, recovery metadata, locks, metrics, and quarantine material | The exact operation that owns the artifact | Status and doctor summaries |
| Personal replica | An allowlisted copy of canonical records | A serialized private replication workflow | Remote Git history and restore receipts |

Agents and read adapters may inspect canonical records only through the
documented bounded projection or on-demand retrieval surfaces. They may propose
a durable change, but a proposal is not memory until the person invokes or
approves the specific write or promotion. A derived index may be discarded and
rebuilt; it may never authorize deletion of a canonical record. Replication may
carry allowlisted canonical bytes, but it may not resolve competing edits or
promote operational artifacts into memory silently.

For sessions specifically, Markdown is canonical evidence and
`memory/sessions/index.jsonl` is a rebuildable derivative. Capture must publish
the Markdown durably before its index entry becomes visible, reconcile must
recover orphans without deleting evidence, and delete must prove ownership of
the exact canonical file before changing either representation.

Rejected alternatives:

- Treat the session index as authoritative: a torn or tampered row could hide
  or delete readable evidence.
- Treat working context or MCP output as memory: host budgets and selection
  policy would become a second, lossy authority.
- Treat the private Git remote as canonical: transport conflicts would become
  memory-policy decisions and would misrepresent replication as collaboration
  or backup.
