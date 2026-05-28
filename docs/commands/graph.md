# gnosys graph

Show the wikilink cross-reference graph across all memories.

## Usage

```bash
gnosys graph
gnosys graph --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output machine-readable JSON |

## Behavior

1. Opens central DB (`~/.gnosys/gnosys.db`); exits if unavailable:

   ```text
   Central DB not available.
   ```

2. Loads all memories with `getAllMemories()`.
3. When empty, outputs `No memories found.` (human) or `{ totalLinks: 0, orphanedLinks: [], nodes: [] }` (JSON).
4. Adapts DB rows to the legacy memory shape expected by `buildLinkGraph` (including tag JSON parse fallback).
5. Builds the link graph and prints `formatGraphSummary` or JSON.
6. Closes central DB in `finally`.

## JSON output

```json
{
  "totalLinks": 12,
  "orphanedLinks": [
    {
      "target": "Missing Memory",
      "displayText": null,
      "sourcePath": "decisions/source.md",
      "sourceTitle": "Source Memory"
    }
  ],
  "nodes": []
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- graph --help
```

## Related commands

- `gnosys links` — outgoing/backlinks for a single memory.
- `gnosys list` — list memories that may participate in the graph.
