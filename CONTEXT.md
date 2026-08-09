# DotAIOS

DotAIOS defines a local, user-owned memory folder and the compatibility rules that let its managed scaffold evolve without taking ownership of the person's knowledge.

## Language

**AIOS folder**:
The canonical local folder a person owns and carries between supported agents. It contains user memory and managed scaffold, but it is not an application database.
_Avoid_: workspace, database, app data

**User memory**:
The person's accumulated context, project records, recent memory, and long-term knowledge. A product upgrade preserves it by default and may change it only through a separate explicit user action.
_Avoid_: generated state, cache

**Managed scaffold**:
Content DotAIOS can prove it owns, such as generated indexes, declared managed regions, and compatibility metadata. Ownership never extends to surrounding user-authored content.
_Avoid_: system files, internal files

**Schema version**:
The compatibility state of an AIOS folder. It changes only when the folder contract changes and is independent from the DotAIOS package release version.
_Avoid_: app version, package version

**Migration plan**:
A deterministic preview of the ordered changes required to move an AIOS folder between schema versions. It has no write effects and identifies every managed path it would change or preserve.
_Avoid_: update script, setup rerun

**Migration receipt**:
The durable evidence that an approved migration completed. It identifies the schema transition, the applied migration plan, preserved user memory, and any recovery material.
_Avoid_: log entry, success message

**Working context**:
The canonical, deterministic, hard-bounded projection of user memory offered to an agent for immediate continuity. It is a view of the AIOS folder, never a second memory authority.
_Avoid_: memory dump, session memory, digest

**On-demand retrieval**:
A query-shaped, bounded view used to expand beyond working context for a specific task. Its results remain evidence pointers to canonical files rather than new durable truth.
_Avoid_: startup context, automatic memory, answer generation

**Source evidence**:
A retrieved excerpt together with enough provenance to identify its canonical origin and scope. Agent prose without a source reference is not source evidence.
_Avoid_: generated answer, remembered fact

**Memory promotion**:
An explicit, previewed transition from source evidence into durable user memory. Promotion preserves the source relationship and never treats a session inference as approved truth by default.
_Avoid_: auto-memory, extraction, summarization

**Host receipt**:
Reproducible evidence that a supported agent host discovered, invoked, and produced the expected DotAIOS result. Installed or configured state alone is not a host receipt.
_Avoid_: configuration check, file presence

**Personal replica**:
A recoverable copy of allowlisted canonical knowledge for one person's devices. It does not imply safe concurrent writers, shared-team authority, or automatic conflict resolution.
_Avoid_: shared workspace, collaboration database, backup
