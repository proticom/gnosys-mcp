# gnosys backup

Create a backup of the central Gnosys database and related files.

## Usage

```bash
gnosys backup
gnosys backup --output ./backups
gnosys backup --to ./backups
gnosys backup --json
```

## Options

| Option | Description |
|--------|-------------|
| `-o, --output <dir>` | Backup output directory (default: `~/.gnosys/`) |
| `--to <dir>` | Alias for `--output` |
| `--json` | Output result as JSON |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Calls `centralDb.backup(outputDir)` where `outputDir` is `--to` or `--output` if set.
3. Collects memory and project counts from the central DB.
4. Copies `sandbox/sandbox.log` to `sandbox.log.bak` in the backup directory when the log exists.
5. Prints human-readable success output or JSON.
6. Closes the central DB in `finally`.

## Output modes

**Human** (default):

```text
Backup created: /path/to/backup.db
  Memories: 42 (40 active, 2 archived)
  Projects: 3
  Additional files: 1
```

**JSON** (`--json`):

```json
{
  "ok": true,
  "backupPath": "/path/to/backup.db",
  "memories": 42,
  "active": 40,
  "archived": 2,
  "projects": 3,
  "files": ["/path/to/backup.db", "/path/to/sandbox.log.bak"]
}
```

## Errors

Central DB unavailable:

```text
Central DB not available (better-sqlite3 missing).
```

Backup failure (human):

```text
Backup failed: <message>
```

Backup failure (JSON):

```json
{ "ok": false, "error": "<message>" }
```

Failure paths set `process.exitCode = 1` and return through `finally` so the DB handle is closed.

## Validation

```bash
cd gnosys-public
npm run cli -- backup --help
npx vitest run src/test/backup-command-handler.test.ts
```

## Related commands

- `gnosys restore` — restore from a backup file.
- `gnosys sync` — remote sync of the central DB.
