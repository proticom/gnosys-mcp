# gnosys reflect

Reflect on an outcome to update memory confidence and create relationships in the central Gnosys database.

## Usage

```bash
gnosys reflect "deploy succeeded"
gnosys reflect "auth refactor failed" --failure --memory-ids mem-1,mem-2
gnosys reflect "hotfix shipped" --notes "rolled back within 10 minutes" --confidence-delta 0.15 --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `outcome` | Short description of what happened |

## Options

| Option | Description |
|--------|-------------|
| `--memory-ids <ids>` | Comma-separated memory IDs to relate to the outcome |
| `--failure` | Mark the outcome as failure (default: success) |
| `--notes <text>` | Additional reflection notes |
| `--confidence-delta <n>` | Custom confidence delta (e.g. `0.1` or `-0.2`) |
| `--json` | Output reflection result as JSON |

## Prerequisites

Requires the central Gnosys database with `better-sqlite3` available.

## Request mapping

The handler builds sandbox params:

- `outcome` — from positional argument
- `success` — `!opts.failure`
- `memory_ids` — split/trim from `--memory-ids` when set
- `notes` — from `--notes` when set
- `confidence_delta` — parsed float from `--confidence-delta` when set

Sent via `handleRequest` with `id: "cli-reflect"` and `method: "reflect"`.

## Human output

```text
Reflection recorded:
  ID:                    refl-abc123
  Outcome:               deploy succeeded
  Memories updated:      2
  Relationships created: 3
  Confidence delta:      +0.10
```

## JSON output

Success emits the sandbox result object via `JSON.stringify(result, null, 2)`.

On failure with `--json`:

```json
{
  "ok": false,
  "error": "error message"
}
```

## Errors

- Missing DB driver: install message then exit 1.
- Sandbox error: `Reflect failed: ...` then exit 1.
- Unexpected exception: JSON or human error, then exit 1.

DB is closed in `finally` even when errors occur.

## Validation

```bash
cd gnosys-public
npm run cli -- reflect --help
npx vitest run src/test/reflect-command-handler.test.ts
```

## Related commands

- `gnosys trace` — create procedural memories from a codebase.
- `gnosys traverse` — walk relationship chains from a memory.
