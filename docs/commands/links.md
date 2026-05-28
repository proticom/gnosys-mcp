# gnosys links

Show outgoing wikilinks and backlinks for a memory.

## Usage

```bash
gnosys links decisions/auth-decision.md
gnosys links project:decisions/auth-decision.md --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `memoryPath` | Memory path or resolver-supported memory identifier to inspect |

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output JSON |

## Behavior

1. Reads the target memory with `resolver.readMemory(memoryPath)`.
2. Exits with `Memory not found: <memoryPath>` when the memory cannot be resolved.
3. Loads all memories with `resolver.getAllMemories()`.
4. Computes outgoing links with `getOutgoingLinks(allMemories, memory.relativePath)`.
5. Computes backlinks with `getBacklinks(allMemories, memory.relativePath)`.
6. Prints human-readable sections or JSON.

## Human output

```text
Links for Auth Decision:

  Outgoing (2):
    → [[Other Memory]] (display text)

  Backlinks (1):
    ← Source Title (path/to/source.md)
```

Empty sections print `No outgoing links.` or `No backlinks.`

## JSON output

```json
{
  "memoryPath": "decisions/auth-decision.md",
  "title": "Auth Decision",
  "outgoing": [],
  "backlinks": []
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- links --help
```

## Related commands

- `gnosys graph` — wikilink graph across all memories.
- `gnosys read` — read a memory before inspecting its links.
