---
title: Sparse storefronts for profession packs
date: 2026-07-31
category: design-patterns
module: website storefront
problem_type: design_pattern
component: documentation
severity: medium
applies_when:
  - "Adding a profession-specific pack to the main DotAIOS website"
  - "Presenting an offer whose private delivery and checkout are not ready"
tags:
  - "profession-packs"
  - "storefront"
  - "offer-readiness"
  - "public-private-boundary"
---

# Sparse storefronts for profession packs

## Context

A profession pack is part of DotAIOS, not a separate product universe. Reusing the foundation page's Finder simulation on every pack page made the offer feel like another technical demo and added explanation where a buyer needed a fast decision.

## Guidance

Give every pack its own route inside the main site, with only four jobs:

1. Name the professional outcome in one short headline.
2. Show one concrete work receipt as proof.
3. Summarize the few workflows included.
4. Present price, readiness, requirements, and one action in a compact commerce rail.

Keep the interactive folder preview on the foundation homepage. The current homepage renders it in `website/src/components/Foundation.jsx`, while the pack page renders a receipt, included workflows, and install handoff in `website/src/components/ConsultantPack.jsx`.

Route all page and locale links through one small seam. `website/src/site-page.js` owns the two public paths and preserves English or Italian when a visitor moves between them.

Drive the commercial action from offer state. `website/src/components/ConsultantPack.jsx` exposes a purchase link only when readiness is `available`; otherwise the action leads to proof. The public offer remains `unavailable` with explicit remaining gates in `website/src/offer.js`. The registry validator also rejects checkout URLs on draft or planned entries in `packages/core/src/market-registry.mjs`.

The public repository may describe the offer, its evidence, and its delivery contract. It must not contain the paid pack source or a checkout link before delivery is ready.

## Why This Matters

The buyer sees the result before the machinery. Sparse pages make profession packs approachable, while the readiness-driven action prevents marketing from outrunning delivery. The shared route seam keeps every pack visibly inside DotAIOS without forcing the foundation and commerce pages into the same visual metaphor.

## When to Apply

- A new profession pack is added to the DotAIOS marketplace branch.
- A pack needs a simple ecommerce-style page rather than a product simulation.
- Checkout, entitlement, recovery, or outcome evidence is still incomplete.
- The public site and private paid artifact must evolve without crossing their boundary.

## Examples

Prefer this page shape:

```text
Outcome headline
Price + readiness + action
One work receipt
Three included workflows
Three install steps
```

Avoid repeating a folder browser, long feature inventory, testimonial carousel, or generic AI-benefit copy on a pack page. If evidence is not approved, show the limitation and route the action to proof or the free DotAIOS setup.

## Related

- `STRATEGY.md` records the public storefront and private delivery boundary.
- `docs/plans/2026-07-31-001-feat-consultant-pack-private-delivery-plan.md` defines the staged implementation and readiness gates.
