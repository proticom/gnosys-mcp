# gnosys reindex

Rebuild semantic embeddings for every memory in configured stores.

## Usage

```bash
gnosys reindex
```

Run after bulk imports, schema changes, or when hybrid/semantic search returns poor matches.

## Behavior

1. Resolves configured stores via the project resolver.
2. Clears the local search index for the primary store path.
3. Re-adds memories from all configured stores to the search index.
4. Loads `GnosysEmbeddings` and `GnosysHybridSearch`.
5. Builds semantic embeddings for all indexed memories.

On first run, downloads the `all-MiniLM-L6-v2` embedding model (~80 MB).

## Progress output

While indexing:

```text
Building semantic embeddings (downloading model on first run)...
  Indexing: 12/240 — memories/architecture/decisions.md
```

## Completion output

```text
Reindex complete: 240 memories embedded.
Hybrid and semantic search are now available.
```

## Errors

No stores configured:

```text
No stores found. Run gnosys init first.
```

Exits with code 1.

## Resource cleanup

Always closes the search index and embedding resources in a `finally` block, including when indexing fails.

## Validation

```bash
cd gnosys-public
npm run cli -- reindex --help
npx vitest run src/test/reindex-command-handler.test.ts
```

## Related commands

- `gnosys hybrid-search` — hybrid keyword + semantic search (requires embeddings).
- `gnosys semantic-search` — semantic-only search (requires embeddings).
- `gnosys import` — bulk import memories before reindexing.
