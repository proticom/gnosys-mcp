# gnosys migrate

Interactively migrate a `.gnosys/` store to a new directory. Moves files, updates project identity, optionally syncs to the central DB, and can remove the old store.

## Usage

```bash
gnosys migrate
gnosys migrate --from /old/project --to /new/project --name "New Project" --yes
```

## Options

| Option | Description |
|--------|-------------|
| `--from <dir>` | Source directory containing `.gnosys/` (skips prompt) |
| `--to <dir>` | Target directory where `.gnosys/` should live (skips prompt) |
| `--name <name>` | New project name (skips prompt; default: basename of target) |
| `--yes` | Skip all confirmation prompts (non-interactive mode) |

## Interactive flow

1. Resolve source directory (auto-detect from cwd or prompt).
2. Verify `.gnosys/` exists and show memory file count.
3. Resolve target directory and project name.
4. Ask whether to sync memories to central DB and delete the old store (defaults yes).
5. Show summary and confirm before proceeding.

With `--yes`, sync and delete default to yes; name defaults to target basename.

## Behavior

- Validates source store via `readProjectIdentity` and markdown glob under `.gnosys/`.
- Opens central DB when available via `GnosysDB.openCentral()`.
- Runs `migrateProject({ sourcePath, targetPath, newName, deleteSource, centralDb })`.
- Optionally syncs markdown memories with `syncMemoryToDb` after migration.
- Closes readline and central DB in `finally`, including error paths.

## Output

Migration progress, copied file count, new project identity, central DB status, sync count, and completion message.

## Errors

Missing source/target, missing `.gnosys/`, migration failures, or sync errors print `Migration failed: ...` and exit with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- migrate --help
npx vitest run src/test/migrate-command-handler.test.ts
```

## Related commands

- `gnosys projects` — verify registered projects after migration.
- `gnosys setup remote sync` — remote sync after local migration.
