# gnosys reindex-graph

Build or rebuild the wikilink graph (`.gnosys/graph.json`).

## Usage

```bash
gnosys reindex-graph
```

Run after bulk imports, link edits, or when graph navigation feels stale.

## Behavior

1. Resolves configured stores via the project resolver.
2. Calls `reindexGraph(resolver, onLog)` to scan memories and rebuild graph links.
3. Prints progress messages from the graph indexer.
4. Prints a blank line, then formatted stats via `formatGraphStats(stats)`.

## Output

Progress logs during indexing, then a summary such as:

```text
Graph reindex complete.

Nodes: 120
Edges: 340
...
```

## Errors

No stores configured:

```text
No Gnosys stores found. Run gnosys init first.
```

Exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- reindex-graph --help
npx vitest run src/test/reindex-graph-command-handler.test.ts
```

## Related commands

- `gnosys graph` — inspect the current graph.
- `gnosys reindex` — rebuild semantic embeddings (separate from graph links).
- `gnosys init` — register a project store before reindexing.
