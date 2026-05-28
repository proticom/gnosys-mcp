# gnosys sandbox

Parent command for the Gnosys sandbox — a long-lived local background process that holds the SQLite handle so agents can call memory operations through a tiny helper library instead of paying the MCP roundtrip on every call.

Most users do not need the sandbox; it is for high-throughput agent workflows.

## Usage

```bash
gnosys sandbox
gnosys sandbox start
gnosys sandbox stop
gnosys sandbox status
```

Bare `gnosys sandbox` (no subcommand) prints Commander help for the available subcommands. The parent command has no runtime `.action(...)` — all behavior lives in the leaf subcommands below.

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `start` | Start the sandbox background process |
| `stop` | Stop the sandbox background process |
| `status` | Check whether the sandbox is running |

See the leaf command docs for options, output, and error handling:

- [`gnosys sandbox start`](sandbox-start.md)
- [`gnosys sandbox stop`](sandbox-stop.md)
- [`gnosys sandbox status`](sandbox-status.md)

## Helper library

After starting the sandbox, generate a local helper file with [`gnosys helper generate`](helper-generate.md). Agent scripts import that helper for low-latency `add` / `recall` calls against the running sandbox.

## Validation

```bash
cd gnosys-public
npm run cli -- sandbox --help
npx vitest run src/test/sandbox-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys helper generate`](helper-generate.md) — write `gnosys-helper.ts` for sandbox access
- [`gnosys serve`](serve.md) — MCP server mode (alternative integration path)
