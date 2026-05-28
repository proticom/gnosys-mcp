# gnosys trace

Trace a codebase and store procedural "how" memories with call-chain relationships in the central Gnosys database.

## Usage

```bash
gnosys trace ./src
gnosys trace ./src --max-files 1000 --project-id my-project
gnosys trace ./src --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `directory` | Root directory of the codebase to scan |

## Options

| Option | Description |
|--------|-------------|
| `--max-files <n>` | Maximum source files to scan (default `500`) |
| `--project-id <id>` | Project ID to associate created memories with |
| `--json` | Output trace result as JSON |

## Prerequisites

Requires the central Gnosys database with `better-sqlite3` available. If the DB driver is missing, the command exits with an error.

## Behavior

1. Opens the central DB via `GnosysDB.getCentralDbDir()`.
2. Verifies DB availability (`better-sqlite3` installed).
3. Runs `traceCodebase` on the given directory with optional `projectId` and `maxFiles`.
4. Closes the DB in a `finally` block even when tracing throws.
5. Prints human summary or JSON result.

## Human output

```text
Trace complete:
  Files scanned:        42
  Functions found:       128
  Memories created:      95
  Relationships created: 210
```

## JSON output

Success returns the `traceCodebase` result object (files scanned, functions found, memory IDs, etc.).

On failure with `--json`:

```json
{
  "ok": false,
  "error": "error message"
}
```

## Errors

- Missing DB driver: `Error: GnosysDB not available. Install it with: npm install better-sqlite3` then exit 1.
- Trace failure: `Trace failed: ...` on stderr (human) or JSON error object, then exit 1.

## Validation

```bash
cd gnosys-public
npm run cli -- trace --help
npx vitest run src/test/trace-command-handler.test.ts
```

## Related commands

- `gnosys reflect` — reflect on outcomes linked to traced memories.
- `gnosys traverse` — walk memory relationship chains.
