# gnosys sandbox start

Start the Gnosys sandbox background process for low-latency agent access to memory operations.

## Usage

```bash
gnosys sandbox start
gnosys sandbox start --db-path /path/to/db
gnosys sandbox start --persistent --json
```

## Options

| Option | Description |
|--------|-------------|
| `--persistent` | Keep running across reboots (reserved/future use) |
| `--db-path <path>` | Custom database directory for the sandbox server |
| `--json` | Output result as JSON |

## Behavior

1. Calls `startSandbox({ persistent, dbPath, wait: true })`.
2. Reuses an already-running sandbox when possible.
3. Waits for readiness, then prints the process ID.

## Human output

```text
Gnosys sandbox running (pid: 12345)
```

## JSON output

Success:

```json
{
  "ok": true,
  "pid": 12345
}
```

Failure:

```json
{
  "ok": false,
  "error": "error message"
}
```

On failure without `--json`, prints `Failed to start sandbox: ...` to stderr and exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- sandbox start --help
npx vitest run src/test/sandbox-start-command-handler.test.ts
```

## Related commands

- `gnosys sandbox stop` — stop the background process.
- `gnosys sandbox status` — check whether the sandbox is running.
- `gnosys helper generate` — generate the agent helper library for sandbox access.
