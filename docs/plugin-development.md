# Plugin Development

Plugins are optional local extensions. In v1.1, DotAIOS supports installing a trusted plugin from a local directory. A plugin contains a `manifest.json`, a `SKILL.md`, and optional source code.

Remote plugin installs are not supported yet. Download and review a plugin locally before installing it.

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "description": "What this plugin helps the user do",
  "license": "MIT",
  "aios_version": ">=1.0.0",
  "requires": {
    "connections": [],
    "context": ["identity.md", "priorities.md"]
  },
  "provides": {
    "skills": ["example-plugin"],
    "memory_writers": [],
    "scheduled_tasks": []
  },
  "permissions": {
    "read": ["context/*"],
    "write": ["memory/signals/*"],
    "write_with_approval": ["vault/org/*"],
    "connections": []
  }
}
```

Core rule: plugins may propose durable memory changes, but the user approves writes to `context/`, `vault/wiki/`, and `vault/org/`.

## Validate A Plugin

```bash
dotaios install ./my-plugin --dry-run
```

The CLI validates the manifest and prints the permission surface.

## Install Locally

```bash
dotaios install ./my-plugin
```

This copies the plugin into `~/.aios/plugins/<name>/` and updates `~/.aios/skills/_registry.json` with the skills the plugin provides.

Use `--path <dir>` to install into a non-default AIOS folder.

The installer stages the copy before replacing an existing plugin, and rejects symlinks inside plugin folders. This reduces accidental install damage, but it is not a sandbox.

## Manifest Rules

- `name` must use lowercase letters, numbers, and hyphens.
- `permissions.read`, `permissions.write`, `permissions.write_with_approval`, and `permissions.connections` must all be arrays.
- `requires.context` and `requires.connections` must be arrays when present.
- `provides.skills`, `provides.memory_writers`, and `provides.scheduled_tasks` must be arrays when present.
- Plugins can write ephemeral signals automatically, but durable updates should use `write_with_approval`.

## Marketplace Direction

A future plugin catalog should show one-line CLI install commands, permission previews, package provenance, and checksum/version metadata. The website should not write directly into user AIOS folders.
