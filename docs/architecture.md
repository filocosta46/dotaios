# Architecture

DotAIOS is a local file convention.

## Context

`context/` is loaded every session. It describes identity, active work, priorities, long-term direction, and domain-specific modes.

## Memory

`memory/` is operational state. Agents should load only recent entries:

- last 50 `events.jsonl` entries
- today and yesterday from `signals/`
- `errors.jsonl` only when debugging

## Vault

`vault/` is long-term knowledge, loaded on demand. Users may keep it inside `~/.aios/vault` or configure an external `vault_path` in `aios.json`, such as an Obsidian vault.

Company and people profiles live only in `vault/org/`. Access frequency is routing logic, not a reason to duplicate storage.

## Skills And Plugins

Skills are markdown instruction sets that any agent can read. Plugins may include code, but must declare permissions in `manifest.json`.
