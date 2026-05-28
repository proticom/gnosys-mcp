# gnosys history

Show audit history for a memory.

## Usage

```bash
gnosys history mem-001
gnosys history mem-001 --limit 50 --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `memoryPath` | Memory path or ID to inspect |

## Options

| Option | Description |
|--------|-------------|
| `-n, --limit <number>` | Max audit entries (default `20`) |
| `--json` | Output machine-readable JSON |

## Behavior

1. Opens central DB; exits with `Central DB not available.` if unavailable.
2. Looks up memory via `getMemory(memoryPath)`.
3. Exits with `Memory not found: <memoryPath>` when not found.
4. Fetches audit log with `getAuditLog(id, limit)`.
5. Closes DB in `finally`.

## Human output

No history:

```text
Memory: Title (mem-001)
Created: 2026-01-01
Modified: 2026-02-01
No audit history recorded.
```

With entries:

```text
History for Title (mem-001, 3 entries):

Created: 2026-01-01
Modified: 2026-02-01

  2026-02-01  update (details)
```

## JSON output

```json
{
  "memoryId": "mem-001",
  "title": "Title",
  "created": "2026-01-01",
  "modified": "2026-02-01",
  "entries": []
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- history --help
```

## Related commands

- `gnosys audit` — broader audit operations.
- `gnosys read` — read current memory content.
