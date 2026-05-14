# DotAIOS Marketplace & Paid Skills

DotAIOS itself is free, local-first, and always will be. Paid skills and plugins are an opt-in layer for users who want curated workflows built on top.

This document explains how the marketplace works for users, and how vendors (you) publish paid packs.

## Where the marketplace lives

The marketplace is a single static JSON file served from the DotAIOS website at `https://dotaios.com/registry.json`. The CLI reads it on `dotaios market list` and never modifies it. No DotAIOS server. No accounts. Vendors can publish their own registries by pointing users at `--registry <url>`.

The bundled free skills (`audit`, `plan-today`, `daily-brief`, `morning-digest`, `closeday`, `today`, `weekly-review`, `privacy-brief`, `summarize-source`, `ingest`, `import-context`) ship with the CLI itself and are NOT listed in the marketplace. They are installed automatically during `dotaios init`.

## For users

### Browse what is available

```bash
dotaios market list
dotaios market info <id>
```

The registry is a single JSON file. The default points at the official DotAIOS registry. Override with `--registry <url>` or by setting `DOTAIOS_REGISTRY_URL`.

### Install a free skill

```bash
dotaios market install hello-memory
```

This clones the linked git repo, validates the manifest, and copies the plugin into `~/aios/plugins/`.

### Install a paid skill

Buy a license from the vendor (Gumroad checkout, etc). You receive a license key by email. Then run:

```bash
dotaios license add <product-id> <license-key>
dotaios market install <product-id>
```

The license is verified once with Gumroad and cached at `~/.dotaios/licenses.json`. Every subsequent install is offline.

### License privacy

License keys are credentials. The license store at `~/.dotaios/licenses.json` is mode 0600 (owner-readable only). Do not paste it into chat, do not commit it.

### Remove a license

```bash
dotaios license remove <product-id>
```

## For vendors (publishing a paid pack)

A paid pack is a normal DotAIOS plugin with three extra manifest fields.

### 1. Manifest

```json
{
  "name": "career-pack",
  "version": "1.0.0",
  "description": "Career search workflows: company research, cover letters, application tracking.",
  "license": "Proprietary",
  "aios_version": ">=1.9.0",
  "requires": { "connections": [], "context": ["work.md", "priorities.md"] },
  "provides": { "skills": ["career-search", "cover-letter", "company-research"], "memory_writers": [], "scheduled_tasks": [] },
  "permissions": { "read": ["context/*"], "write": [], "write_with_approval": ["vault/wiki/*"], "connections": [] },
  "paid": true,
  "vendor": "filocosta",
  "product_id": "aios-career-pack"
}
```

Three monetization fields:

- `paid: true` — flips license enforcement on.
- `vendor` — your stable vendor slug. Lowercase, hyphenated.
- `product_id` — your Gumroad product permalink. This must match what `dotaios license add` is given.

### 2. Hosting

Push the plugin folder to a public or private git repo. The marketplace entry points at it via `git_url` + optional `subdir`. DotAIOS clones with `--depth 1`, so private repos require the user to have git credentials.

### 3. Gumroad product

Create a Gumroad product. Enable "License keys" in product settings. The product permalink becomes your `product_id`.

DotAIOS uses Gumroad's License Verification API:

- Endpoint: `https://api.gumroad.com/v2/licenses/verify`
- Body: `product_id=<permalink>&license_key=<key>&increment_uses_count=false`
- Response: `{ "success": true, "uses": <n>, "purchase": {...} }`

DotAIOS does not increment the use count during normal install; only `dotaios license verify` (future command) would.

### 4. Registry entry

Submit a PR adding your entry to `registry.json` at the root of the dotaios repo:

```json
{
  "id": "career-pack",
  "name": "AIOS Career Pack",
  "vendor": "filocosta",
  "paid": true,
  "price": 29,
  "product_id": "aios-career-pack",
  "git_url": "https://github.com/filocosta46/aios-career-pack.git",
  "subdir": null,
  "checkout_url": "https://filocosta.gumroad.com/l/aios-career-pack",
  "description": "Company research, cover letters, application tracking. Built for non-technical job seekers using Claude Code.",
  "tags": ["career", "paid"]
}
```

Once merged, users can do `dotaios market install career-pack` and they will be told to add a license first if missing.

## Pricing and refunds

DotAIOS itself does not handle payment. Gumroad does. Refunds and disputes are between vendor and buyer. DotAIOS only checks "is this key valid for this product?"

## Reselling open-source skills you did not write

Question every vendor hits: when your pack wraps an open-source tool (gws, marker, n8n, an Obsidian plugin), do you fork it, vendor it, or point at it?

DotAIOS recommends: **point at it**. Sell the layer YOU produce.

### What your paid pack should ship

- Your `SKILL.md` files — curated prompts and workflows tuned for DotAIOS context shape.
- Your `manifest.json` — `paid: true`, your `product_id`, your vendor slug, your permissions.
- Documentation files — "how to install upstream tool X from its own source", in language your ICP understands.
- Optional small glue scripts you maintain.

### What your paid pack should NOT do

- **Do not fork upstream code.** You inherit the maintenance burden and lose every upstream update.
- **Do not redistribute someone else's binaries.** License risk and stale versions.
- **Do not bundle outdated copies of upstream tools.** Users will hit bugs that are already fixed upstream.

### How updates flow

- Upstream open-source tool stays installed on the user's machine via its own channel (brew, npm, etc.) and auto-updates on its own.
- Your pack updates when you push to your own repo — DotAIOS does not currently auto-update installed packs, but `dotaios skill add <git_url>` against the same source overwrites cleanly.
- This mirrors how the bundled `google-workspace` skill already works: it wraps `gws` without forking it.

### When you DO need to pin upstream

Rare case: you need a specific upstream version because your workflow depends on it.

- State the pinned version in your manifest `description`.
- Use git submodule for the upstream copy.
- Bump your pack version whenever you re-pin.

This way the user sees clearly that they are getting your curated build of a known upstream commit.

## Why this design

- DotAIOS core remains free, local-first, and dependency-free.
- License verification is online once, then offline forever.
- License storage lives outside `~/aios/` so an Obsidian-synced vault does not accidentally leak credentials.
- The registry is a static file — no DotAIOS server, no API, no operational burden.
- Vendors can self-host their own registries by handing users a `--registry <url>` flag.
- Bundled free skills stay free forever. Paid packs are pure additions on top.
