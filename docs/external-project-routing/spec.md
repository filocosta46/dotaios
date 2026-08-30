# External Project Routing

> **Status:** Owner-directed design; ready for ticketing · 2026-08-30
> **Authority:** Supersedes `docs/external-capability-routing/design.md`. No product code is authorized by this document alone.
> **Reviews:** [Independent architecture/trust and customer-value findings](reviews.md) are resolved here and in the ordered tickets.

## Problem statement

A customer can download or receive a useful GitHub project without knowing where it should live, how a later agent will find it, which project instructions apply, or where the project left its results. DotAIOS already has the spine for this: explicit project registration, exact machine-local folder identity, bounded project memory, skills, and a read-only intent resolver. What is missing is a generic route into the customer's own project conventions and a return path that remembers only where a durable result lives.

The product must not become a repository catalog. Career Ops is an example of a customer-owned automation, not a recommendation, package, or product capability. A future commercial package may place several independently owned repositories on a customer's machine, but this feature only makes already-present registered folders legible to agents.

## Solution

Use the registered project as the unit of discovery and approval:

`chat request -> one registered project candidate -> explanation and approval -> fresh exact route -> one approved project-native action -> output pointer`

Keep the repository wherever it already is. AIOS does not download, move, or copy it. The customer connects that existing folder once through preview-first project registration and describes what they use it for; AIOS then remembers its exact machine-local location for supported agents.

Discovery uses only customer-approved registration metadata and the presence of known convention files. It does not read convention bodies. After approval, the host re-resolves the exact project and starts or retargets a fresh context rooted at that folder so the host's normal project-instruction mechanism can load a natively supported convention at startup. DotAIOS never interprets or executes those instructions.

After the action creates a durable result, a separate preview/apply interface records one minimal output pointer. The source project and customer retain the content and ownership. DotAIOS does not copy, summarize, index, embed, or search the content.

## User stories

1. As a customer who downloaded a useful repository, I want to register its folder once so every supported agent can find the same project later.
2. As a customer asking in chat, I want AIOS to identify one relevant registered project without making me remember its filesystem path.
3. As a customer, I want to know why that folder matched and which agent conventions exist before anything reads or runs them.
4. As a customer, I want to approve one concrete action rather than grant a repository blanket authority.
5. As a host agent, I want an inert, freshly verified project-native route so I can start a fresh source-folder context through my normal instruction hierarchy.
6. As a customer, I want an ambiguous or changed project identity to stop cleanly instead of routing to the wrong folder.
7. As a customer, I want a later agent to know where a useful report, tracker file, or result directory lives without AIOS absorbing its content.
8. As a customer, I want removing a pointer to leave the underlying result untouched.
9. As an existing Google-routing user, I want the product-owned Google tool contract and its approval behavior to remain unchanged.
10. As a project author, I want my repository to stay independent: DotAIOS must not install, modify, publish, or claim ownership of it.

## Requirements and invariants

