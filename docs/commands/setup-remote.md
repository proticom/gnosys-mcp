# gnosys setup remote

Configure the remote database path used for multi-machine sync. This is the **parent** configure command — not the leaf sync subcommands.

## Usage

```bash
gnosys setup remote
gnosys setup remote --path /path/to/remote
```

## Options

| Option | Description |
|--------|-------------|
| `--path <path>` | Set remote path directly (non-interactive) |

## Behavior

1. Opens the local DB via `GnosysDB.openLocal()`.
2. With `--path`: calls `configureFromPath(db, path)`.
3. Without `--path`: runs the interactive `runConfigureWizard(db)`.

## Related leaf commands

These are separate commands with their own docs/tasks:

- `gnosys setup remote status` — sync status
- `gnosys setup remote push` — push local changes
- `gnosys setup remote pull` — pull remote changes
- `gnosys setup remote sync` — bidirectional sync
- `gnosys setup remote resolve` — resolve conflicts

## Errors

Central DB unavailable:

```text
Central DB not available.
```

Failure sets `process.exitCode = 1` and returns through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- setup remote --help
npx vitest run src/test/setup-remote-command-handler.test.ts
```

## Related commands

- `gnosys status --remote` — quick remote status alias
- `gnosys setup sync-projects` — regenerate project rules after sync setup
