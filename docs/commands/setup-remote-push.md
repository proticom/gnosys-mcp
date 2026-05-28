# gnosys setup remote push

Push local memory, project, and audit changes to the configured remote.

## Usage

```bash
gnosys setup remote push
gnosys setup remote push --newer-wins
gnosys setup remote push --verbose
```

## Options

| Option | Description |
|--------|-------------|
| `--newer-wins` | Auto-resolve conflicts by taking the newer version |
| `--verbose` | Stream per-memory progress to stderr (suppresses heartbeat spinner) |

## Behavior

1. Opens local DB and reads `remote_path`.
2. Runs `RemoteSync.push()` with strategy `newer-wins` or `skip-and-flag`.
3. Prints summary counts for pushed, skipped, conflicts, projects, and audit entries.

## Output

**Summary:**

```text
Pushed: N | Skipped: N | Conflicts: N | Projects pushed: N | Audit pushed: N
```

**Errors:** listed when present.

**Conflicts:** memory IDs and titles with pointer to `gnosys setup remote status`.

## Errors

| Condition | Message |
|-----------|---------|
| Local DB unavailable | `Central DB not available.` |
| Remote not configured | `Remote not configured.` |
| Push failure | `Error: <message>` |

Failure paths set `process.exitCode = 1`. `RemoteSync.closeRemote()` and `centralDb?.close()` run through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- setup remote push --help
npx vitest run src/test/setup-remote-push-command-handler.test.ts
```

## Related commands

- `gnosys setup remote` — configure remote path
- `gnosys setup remote status` — inspect conflicts and sync state
- `gnosys setup remote pull` — pull remote changes
