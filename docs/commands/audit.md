# gnosys audit

View the structured audit trail of memory operations from the central DB.

## Usage

```bash
gnosys audit
gnosys audit --days 30
gnosys audit --operation write
gnosys audit --limit 50
gnosys audit --json
```

## Options

| Option | Description |
|--------|-------------|
| `--days <n>` | Show entries from the last N days (default: 7) |
| `--operation <op>` | Filter by operation type (`read`, `write`, `recall`, `dream_*`, etc.) |
| `--limit <n>` | Maximum entries to return |
| `--json` | Output raw JSON instead of formatted timeline |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Reads audit entries with `readAuditFromDb(centralDb, { days, operation, limit })`.
3. Prints `formatAuditTimeline(entries)` or JSON.
4. Closes central DB in `finally`.

## Output modes

**Formatted timeline** (default): human-readable operation history.

**JSON** (`--json`): raw entry array via `JSON.stringify(entries, null, 2)`.

## Errors

Central DB unavailable:

```text
Central DB unavailable.
```

Exits with code 1 via `process.exitCode` after closing the DB handle in `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- audit --help
npx vitest run src/test/audit-command-handler.test.ts
```

## Related commands

- `gnosys history` — per-memory change history.
- `gnosys dream log` — dream run audit subset.
- `gnosys sync` — push/pull central DB including audit entries.
