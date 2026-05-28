# gnosys serve

Start the Gnosys MCP server for IDE and agent integrations.

You normally do not run this yourself. `gnosys setup ides` configures IDEs to launch the `gnosys-mcp` wrapper, which starts the Gnosys MCP server. `gnosys serve` is the underlying server entrypoint — useful for direct diagnostics, explicit stdio invocation, or HTTP transport mode.

## Usage

```bash
gnosys serve
gnosys serve --with-maintenance
gnosys serve --transport http --host 127.0.0.1 --port 7777
gnosys serve --transport http --host 0.0.0.0 --port 7777 --token <secret>
```

## Options

| Option | Description |
|--------|-------------|
| `--with-maintenance` | Run background maintenance every 6 hours (logs to stderr) |
| `--transport <mode>` | `stdio` (default) or `http` (central-server topology) |
| `--host <addr>` | HTTP bind address (default `127.0.0.1`) |
| `--port <n>` | HTTP port (default `7777`) |
| `--token <token>` | Require `Authorization: Bearer <token>` for HTTP transport |

## Behavior

- **Default transport:** stdio — used by IDE MCP integrations.
- **Stdio contract:** stdout is reserved for MCP JSON-RPC frames only. Operational logs, maintenance output, and diagnostics must go to stderr. Corrupting stdout breaks JSON-RPC.
- **`--with-maintenance`:** schedules maintenance on server start (30s delay) and every 6 hours; all messages use stderr (`[maintenance] ...`).
- **HTTP transport:** sets `GNOSYS_TRANSPORT=http`, `GNOSYS_HTTP_HOST`, `GNOSYS_HTTP_PORT`, and optionally `GNOSYS_SERVE_TOKEN` before the MCP server starts.
- **HTTP auth:** when `--token` is set, clients must send `Authorization: Bearer <token>`.

## Platform notes

### macOS

- IDE configs typically invoke the `gnosys-mcp` wrapper; use `gnosys serve` directly only for diagnostics or explicit transport setup.
- Use `127.0.0.1` for local-only HTTP; bind to a tailnet address to share across machines on your network.

### Linux

- Same stdio/HTTP behavior. Ensure the chosen HTTP port is not blocked by firewall rules when using network-hosted MCP.

### Windows

- IDE configs should use the `gnosys-mcp` wrapper; path separators in env vars are handled by Node when invoking `gnosys serve` directly.
- Prefer `127.0.0.1` unless you intentionally expose the HTTP server on the LAN.

## Validation

```bash
cd gnosys-public
npm run cli -- serve --help
```

## Related commands

- `gnosys setup ides` — configure IDE MCP entries to use the `gnosys-mcp` wrapper (not direct `gnosys serve`).
- `gnosys doctor` — verify stores and central DB before debugging serve issues.

## Tests (coverage)

Existing tests cover MCP handshake and stdout cleanliness:

- `v511-serve-handshake.test.ts`
- `v592-serve-stdout-clean.test.ts`
