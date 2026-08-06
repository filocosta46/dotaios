# Plugin Development

Plugins are optional local extensions. DotAIOS installs a trusted plugin from a
local directory containing a `manifest.json`, a `SKILL.md`, and optional source
code. It refuses remote URLs so acquiring and reviewing source stays a separate,
human-controlled step.

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
npx dotaios@latest install ./my-plugin --dry-run
```

The CLI validates the manifest and prints the permission surface.

## Install Locally

```bash
npx dotaios@latest install ./my-plugin
```

This copies the plugin into `~/aios/plugins/<name>/` and updates `~/aios/skills/_registry.json` with the skills the plugin provides.

Use `--path <dir>` to install into a non-default AIOS folder.

For a plugin hosted in Git, pin and clone or download the exact revision outside
DotAIOS. Review it, then pass the local folder to the dry run:

```bash
npx dotaios@latest install ./reviewed-repo --dry-run
npx dotaios@latest install ./reviewed-repo
npx dotaios@latest install ./reviewed-repo --subdir packages/my-plugin --dry-run
```

Before installing, confirm:

- The checked-out or downloaded revision is the one you intended to inspect.
- The source and manifest permissions are acceptable.
- You run the local-folder command with `--dry-run` first.

For trust and safety expectations, see `docs/security.md#plugins`.

The installer stages the copy before replacing an existing plugin, and rejects symlinks inside plugin folders. This reduces accidental install damage, but it is not a sandbox.

## Manifest Rules

- `name` must use lowercase letters, numbers, and hyphens.
- `permissions.read`, `permissions.write`, `permissions.write_with_approval`, and `permissions.connections` must all be arrays.
- `requires.context` and `requires.connections` must be arrays when present.
- `provides.skills`, `provides.memory_writers`, and `provides.scheduled_tasks` must be arrays when present.
- Plugins can write ephemeral signals automatically, but durable updates should use `write_with_approval`.

## Marketplace Direction

A future catalog UI should show one-line CLI install commands, permission previews, package provenance, and checksum/version metadata. A catalog must not write directly into user AIOS folders.
