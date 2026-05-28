# gnosys setup remote resolve

Resolve a sync conflict by choosing the local or remote version of a memory.

## Usage

```bash
gnosys setup remote resolve <memoryId>
gnosys setup remote resolve <memoryId> --keep local
gnosys setup remote resolve <memoryId> --keep remote
```

## Options

| Option | Description |
|--------|-------------|
| `--keep <choice>` | Which version to keep: `local` or `remote` (default: `local`) |

## Behavior

1. Validates `--keep` is `local` or `remote`.
2. Opens local DB and reads `remote_path`.
3. Calls `RemoteSync.resolve(memoryId, choice)`.

## Output

**Success:**

```text
Resolved <memoryId>: kept <local|remote> version.
```

**Failure:**

```text
Failed to resolve: <error>
```

## Errors

| Condition | Message |
|-----------|---------|
| Invalid `--keep` | `--keep must be 'local' or 'remote' (got: ...)` |
| Local DB unavailable | `Central DB not available.` |
| Remote not configured | `Remote not configured.` |
| Other errors | `Error: <message>` |

Failure paths set `process.exitCode = 1`. `RemoteSync.closeRemote()` and `centralDb?.close()` run through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- setup remote resolve --help
npx vitest run src/test/setup-remote-resolve-command-handler.test.ts
```

## Related commands

- `gnosys setup remote status` — list conflicts
- `gnosys setup remote sync` — two-way sync
