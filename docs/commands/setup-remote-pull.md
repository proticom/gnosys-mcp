# gnosys setup remote pull

Pull remote memory, project, and audit changes into the local database.

## Usage

```bash
gnosys setup remote pull
gnosys setup remote pull --newer-wins
gnosys setup remote pull --verbose
```

## Options

| Option | Description |
|--------|-------------|
| `--newer-wins` | Auto-resolve conflicts by taking the newer version |
| `--verbose` | Stream per-memory progress to stderr (suppresses heartbeat spinner) |

## Conflict strategy

Default: `skip-and-flag`. With `--newer-wins`, conflicts resolve to the newer version automatically.

## Behavior

1. Opens local DB and reads `remote_path`.
2. Runs `RemoteSync.pull()` with the selected strategy.
3. Prints summary counts for pulled, skipped, conflicts, projects, and audit entries.

## Output

**Summary:**

```text
Pulled: N | Skipped: N | Conflicts: N | Projects pulled: N | Audit pulled: N
```

**Errors:** listed when present.

## Errors

| Condition | Message |
|-----------|---------|
| Local DB unavailable | `Central DB not available.` |
| Remote not configured | `Remote not configured.` |
| Pull failure | `Error: <message>` |

Failure paths set `process.exitCode = 1`. `RemoteSync.closeRemote()` and `centralDb?.close()` run through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- setup remote pull --help
npx vitest run src/test/setup-remote-pull-command-handler.test.ts
```

## Related commands

- `gnosys setup remote status` — inspect sync state and conflicts
- `gnosys setup remote push` — push local changes to remote
- `gnosys setup remote sync` — two-way sync
