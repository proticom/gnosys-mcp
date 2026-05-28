# gnosys helper

Parent command for generating a tiny TypeScript helper library that agents import to talk to the Gnosys sandbox directly. Pairs with [`gnosys sandbox start`](sandbox-start.md) — agents call memory operations like normal code instead of issuing MCP tool calls on every operation.

## Usage

```bash
gnosys helper
gnosys helper generate
gnosys helper generate --directory ./agent
```

Bare `gnosys helper` (no subcommand) prints Commander help for the available subcommands. The parent command has no runtime `.action(...)` — all behavior lives in the leaf subcommand below.

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `generate` | Write `gnosys-helper.ts` in the target directory |

See the leaf command doc for options, output, and error handling:

- [`gnosys helper generate`](helper-generate.md)

## Sandbox relationship

Typical workflow:

1. Start the sandbox: `gnosys sandbox start`
2. Generate the helper in your agent project: `gnosys helper generate`
3. Import `gnosys-helper.ts` from agent scripts for low-latency `add` / `recall` calls

Most users do not need the sandbox or helper; MCP via `gnosys serve` is the default integration path.

## Validation

```bash
cd gnosys-public
npm run cli -- helper --help
npx vitest run src/test/helper-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys sandbox`](sandbox.md) — parent command for the background sandbox process
- [`gnosys sandbox start`](sandbox-start.md) — start the sandbox before generating the helper
- [`gnosys serve`](serve.md) — MCP server mode (alternative integration path)
