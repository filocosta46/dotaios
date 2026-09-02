# Memory-System Pattern Study — Foundation Relevance

Date: 2026-08-09
Status: primary-source research synthesis for product decisions; not an implementation plan

## Research receipt

The bounded six-lane research run covered Graphiti, Cognee, Mem0, MemOS, Hindsight, OpenViking, and heavyweight graph/RAG counterexamples. Its final automated synthesis failed, but the cited raw findings were preserved at:

`<aios>/vault/research/deep/2026-08-09-as-of-august-2026-which-concrete-patterns-from-graphiti-cogn.md`

This note manually normalizes those findings. Product claims below are intentionally narrower than vendor benchmark claims.

## Import concepts, not platforms

| Source pattern | User job served | DotAIOS-shaped import | What Foundation should not import |
|---|---|---|---|
| Graphiti: raw episodes remain linked to temporal facts; event time and ingestion time are distinct. | Understand what was true, when, and where the claim came from. | Keep the original plain file; expose a stable source path plus explicit observed/effective timestamps where the source supplies them. | Neo4j/FalkorDB, default LLM extraction, graph maintenance, telemetry, or automatic fact authority. |
| Cognee: retrieval mode is explicit and `only_context` exposes evidence without generating an answer. | Inspect what the memory layer actually returned. | Make startup-context selection deterministic and inspectable; return candidates, admission decisions, provenance, and omission reasons separately from agent prose. | A rule matrix spanning graph/vector/Cypher/LLM modes or a permanent knowledge-graph ingest pipeline. |
| Mem0: entity scopes and append-only extraction make memory boundaries explicit. | Avoid retrieving another user, agent, app, run, or project's context. | Preserve current project/domain filters and make missing or unattributed scope visible. Keep session/source evidence append-only until explicit promotion. | Hidden LLM fact distillation, cloud-only temporal features, or vendor benchmark results as proof of local OSS behavior. |
| MemOS: memory lifecycle, provenance, snapshots, and rollback are modeled explicitly. | Know whether material is current, archived, superseded, or recoverable. | Use explicit promotion/archive/restore receipts and Git-backed recovery; add only lifecycle states that correspond to a measured user failure. | An operating system for textual, KV-cache, and model-parameter memory; Neo4j/Qdrant/scheduler infrastructure. |
| Hindsight: stable document IDs, content hashes, source chunks, timestamps, and debug traces. | Revisit a source folder without duplicating it or losing source lineage. | A rebuildable source manifest may record stable source identity, content hash, last-seen state, and source path. Any selected excerpt must point back to the canonical file. | Automatic fact extraction, database deletion semantics, service ports, provider keys, or a derived document store as canonical truth. |
| OpenViking: L0/L1/L2 progressive disclosure, context/skill/tool traces, provenance, score, and match reason. | Pay for a small summary first and expand only when relevant; understand why an item matched. | Preserve the real folder UX. Add deterministic summary/detail levels only when their generation and staleness contract can be proven. Expose match reason and provenance in retrieval evidence. | `viking://` virtual authority, a required server/model pipeline, or any copied AGPL implementation. Concepts require clean-room design and citations. |

## Evaluation patterns worth importing

Vendor benchmark scores are not Foundation acceptance evidence. The transferable pattern is the evaluation shape:

1. Seed a privacy-safe user job with a known answer and source.
2. Run the exact production retrieval or context path.
3. Record whether the expected evidence was offered, admitted, and rendered.
4. Record source/provenance visibility, context bytes, latency, deterministic repeatability, and omission reason.
5. Keep answer generation outside the core verdict where possible; first prove that the correct evidence was made available.
6. Re-run the same fixture on the independent validation host.

The current product does not yet satisfy this bar: its metrics count searches but leave `p_at_5` explicitly null, and working-context tests prove the hard size ceiling rather than task recall.

## Complexity counterexamples

- GraphRAG requires a multi-stage LLM indexing pipeline and warns that indexing is expensive and prompt tuning is often necessary.
- LightRAG still requires four storage classes and exposes a server/auth/provider surface for production.
- RAGFlow is a multi-service application stack with substantial compute, storage, identity, and secret configuration.
- KAG targets schema-constrained professional knowledge reasoning, not a nonexpert's portable personal folder.

These systems may solve different jobs. They are evidence against importing a graph/vector/server stack before the local lexical and bounded-context baseline fails a representative Foundation fixture.

## Foundation decision pressure

The strongest release-shaped contract is not “remember everything.” It is:

> For a named task, surface the smallest relevant slice of canonical user-owned evidence, show where it came from, state what was omitted, and allow explicit expansion without turning a derived index into authority.

This is compatible with the local Matt Van Horn / Lauren Tan foundation:

- keep push context scarce and decision-relevant;
- pull deeper evidence on demand;
- move repeatable skill-bound lessons into skills;
- require verification artifacts before trusting autonomous continuation.

## Primary sources

- Graphiti: [overview](https://help.getzep.com/graphiti/getting-started/overview), [episodes](https://help.getzep.com/graphiti/core-concepts/adding-episodes.mdx), [search](https://help.getzep.com/graphiti/working-with-data/searching), [paper](https://arxiv.org/html/2501.13956v1)
- Cognee: [remember](https://docs.cognee.ai/core-concepts/main-operations/remember), [recall](https://docs.cognee.ai/core-concepts/main-operations/recall), [search modes](https://docs.cognee.ai/python-api/search-type), [evaluation](https://docs.cognee.ai/integrations/eval-framework)
- Mem0: [memory evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation), [entity scope](https://docs.mem0.ai/platform/features/entity-scoped-memory), [benchmark repository](https://github.com/mem0ai/memory-benchmarks)
- MemOS: [paper](https://arxiv.org/abs/2507.03724v4), [repository](https://github.com/MemTensor/MemOS)
- Hindsight: [retain](https://hindsight.vectorize.io/developer/api/retain), [recall](https://hindsight.vectorize.io/developer/api/recall), [documents](https://hindsight.vectorize.io/developer/api/documents)
- OpenViking: [retrieval](https://docs.openviking.ai/en/api/06-retrieval), [session](https://docs.openviking.ai/en/concepts/08-session), [repository and license](https://github.com/volcengine/OpenViking)
- Counterexamples: [GraphRAG architecture](https://microsoft.github.io/graphrag/index/architecture/), [LightRAG](https://github.com/HKUDS/LightRAG), [RAGFlow](https://github.com/infiniflow/ragflow), [KAG](https://github.com/OpenSPG/KAG)
