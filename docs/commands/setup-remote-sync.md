# gnosys setup remote sync

Two-way sync: push local changes, then pull remote changes.

## Usage

```bash
gnosys setup remote sync
gnosys setup remote sync --auto
gnosys setup remote sync --newer-wins
gnosys setup remote sync --verbose
```

## Options

| Option | Description |
|--------|-------------|
| `--auto` | Run silently for cron/LaunchAgent (skip-and-flag for conflicts) |
| `--newer-wins` | Auto-resolve conflicts by taking the newer version |
| `--verbose` | Stream per-memory progress to stderr (suppresses heartbeat spinner) |

## Behavior

1. Opens local DB and reads `remote_path`.
2. Runs `RemoteSync.sync()` with push-then-pull.
3. In `--auto` mode, suppresses summary output unless conflicts or errors exist.
4. `--auto` and `--verbose` both bypass the heartbeat spinner.

Default conflict strategy: `skip-and-flag`. With `--newer-wins`, conflicts resolve to the newer version.

## Output

**Summary (when printed):**

```text
Pushed: N | Pulled: N | Conflicts: N | Projects: ↑N/↓N | Audit: ↑N/↓N
```

**Errors and conflicts:** listed when present; conflicts point to `gnosys setup remote status`.

## Errors

| Condition | Behavior |
|-----------|----------|
| Local DB unavailable | `Central DB not available.` (unless `--auto`); exit code 1 |
| Remote not configured | `Remote not configured.` (unless `--auto`); exit code 0 in auto, 1 otherwise |
| Sync failure | `Error: <message>` (unless `--auto`); exit code 1 |

`RemoteSync.closeRemote()` and `centralDb?.close()` run through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- setup remote sync --help
npx vitest run src/test/setup-remote-sync-command-handler.test.ts
```

## Related commands

- `gnosys setup remote push` — push only
- `gnosys setup remote pull` — pull only
- `gnosys setup remote status` — inspect conflicts
- `gnosys setup remote resolve` — resolve a conflict
