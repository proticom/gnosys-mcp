# Search Modes

Gnosys offers three retrieval modes. All search across project, user, and global memory stores (subject to scope filters when configured).

| Mode | Tool | Mechanism | Needs embeddings | Best for | Misses |
|------|------|-----------|------------------|----------|--------|
| Keyword | `gnosys_search` | SQLite FTS5 exact/stemmed term match | No | Known terms, IDs, code symbols; fast and always available | Synonyms and paraphrases with no shared tokens |
| Semantic | `gnosys_semantic_search` | Embedding cosine similarity only (no keyword ranking) | Yes — run `gnosys_reindex` first | Conceptual or paraphrased queries with no exact keyword overlap | Exact rare tokens that embeddings under-weight |
| Hybrid | `gnosys_hybrid_search` | Reciprocal Rank Fusion (k=60) of keyword + semantic rankings | Yes — run `gnosys_reindex` first | General default when embeddings exist — balances precision and recall | Slightly slower than keyword-only; requires indexed embeddings |

## Reciprocal Rank Fusion (hybrid)

Hybrid mode combines keyword and semantic result lists using **Reciprocal Rank Fusion** (Cormack et al., 2009), with `RRF_K = 60`:

```
score(d) = Σ  1 / (k + rank_i(d))
```

The sum runs over each ranking list *i* (keyword FTS and semantic similarity). A memory ranked high by **either** list surfaces in the fused results; memories that rank well in **both** lists score highest.

When embeddings are not available, hybrid mode downgrades to keyword-only (semantic mode returns empty).

## Same-query example

**Query:** `how do we cache tokens`

| Mode | Typical results |
|------|-----------------|
| **Keyword** (`gnosys_search`) | Memories whose title, content, or tags literally contain *cache*, *token*, or stemmed variants. |
| **Semantic** (`gnosys_semantic_search`) | Also surfaces conceptually related memories — e.g. one titled "Redis session storage" — even when those exact words do not appear in the query. |
| **Hybrid** (`gnosys_hybrid_search`) | Fuses both lists: literal cache/token hits **plus** the conceptually related session-storage memory, with the strongest overlap ranked first. |

## Choosing a mode

- **Default to hybrid** when embeddings are indexed (`gnosys_reindex` has been run). This is the best general-purpose mode.
- **Use keyword** when embeddings are unavailable, when you need the fastest response, or when searching for exact identifiers, file paths, or code symbols.
- **Use semantic** for exploratory recall — finding memories about a *concept* when you do not know which keywords the author used.

## CLI equivalents

The same three modes are available from the command line:

```bash
gnosys search "query"              # keyword (FTS5)
gnosys semantic-search "query"     # semantic only
gnosys hybrid-search "query"       # RRF fusion (default when embeddings exist)
```

All three support `--json` for machine-readable output.
