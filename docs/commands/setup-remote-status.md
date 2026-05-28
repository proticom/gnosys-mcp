# gnosys setup remote status

Show remote sync status: pending changes, conflicts, and last sync time.

## Usage

```bash
gnosys setup remote status
gnosys setup remote status --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |

## Output

**Not configured (human):**

```text
Remote sync: not configured.
Run 'gnosys setup remote' to set up multi-machine sync.
```

**Not configured (JSON):**

```json
{
  "configured": false,
  "message": "Remote not configured. Run 'gnosys setup remote'."
}
```

**Configured (human):** formatted status via `formatStatus`, plus conflict details and resolve guidance when conflicts exist.

**Configured (`--json`):** raw status object from `RemoteSync.getStatus()`.

## Conflict guidance

When conflicts are present in human output:

```text
Resolve with: gnosys setup remote resolve <memory-id> --keep <local|remote>
```

## Errors

| Condition | Message |
|-----------|---------|
| Local DB unavailable | `Central DB not available.` |
| Other errors | `Error: <message>` |

Failure paths set `process.exitCode = 1`. `RemoteSync.closeRemote()` and `centralDb?.close()` run through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- setup remote status --help
npx vitest run src/test/setup-remote-status-command-handler.test.ts
```

## Related commands

- `gnosys setup remote` — configure remote path (parent command)
- `gnosys status --remote` — alias-style remote status from top-level status
- `gnosys setup remote resolve` — resolve sync conflicts
