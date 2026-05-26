# ADR-0003: Why Not RAG

- Status: Accepted
- Date: 2026-03-04
- Memory: dec-001

## Context

Retrieval-augmented generation (RAG) — embeddings plus vector similarity — is the default pattern for LLM memory systems. Gnosys needed a retrieval model that matches how agents actually reason about tasks, without the operational cost of vector pipelines.

## Decision

Gnosys does not use RAG. The LLM reads a manifest (and uses keyword/FTS search) and reasons about what to retrieve for the current task.

## Consequences

- Task-relevant retrieval can combine semantically distant but logically related memories (e.g., auth doc plus error-handling conventions during a login bug).
- No vector database, embedding pipeline, or reindex churn for core retrieval — filesystem/DB plus FTS5 suffices.
- Manifests and search results are human-debuggable; similarity scores are not a black box.
- Trade-off: no fuzzy semantic matching by default (mitigated by FTS5 and hybrid search where enabled).
- The LLM spends tokens choosing what to read, but research and practice show retrieval method dominates memory quality more than write strategy.