| ID | Requirement |
| --- | --- |
| **EPR-001** | A project is eligible only when its validated registration frontmatter, stable project ID, machine-local root identity, stored canonical Git remote, and authoritative live Git remote agree. `origin` is authoritative when present; otherwise exactly one safe fetch remote may stand in. Zero or multiple non-`origin` fetch remotes refuse routing. Registration establishes identity and location, not code safety or product endorsement. |
| **EPR-002** | Generic routability is established only by contained regular-file presence at `AGENTS.md`, `CLAUDE.md`, or one or more `.agents/skills/*/SKILL.md` resources. Resolution observes names and file identity metadata only; it never reads their bodies. |
| **EPR-003** | Generic discovery is derived only from validated registration frontmatter—stable ID, slug, name, customer-approved purpose, canonical remote basename, status—and convention presence. README body text and external files are never discovery fallback. The result must not derive commands, arguments, outcome claims, effects, approval semantics, or executable material from external prose. |
| **EPR-004** | The registered project slug is the smallest customer-facing handle and the stable project ID accompanies it. An exact unique slug or ID selects a project. Colliding names or aliases, weak/tied intent matches, changed identities, and multiple remotes without `origin` return no route. |
| **EPR-005** | Resolution is read-only and advisory. It may disclose one freshly verified location and relative convention resources, but it never changes working directory, reads convention content, runs commands, accesses credentials, or approves an action. The host may enter the folder only after a fresh direct approval and an immediate exact re-resolution. |
| **EPR-006** | Output registration is a separate explicit preview/apply interface invoked only after an approved action reports a durable result. The one-approval happy path is allowed when the original explanation says that AIOS will record one constrained pointer for the same project and action; the host may preview and apply that pointer under the same approval. A changed project, kind, scope, or disclosed behavior requires new approval. |
| **EPR-007** | A pointer record contains exactly: pointer ID, kind, locator, short label, and recorded-at timestamp. Supported v1 kinds are `project-file` and `project-directory`. No content, excerpt, output hash, embedding, command, credential, remote URL, or absolute local path is stored. |
| **EPR-008** | Project locators are NFC-normalized POSIX-relative resources of 1–1,024 UTF-8 bytes and at most 64 non-empty segments. They reject absolute paths, backslashes, `.`, `..`, controls, and unpaired surrogates, then must resolve inside the freshly verified project root as the declared regular single-link file or real directory, with no symlinked ancestor, special file, or traversal escape. |
| **EPR-009** | Pointer scope is the owning project only. Pointer records are excluded from working memory, Shared memory, global/project content search, generated indexes, embeddings, and MCP. They are exposed only by the exact project route or the explicit output-pointer list/resolve interface. |
| **EPR-010** | The canonical deduplication key is project ID + kind + normalized locator. An exact repeat is idempotent; a new label for the same locator previews an update to the same pointer ID. Missing or unsafe targets stay recorded as stale until explicitly removed. |
| **EPR-011** | Pointer deletion is preview/apply, deletes only the pointer record, and never deletes, moves, fetches, or edits the target. The external project and customer always own the result. An unavailable or unregistered project withholds resolved local locations without silently re-pointing them. |
| **EPR-012** | Existing project-only memory, AIOS governing-skill, location-refusal, output-budget, and Google tool fields retain their meanings. Project-native conventions are a separate field and can never supply Google argv, replace the AIOS skill envelope, enter MCP, or trigger Shared-memory fallback. |
| **EPR-013** | Career Ops and Panniantong/Agent-Reach are black-box validation fixtures only. Their names, remotes, purposes, and observed convention combinations may appear in tests and examples but never in shipped routing branches, catalogs, capability IDs, or product-owned outcome copy. |
| **EPR-014** | Every refusal is path-free when project identity, containment, or final revalidation fails. Discovery and exact resolution are bounded, deterministic, offline except for the existing local Git subprocess, and make no writes. |
| **EPR-015** | Convention presence establishes generic routability, not universal host compatibility. Before exact entry, the host must identify at least one detected convention it natively supports. Otherwise resolution returns `unsupported_by_host` without reading convention content or disclosing a route. |
| **EPR-016** | The authoritative pointer collection is a bounded, project-scoped JSON envelope with generation and exact project identity. Preview/apply uses an owned per-project lock, compare-and-swap over the observed generation and bytes, and atomic publication. Malformed, oversized, mismatched, or duplicate data is refused without guessed repair. |
| **EPR-017** | Pointer metadata outlives temporary target unavailability but never silently changes owner. Removing a pointer is allowed while its project root is unavailable; future project unregistration must refuse while pointers exist unless they are explicitly removed first. Orphaned metadata is reported for repair and is never auto-deleted or re-parented. |

These requirements imply four non-negotiable invariants: external prose is inert during resolution; project registration is not execution approval; one approval covers one named action only; and an output pointer is a locator, never memory or content.

## Product contracts

### 1. Discovery and exact selection

The existing read-only intent resolver gains a `project_route` result. It does not gain an external `--capability` selector.

Identity and selection are deterministic:

1. Parse only bounded, validated frontmatter from active registered project records and join it to the stable-ID machine-local mapping. README body text is not consulted.
2. Revalidate the mapped root identity. Read the live `origin` fetch URL when present; otherwise accept exactly one safe fetch remote. Zero remotes, an unsafe remote, or multiple non-`origin` fetch remotes refuses that project. The resulting canonical remote must equal the stored registration remote.
3. Observe bounded convention presence without opening convention bodies. Only active, identity-verified, convention-present projects remain eligible for implicit matching.
4. An exact `--project <slug-or-id>` selects only that unique registered project. Exact selection of a missing-convention project returns `refused` with reason `project_not_routable`; implicit absence simply yields `no_match`.
5. Without a selector, a current directory contained by exactly one eligible project selects that project.
6. Otherwise, eligible projects are ranked with the existing lexical scoring approach using only name, slug, customer-approved purpose, and canonical remote basename. An implicit match requires one unique winner that clears the existing minimum score with separation confidence of at least `0.67`.
7. A tie, low separation, colliding handle, or more than one exact display-name match returns `ambiguous` with bounded project handles and no location or convention route. No match returns `no_match`.

