# gnosys restore

Restore the central Gnosys database from a backup file.

## Usage

```bash
gnosys restore ./gnosys-backup-20260528.db
gnosys restore backup-placeholder --from ./gnosys-backup-20260528.db
gnosys restore ./gnosys-backup-20260528.db --json
```

## Options

| Option | Description |
|--------|-------------|
| `--from <file>` | Backup file to restore from (overrides positional `<backupFile>`) |
| `--json` | Output result as JSON |

## Behavior

1. Resolves the backup path: `path.resolve(opts.from || backupFile)`.
2. Calls `GnosysDB.restore(resolved)` to replace the central DB from the backup.
3. Reads memory and project counts from the restored DB.
4. Prints human-readable success output or JSON.
5. Closes the restored DB handle in `finally`.

## Output modes

**Human** (default):

```text
Database restored from /path/to/backup.db
  Memories: 42 (40 active, 2 archived)
  Projects: 3
```

**JSON** (`--json`):

```json
{
  "ok": true,
  "source": "/path/to/backup.db",
  "memories": 42,
  "active": 40,
  "archived": 2,
  "projects": 3
}
```

## Errors

Restore failure (human):

```text
Restore failed: <message>
```

Restore failure (JSON):

```json
{ "ok": false, "error": "<message>" }
```

Failure paths set `process.exitCode = 1` and return through `finally` so the DB handle is closed.

## Validation

```bash
cd gnosys-public
npm run cli -- restore --help
npx vitest run src/test/restore-command-handler.test.ts
```

## Related commands

- `gnosys backup` — create a central DB backup.
- `gnosys sync` — remote sync of the central DB.
