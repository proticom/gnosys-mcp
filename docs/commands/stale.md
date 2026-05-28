# gnosys stale

Find memories not modified or reviewed within a threshold.

## Usage

```bash
gnosys stale
gnosys stale --days 180 --limit 50
```

## Options

| Option | Description |
|--------|-------------|
| `-d, --days <number>` | Days threshold (default `90`) |
| `-n, --limit <number>` | Maximum results (default `20`) |

## Behavior

1. Resolves memories via `getResolver().getAllMemories()`.
2. Computes a cutoff date from `--days` (today minus N days, ISO date string).
3. Filters memories where `last_reviewed` (if present) or `modified` is before the cutoff.
4. Sorts oldest first via `localeCompare` on the same last-touched field.
5. Limits results to `--limit`.

## Output

No matches:

```text
No memories older than 90 days.
```

Matches:

```text
3 memories not touched in 90+ days:

  Memory Title
  project:path/to/memory.md
  Modified: 2025-01-01, Reviewed: 2025-01-15
```

## Validation

```bash
cd gnosys-public
npm run cli -- stale --help
```

## Related commands

- `gnosys maintain` — broader memory maintenance workflows.
- `gnosys list` — list all active memories.
