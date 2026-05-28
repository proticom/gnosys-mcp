# gnosys connect

Point an IDE at a remote Gnosys MCP server (central-server topology) instead of spawning a local one.

## Usage

```bash
gnosys connect --url http://studio.tailnet.ts.net:7777/mcp
gnosys connect --url http://studio.tailnet.ts.net:7777/mcp --token "$GNOSYS_MCP_TOKEN"
gnosys connect --url http://studio.tailnet.ts.net:7777/mcp --ide claude-desktop
gnosys connect --url http://studio.tailnet.ts.net:7777/mcp --dir /path/to/project
gnosys connect --url http://studio.tailnet.ts.net:7777/mcp --print
```

## Options

| Option | Description |
|--------|-------------|
| `--url <url>` | Required remote MCP URL |
| `--token <token>` | Optional bearer token written as an `Authorization` header |
| `--ide <ide>` | IDE config to write: `cursor` (default) or `claude-desktop` |
| `--dir <dir>` | Project directory for Cursor config (default: current working directory) |
| `--print` | Print the MCP config snippet instead of writing files |

## Behavior

1. Builds a remote MCP entry from `--url` and optional `--token`.
2. With `--print`, outputs JSON `{ mcpServers: { gnosys: ... } }` and exits.
3. Otherwise resolves `--ide` (`claude-desktop` or default `cursor`) and writes the client config via `writeRemoteClientConfig`.
4. Cursor config uses `--dir` or `process.cwd()` as the project directory.
5. Prints success message with written file path and restart reminder.

## Print output

```json
{
  "mcpServers": {
    "gnosys": {
      "url": "http://studio.tailnet.ts.net:7777/mcp"
    }
  }
}
```

When `--token` is set, the entry includes bearer authorization headers.

## Write output

```text
✓ Pointed cursor at http://studio.tailnet.ts.net:7777/mcp
  wrote: /path/to/.cursor/mcp.json  (bearer token included)
  Restart the IDE / MCP servers to pick it up.
```

## Platform notes

**Cursor** — writes or merges into the project's `.cursor/mcp.json` under `--dir` (default cwd).

**Claude Desktop** — writes the Claude Desktop MCP config when `--ide claude-desktop` is set.

Restart the IDE or reload MCP servers after writing config.

## Errors

Config write failures:

```text
connect failed: <message>
```

Failures set `process.exitCode = 1`.

## Validation

```bash
cd gnosys-public
npm run cli -- connect --help
npx vitest run src/test/connect-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys serve`](serve.md) — run a local MCP server
- `gnosys centralize` — seed a central server brain from this machine
- [`gnosys setup remote`](setup-remote.md) — configure remote sync for the local brain
