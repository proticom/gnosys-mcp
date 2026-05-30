# gnosys machine

Parent command for managing this machine's local config (`machine.json`: machineId, roots, remote).

Machine-local settings stay on each host and are not synced through the central DB. Use this command to inspect or migrate that config.

## Usage

```bash
gnosys machine
gnosys machine show
gnosys machine show --json
gnosys machine migrate
gnosys machine migrate --root /Users/you/projects --no-scan
```

Bare `gnosys machine` (no subcommand) prints Commander help for the available subcommands. The parent command has no runtime `.action(...)` — all behavior lives in the leaf subcommands below.

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `show` | Show this machine's `machine.json` |
| `migrate` | Move machine-local config out of the synced DB into `machine.json`, set roots, and scan |

### `gnosys machine show`

Displays `machineId`, hostname, roots, and remote settings from `machine.json`. With `--json`, outputs the config object as JSON via `outputResult`.

If `machine.json` does not exist yet, prints the expected path and hints to run `gnosys machine migrate` or `gnosys scan`.

### `gnosys machine migrate`

Reads machine-local fields from the central DB, writes `machine.json`, optionally sets a dev root (`--root`), and scans for projects unless `--no-scan` is set. Requires an available central DB (`GnosysDB.openLocal()`).

## Platform / path notes

`machine.json` lives at the path returned by `getMachineConfigPath()` (under the gnosys home directory for this machine). Roots map logical names (e.g. `dev`) to absolute directories on this host.

## Validation

```bash
cd gnosys-public
npm run cli -- machine --help
npx vitest run src/test/machine-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- `gnosys scan` — discover projects under configured roots
- [`gnosys setup remote`](setup-remote.md) — configure remote sync
- [`gnosys connect`](connect.md) — point an IDE at a remote MCP server
