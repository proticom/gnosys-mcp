# gnosys timeline

Show when memories were created and modified over time.

## Usage

```bash
gnosys timeline
gnosys timeline --period week --limit-titles 10
gnosys timeline --project proj-001 --json
```

## Options

| Option | Description |
|--------|-------------|
| `-p, --period <period>` | Group by `day`, `week`, `month` (default), or `year` |
| `--project <id>` | Filter to a specific project ID (default: all active memories) |
| `--limit-titles <n>` | Show titles inline when an entry has <= N memories (default `5`) |
| `--json` | Output machine-readable JSON |

## Behavior

1. Opens central DB; exits with `Central DB unavailable.` if unavailable.
2. Loads memories via `getMemoriesByProject(project)` when `--project` is set, otherwise `getActiveMemories()`.
3. Groups results with `groupDbByPeriod` using the selected period.
4. Parses `--limit-titles` with `parseInt(..., 10) || 5` (minimum 0).
5. Closes DB in `finally`.

## Empty output

When no memories match:

```text
No memories found.
```

JSON:

```json
{
  "period": "month",
  "count": 0,
  "entries": []
}
```

## Human output

```text
Knowledge Timeline (by month, 42 memories):

  2026-01: 3 created, 5 modified
    + Memory title one
    + Memory title two
```

Titles print only when an entry has at most `--limit-titles` memories.

## JSON output

```json
{
  "period": "month",
  "count": 42,
  "entries": []
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- timeline --help
npx vitest run src/test/timeline-command-handler.test.ts
```

## Related commands

- `gnosys stats` — summary statistics for the memory store.
- `gnosys history` — audit history for a single memory.
