# gnosys sandbox status

Check whether the Gnosys sandbox background process is running.

## Usage

```bash
gnosys sandbox status
gnosys sandbox status --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output status as JSON |

## Behavior

Calls `sandboxStatus()` to report whether the background sandbox process is running, including PID and socket path when active.

## Human output

Running:

```text
Sandbox running (pid: 12345, socket: /path/to/socket)
```

Not running:

```text
Sandbox is not running. Start with: gnosys sandbox start
```

## JSON output

Success emits the full status object via `JSON.stringify(status, null, 2)`.

On failure with `--json`:

```json
{
  "ok": false,
  "error": "error message"
}
```

On failure without `--json`, prints `Error: ...` to stderr and exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- sandbox status --help
npx vitest run src/test/sandbox-status-command-handler.test.ts
```

## Related commands

- `gnosys sandbox start` — start the background process.
- `gnosys sandbox stop` — stop the background process.
