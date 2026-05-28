# gnosys traverse

Traverse relationship chains starting from a memory using BFS with a depth limit.

## Usage

```bash
gnosys traverse mem-abc123
gnosys traverse mem-abc123 --depth 5 --rel-types leads_to,requires
gnosys traverse mem-abc123 --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `memoryId` | Starting memory ID for the traversal |

## Options

| Option | Description |
|--------|-------------|
| `-d, --depth <n>` | Maximum traversal depth (default `3`, max `10`) |
| `--rel-types <types>` | Comma-separated relationship types to follow (e.g. `leads_to,requires`) |
| `--json` | Output traversal result as JSON |

## Prerequisites

Requires the central Gnosys database with `better-sqlite3` available.

## Request mapping

- `id` — memory ID argument
- `depth` — parsed from `--depth` or default `3`
- `rel_types` — split/trim from `--rel-types` when set

Sent via `handleRequest` with `id: "cli-traverse"` and `method: "traverse"`.

## Human output

```text
Traversal from mem-abc123 (depth: 3):
  Total nodes: 5

  mem-abc123: Root memory (conf: 0.85) (root)
    mem-def456: Related step (conf: 0.72) ← [leads_to] from mem-abc123
```

## JSON output

Success returns the sandbox traversal result object.

On failure with `--json`:

```json
{
  "ok": false,
  "error": "error message"
}
```

## Errors

- Missing DB driver: install message then exit 1.
- Sandbox error: JSON or `Traverse failed: ...`, then exit 1.
- DB is closed in `finally` even when errors occur.

## Validation

```bash
cd gnosys-public
npm run cli -- traverse --help
npx vitest run src/test/traverse-command-handler.test.ts
```

## Related commands

- `gnosys trace` — create procedural memories from code.
- `gnosys reflect` — record outcomes linked to memories.