Implicit discovery inspects at most 32 active registered projects, with at most eight concurrent live-Git observations, 64 KiB of aggregate registration frontmatter, and 66 convention observations per project: the two named root files plus 64 immediate skill directories. Exceeding any global bound returns path-free `discovery_bound_exceeded` and asks for an exact slug or ID. Results are stable-sorted by convention kind and relative resource.

The discovery result has this product shape:

| Field | Meaning and authority |
| --- | --- |
| `status` | `candidate`, `ready`, `unsupported_by_host`, `no_match`, `ambiguous`, or `refused`. |
| `project` | Stable ID, slug handle, display name, customer-approved purpose, canonical repository identity, and placement from verified registration. |
| `match` | Structured reason such as exact handle, exact name, purpose overlap, or remote-name overlap; never external prose. |
| `routability` | `registered-user-owned`, `effect: unknown`, `approval: direct_user_required`, and inert convention kinds/resources. |
| `route` | `null` for implicit discovery. Exact resolution may return the verified machine-local location, relative resources with observed file identity, `advisory: true`, and `revalidate_before_entry: true`. It contains no command, argv, environment, content, or claimed outcome. |

The first discovery call gives the host enough information to explain the candidate. It does not disclose a location. After the customer approves the explained action, the host calls exact resolution with the returned slug or stable ID and declares the convention kinds it natively supports. That second read-only call rechecks the mapped root, authoritative live remote, and convention identities immediately before location disclosure. No supported overlap returns `unsupported_by_host` and a manual-open recovery, not a route.

### 2. Trust and execution boundary

There are three distinct authorities:

1. **DotAIOS authority:** the customer-approved registration record, exact folder identity, canonical/live remote agreement, bounded project memory, and convention presence.
2. **Customer authority:** the chat request and fresh approval for one explained action, including any disclosed writes and pointer registration.
3. **Project-native authority:** convention content read by the host only after approved entry. It remains below system, developer, customer, sandbox, and credential rules and never becomes DotAIOS product authority.

If project-native instructions expand the action—for example by asking to install software, access credentials, write outside the project, submit a form, or contact someone—the host stops and asks for new approval. A route does not certify that the project can perform the requested action; it certifies only that the customer registered this exact routable folder.

The handoff boundary is explicit: route resolution stops after returning an inert location and convention inventory. The host adapter, not DotAIOS core, declares which convention kinds it supports. Immediately before handoff it exact-resolves again, then starts or retargets a fresh agent context whose project root is the verified folder. Merely changing the working directory of an already-started context is insufficient. If the host cannot prove a fresh rooted context, it returns manual-open guidance and performs no project-native action.

For Codex, supported project-native entrypoints are `AGENTS.md` and repository skills under `.agents/skills`; a repository exposing only `CLAUDE.md` is generically routable but `unsupported_by_host` for that adapter. Other adapters may declare and test their own native convention support without changing the generic resolver. This matches Codex's native model: it constructs the project `AGENTS.md` chain from the project root toward the working directory, while repository skills are discovered under `.agents/skills` and loaded fully only when selected. See the official OpenAI documentation for [AGENTS.md instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [repository-scoped skills](https://learn.chatgpt.com/docs/build-skills), and the [local project environment](https://learn.chatgpt.com/docs/environments/local-environment).

### 3. Output-pointer interface

The authoritative collection lives at `projects/<slug>/output-pointers.json` in the portable AIOS folder. JSON is deliberate: current Markdown working-context, search, and index readers do not scan it, and only the output-pointer reader may open this exact file. Its envelope is:

| Envelope field | Rule |
| --- | --- |
| `schema` | Exactly `dotaios.output-pointers/v1`. |
| `project_id` | Exact stable ID from the adjacent registered-project frontmatter. |
| `generation` | Non-negative integer incremented once per applied collection change. |
| `pointers` | At most 128 records, stable-stored by pointer ID. The entire serialized UTF-8 envelope is at most 256 KiB. |

Each record contains exactly five fields:

| Record field | Rule |
| --- | --- |
| `id` | Stable generated pointer ID; retained across idempotent add and label update. |
| `kind` | Exactly `project-file` or `project-directory` in v1. |
| `locator` | The normalized, project-relative POSIX resource defined by EPR-008. |
| `label` | Trimmed, NFC Unicode of 1–160 code points; controls and unpaired surrogates are refused. It is inert display data, not an instruction. |
| `recorded_at` | UTC time when the pointer plan was applied; not a claim about target creation time. |

