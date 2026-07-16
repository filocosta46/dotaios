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
