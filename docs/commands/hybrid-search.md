# gnosys hybrid-search

Search using hybrid keyword and semantic fusion (RRF).

## Usage

```bash
gnosys hybrid-search "auth tokens"
gnosys hybrid-search "auth tokens" --mode keyword
gnosys hybrid-search "auth tokens" --mode semantic
gnosys hybrid-search "auth tokens" --federated --scope project,user
gnosys hybrid-search "auth tokens" --json
```

## Options

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Max results (default `15`) |
| `-m, --mode <mode>` | Search mode: `keyword`, `semantic`, or `hybrid` (default `hybrid`) |
| `--json` | Output results as JSON |
| `--federated` | Federated search with tier boosting (project > user > global) |
| `--scope <scope>` | Filter scopes: `project`, `user`, `global` (comma-separated) |
| `-d, --directory <dir>` | Project directory for context detection |

## Federated / scope path

When `--federated` or `--scope` is set:

1. Opens central DB; exits if unavailable (`Central DB not available.`).
2. Calls `federatedSearch` with project detection and scope filter.
3. Human output includes title, category, scope, score, boosts, and snippet preview.

No results:

```text
No results for "<query>".
```

## Local hybrid path (default)

When not using federated/scope:

1. Resolves stores via the resolver; exits if none (`No stores found.`).
2. Builds a fresh `GnosysSearch` index from all stores.
3. Loads `GnosysEmbeddings` and `GnosysHybridSearch`.
4. Runs `hybridSearch(query, limit, mode)` for keyword, semantic, or hybrid fusion.

No results:

```text
No results for "<query>". Try gnosys reindex to build embeddings.
```

Successful results print title, path, fused score, sources, and snippet preview.

### Reinforcement

After results are returned, best-effort `GnosysMaintenanceEngine.reinforceBatch` runs on result paths when a writable store exists.

### Cleanup

Always calls `search.close()` and `embeddings.close()`.

## Embedding prerequisites

Semantic and hybrid modes require embeddings. Run `gnosys reindex` if searches return empty or embeddings are missing.

## JSON output

With `--json`, output includes query, mode, count, and result objects. Federated mode adds `projectId` and `mode: "federated"`.

## Validation

```bash
cd gnosys-public
npm run cli -- hybrid-search --help
```

## Related commands

- `gnosys search` — FTS search without semantic fusion.
- `gnosys semantic-search` — semantic-only search.
- `gnosys reindex` — build/update embeddings for hybrid search.