Malformed JSON, unknown or missing keys, wrong schema/project ID, invalid generation, duplicate IDs or deduplication keys, invalid records, or a size/count violation refuses reads and writes without partial results or guessed repair. Storage remains stable by pointer ID; customer-facing list results sort by `recorded_at` descending, then ID.

The public interface is a project-scoped `output` command family:

- `add`: read-only preview by default; apply only the identical proof-bound plan covered by the action approval.
- `list` / `resolve`: read-only, bounded, newest-first summaries with computed availability.
- `remove`: preview/apply removal of the pointer record only.

Project-relative pointers are portable because the absolute root remains in the existing machine-local project mapping. Pointer records remain structured project metadata and must be explicitly excluded from every content corpus. A future route combines the current verified project root with the stored relative locator; it never persists that absolute combination.

Preview records the current generation, SHA-256 digest of the exact collection bytes, operation ID, plan fingerprint, and exact next bytes; the digest protects pointer-store concurrency and never hashes the output target. Apply acquires the existing strict owned-operation lock at `~/.dotaios/output-pointers/locks/<encoded-project-id>.lock`, re-reads the collection, and compare-and-swaps both generation and digest. It then revalidates project identity and target containment/type before publishing through an owner-marked sibling temporary file, file sync, atomic rename, and directory sync. A crash leaves either the old or new valid collection. Retry may remove only the exact dead temporary file owned by its operation while the canonical collection still matches the preview; every ambiguous state refuses recovery.

Availability is computed, not stored. Pointers report `available`, `missing`, `unsafe`, or `project_unavailable`. A missing result is not deleted automatically because the source project may recreate the same durable location. Add and label-update require a currently verified project and target; pointer removal may proceed against valid portable metadata while the machine-local root is unavailable because it never touches the target.

Project ID + kind + normalized locator is the deduplication key. An exact repeat is idempotent and does not increment the generation; a changed label previews an update preserving the ID and setting a new `recorded_at`. Future official project unregistration must refuse while the collection is non-empty and direct the customer to explicit pointer removal first. If registration was removed or corrupted outside that flow, doctor reports the orphaned collection; readers withhold resolved locations, and no command auto-deletes or re-parents it.

Arbitrary off-root filesystem pointers are refused. A future version may admit them only through another independently registered and verified root; this design does not reuse prose or config files as authority for extra write locations.

### 4. Existing envelope composition

| Resolve case | Project route | Project memory / AIOS skill | Tool and existing fields | Location, omissions, next action |
| --- | --- | --- | --- | --- |
| Explicit existing `--tool` | `not_evaluated` (`tool_selector_precedence`) | Existing behavior unchanged | Existing Google result and argv remain byte-for-byte authoritative | Existing semantics unchanged; project files cannot alter them. |
| Implicit unique match | `candidate` | Not evaluated for the candidate | `tool` remains absent | No location. Explain the metadata match, lack of endorsement, action, and approval boundary. |
| Implicit ambiguous / no match | `ambiguous` / `no_match` | Not evaluated | `tool` remains absent | No location; bounded handles only for ambiguity and a clarification next action. |
| Exact supported project | `ready` | Project-only memory and AIOS skill evaluate normally; AIOS skill `no_match` does not suppress the native route | `tool` remains absent | One freshly verified location; omissions and next action state approval plus fresh-context handoff. |
| Exact unsupported / refused | `unsupported_by_host` / `refused` | Not evaluated | `tool` remains absent | No location; manual-open or path-free repair guidance. |

Project-only memory remains the sole bounded memory projection; discovery never loads another project's memory and exact selection never falls back to Shared. The AIOS governing skill stays a separate workflow recommendation, while project-native skills remain outside the AIOS skill corpus. A project route can never create or mutate Google tool fields or argv. The MCP adapter remains read-only and gains neither routing execution nor pointer writes. New route and pointer summaries are additive, hard-bounded fields; existing `project`, `memory`, `skill`, `tool`, `omissions`, `next_action`, `budget`, and `location` meanings remain intact.

## Customer wording and first useful action

Before approval, the host should say:

> I found the `career-ops` folder you connected. Its match comes from your description, “evaluate and track job opportunities,” not an AIOS recommendation. It exposes project instructions this agent supports, but I have not read them or run anything. If you approve, I’ll start a fresh context in that folder for one action: evaluate this role and save its report without applying. I’ll then remember only where the report lives—not copy or index it.

