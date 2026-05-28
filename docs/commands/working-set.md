# gnosys working-set

Show the implicit working set — recently modified memories for the current project.

## Usage

```bash
gnosys working-set
gnosys working-set --directory /path/to/project
gnosys working-set --window 72 --json
```

## Options

| Option | Description |
|--------|-------------|
| `-d, --directory <dir>` | Project directory used for project detection |
| `-w, --window <hours>` | Lookback window in hours (default `24`) |
| `--json` | Output machine-readable JSON |

## Behavior

1. Opens central DB; exits if unavailable (`Central DB not available.`).
2. Detects current project via `--directory` when provided.
3. Exits if no project detected (`No project detected.`).
4. Calls `getWorkingSet` with parsed window hours.
5. Outputs formatted text via `formatWorkingSet` or JSON.
6. Closes central DB in `finally`.

## JSON output

```json
{
  "projectId": "...",
  "windowHours": 24,
  "count": 5,
  "memories": [
    { "id": "...", "title": "...", "category": "...", "modified": "..." }
  ]
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- working-set --help
```

## Related commands

- `gnosys discover` — keyword discovery across memories.
- `gnosys read` — read a specific memory from the working set.
