# Independent Consultant Work System

This is a private, non-purchasable candidate for a EUR 35 DotAIOS outcome pack. It gives an independent consultant six small workflows for organizing client work inside a local DotAIOS folder. It does not replace the AI client the consultant already uses.

## Candidate workflows

1. Start one client project.
2. Prepare for one client call.
3. Turn call notes into a follow-up draft.
4. Produce a bounded, cited research memo.
5. Draft a proposal and scope for review.
6. Review one client engagement for the week.

Each workflow keeps clients separate, labels sources and assumptions, produces drafts only, and requires human review. The pack has no connections, credentials, schedulers, background jobs, or automatic sends. It cannot decide pricing, delete source material, or publish anything.

## Private draft status

The catalog entry is intentionally `draft` and `private`. It has no checkout URL, package source URL, or install URL. DotAIOS refuses marketplace installation for draft entries before it resolves any source. Nothing in this directory should be placed in the public registry or linked from a checkout.

The repository's npm package allowlist does not include `packs/`, so this candidate is not part of the published CLI package. The focused tests guard that boundary.

The manifest carries the candidate product identity so the package and future catalog entry can be reviewed together. That identity does not make the pack available for sale.

## Intended local shape

The pack expects each engagement to have one explicit project directory under `projects/`. The template at `fixtures/client-project/README.md` shows the minimum structure. Client facts, assumptions, and public research stay visibly distinct. Durable writes require explicit approval.

## Lifecycle gaps before any sale

This candidate has structural tests, but it is not a finished paid product. The following gates are still open:

- authenticated delivery and entitlement checks;
- immutable release artifacts and checksum verification;
- collision-safe installation and an ownership receipt;
- idempotent reinstall and versioned update behavior;
- tested removal, rollback, and recovery without deleting client data;
- revoked-entitlement behavior and offline grace policy;
- migration rules for user-edited templates and skills;
- final commercial license terms and privacy guidance;
- end-to-end acceptance on every claimed AI client;
- support ownership, incident response, and a customer recovery guide.

Do not sell, publish, or claim automatic updates until every gate has an owner, acceptance evidence, and a tested recovery path.

## Review notes

- The manifest read permission uses broad project and vault globs because the current permission schema cannot express one runtime-selected client directory. Every skill adds a stricter one-client gate, but that is an instruction boundary rather than a sandbox.
- The workflows can prepare local drafts. A human remains responsible for facts, confidentiality, commercial terms, legal review, and every external action.
- The pack includes no external repository code or third-party skill files. See `PROVENANCE.md`.