After approval, the host re-resolves the exact project, starts the fresh rooted context, follows its native instructions within the stated boundary, and registers a label such as “Evaluation report — Acme Senior AI Engineer” for the resulting project-relative report. The original approval covers that single constrained pointer because the behavior was disclosed. If the repo cannot perform that action safely, or if the project, kind, scope, or behavior changes, the host stops and asks again rather than improvising product authority.

On success, the host says:

> Done. The report remains in `career-ops` at `<relative location>`. AIOS saved only that location and label; it did not copy or index the report.

If a future lookup finds the pointer stale, the host says:

> AIOS remembers where this result was, but it is not available in the project now. AIOS did not move or delete it.

Career Ops validates a repository with multiple convention forms and project-owned report/data directories. Agent-Reach validates a different repository shape, including a root `CLAUDE.md`, without any product code knowing its name or claimed capabilities. The examples are grounded in their upstream repositories—[Career Ops](https://github.com/santifer/career-ops) and [Agent-Reach](https://github.com/Panniantong/agent-reach)—but only registration metadata and convention presence enter routing tests.

## Testing decisions

The two highest seams are the public read-only intent-resolution command and the public output-pointer preview/apply/list/remove commands. Core tests may exercise their pure contracts, but acceptance is proven at the CLI boundary.

Good tests assert externally visible behavior and forbidden effects:

- two differently shaped fixture repositories route through identical generic code;
- discovery never reads convention bodies or personal-data canaries;
- exact resolution rechecks root, remote, and file identity before the sole location disclosure;
- remote/root replacement, symlink/hardlink/special-file targets, ambiguity, weak matches, and unsafe locators fail closed and path-free;
- filesystem snapshots prove discovery and exact resolution are read-only;
- pointer add is preview-first, proof-bound, idempotent, compare-and-swapped under an owned lock, and stores only the four envelope fields plus five-field records;
- search, index, working-context, Shared-memory, and MCP probes cannot return pointer records or target content;
- missing outputs remain stale pointers, unavailable roots still permit pointer-only removal, and removal never touches targets;
- corruption, duplicate keys, concurrent previews, interrupted publication, foreign locks/temporary files, and unregister-with-pointers all fail closed or recover only exact owned state;
- the existing Google and project-memory contract tests pass unchanged;
- supported-host probes prove a fresh project-root startup loads supported native conventions; a Codex probe refuses a `CLAUDE.md`-only fixture as `unsupported_by_host` rather than pretending it loaded it;
- shipped core and CLI source contain no Career Ops or Agent-Reach identity literals.

Reusable lessons from the superseded local Task 2 branch are the high CLI seam, dependency injection for live-remote and contained-file observation, final root/remote revalidation, path-free race refusals, canary-based no-content tests, and before/after filesystem snapshots. Its curated card, `--capability` selector, repository constants, and product-owned outcome prose are explicitly rejected.

## Ticket order

1. [Generic project-native routing](tickets/01-generic-project-native-routing.md) — the smallest tracer bullet and the first fresh task.
2. [Authoritative output-pointer store](tickets/02-authoritative-output-pointer-store.md) — adds the bounded pointer authority and lifecycle after Ticket 01 lands.
3. [Output-pointer CLI and router return path](tickets/03-output-pointer-cli-return-path.md) — composes the store into the approved customer loop.

## Remaining boundary

No design question blocks the tracer bullet. The explicit boundary is host integration: DotAIOS can match and freshly resolve a folder, but only a host adapter can start a new context rooted there, prove it supports an observed convention, perform the approved action, and report the resulting locator. Merely changing directories in the current run does not cross that boundary. The product cannot claim universal host support; each supported adapter needs an acceptance probe, and unsupported combinations stop with manual-open guidance.

## Out of scope

- Repository marketplace, curated catalog, recommendation list, installer, updater, package manager, or trust score.
- Hosted execution gateway, universal command wrapper, shell/argv registry, credential broker, or sandbox claim.
- Treating external prose as commands, capability claims, approval, product policy, or registration metadata.
- Copying, importing, summarizing, indexing, embedding, hashing, searching, or taking ownership of output content.
- Arbitrary off-root local output paths without a separately registered root.
- Automatic submissions, messages, purchases, applications, or other irreversible actions.
- Bundling the future commercial automation package described by the owner.
- npm publication, dist-tag promotion, Git tag, GitHub Release, push, or PR creation.
