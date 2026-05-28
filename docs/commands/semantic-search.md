# gnosys semantic-search

Search using semantic similarity only (requires embeddings).

## Usage

```bash
gnosys semantic-search "auth tokens"
gnosys semantic-search "auth tokens" --limit 5
gnosys semantic-search "auth tokens" --json
```

## Options

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Max results (default `15`) |
| `--json` | Output results as JSON |

## Behavior

1. Resolves stores via the resolver; exits if none (`No stores found.`).
2. Builds a fresh `GnosysSearch` index from all stores.
3. Loads `GnosysEmbeddings` and `GnosysHybridSearch`.
4. Runs semantic-only search: `hybridSearch(query, limit, "semantic")`.
5. Closes search and embeddings handles.

## Embedding prerequisites

Semantic search requires embeddings. If none exist:

```text
No semantic results for "<query>". Run gnosys reindex first.
```

Run `gnosys reindex` to build embeddings before using this command.

## Human output

On success, prints title, path, similarity score, and snippet preview for each result.

## JSON output

With `--json`:

```json
{
  "query": "...",
  "count": 3,
  "results": [
    { "title": "...", "relativePath": "...", "score": 0.92, "snippet": "..." }
  ]
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- semantic-search --help
```

## Related commands

- `gnosys hybrid-search` — keyword + semantic fusion (RRF).
- `gnosys reindex` — build/update embeddings.
