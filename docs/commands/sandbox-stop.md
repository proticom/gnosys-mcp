# gnosys sandbox stop

Stop the Gnosys sandbox background process.

## Usage

```bash
gnosys sandbox stop
gnosys sandbox stop --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output result as JSON |

## Behavior

Calls `stopSandbox()` to shut down the background sandbox process. The result indicates whether a process was actually running.

## Human output

When running:

```text
Sandbox stopped.
```

When not running:

```text
Sandbox was not running.
```

## JSON output

Success:

```json
{
  "ok": true,
  "wasRunning": true
}
```

Failure:

```json
{
  "ok": false,
  "error": "error message"
}
```

On failure without `--json`, prints `Failed to stop sandbox: ...` to stderr and exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- sandbox stop --help
npx vitest run src/test/sandbox-stop-command-handler.test.ts
```

## Related commands

- `gnosys sandbox start` — start the background process.
- `gnosys sandbox status` — check whether the sandbox is running.
