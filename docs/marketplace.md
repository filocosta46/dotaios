# Outcome Catalog and Paid Packages

DotAIOS core and its bundled starter workflows are free. Paid packages are a separate future layer and are not available in v1.24.

## Current status

The public catalog lives at `https://dotaios.vercel.app/registry.json`. Entries marked `draft` or `planned` can appear in `dotaios market list`, but the CLI refuses to purchase or install them. Draft entries cannot contain checkout URLs. The branded `dotaios.com` URL is not used until that domain serves the same verified registry.

This is deliberate. A paid offer stays unavailable until its package can be installed, updated, removed, and recovered safely.

```bash
dotaios market list
dotaios market info <id>
```

## What a released entry must provide

An entry marked `available` needs:

- a stable lowercase ID and human-readable name;
- an immutable or reviewable package source;
- a root `manifest.json` whose identity matches the registry;
- a compatible DotAIOS version;
- explicit permissions and owned workflow IDs;
- a verified install and recovery path.

Paid available entries also need a product ID and checkout URL. The current license command implements Gumroad verification only. A cached license does not grant access to a private Git repository by itself.

## Package safety boundary

The existing local plugin installer validates manifests, permissions, destination paths, and collisions. The full paid lifecycle is still incomplete: ownership receipts, idempotent reinstall, versioned update, rollback, removal, authenticated delivery, and revoked-entitlement checks need end-to-end acceptance before sales open.

Until those gates pass:

- no official paid package is marked available;
- no official draft exposes a checkout link;
- no automatic or weekly package update is claimed;
- local and third-party plugin installation remains an advanced, reviewed action.

See [plugin development](plugin-development.md) for the current local plugin contract and [security](security.md) for approval boundaries.
