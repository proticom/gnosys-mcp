# gnosys machine show

Show this machine's local `machine.json` configuration (`machineId`, hostname, roots, remote).

## Usage

```bash
gnosys machine show
gnosys machine show --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output the machine config object as JSON |

## Behavior

1. Reads `machine.json` via `readMachineConfig()`.
2. If missing, prints the expected path from `getMachineConfigPath()` and suggests `gnosys machine migrate` or `gnosys scan`.
3. Otherwise prints human summary or JSON via `outputResult`.

## Human output

```text
machine.json: /Users/you/.gnosys/machine.json
  machineId: abc123...
  hostname:  my-mac
  roots:     {"dev":"/Users/you/projects"}
  remote:    (disabled)
```

When remote is enabled with a path:

```text
  remote:    /Volumes/NAS/gnosys-remote
```

## JSON output

With `--json`, emits the full normalized machine config object.

## Missing config

```text
No machine.json yet (/Users/you/.gnosys/machine.json).
Run 'gnosys machine migrate' (existing setup) or 'gnosys scan' to create it.
```

## Validation

```bash
cd gnosys-public
npm run cli -- machine show --help
npx vitest run src/test/machine-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys machine`](machine.md) — parent command overview
- `gnosys machine migrate` — create `machine.json` from synced DB meta
- `gnosys scan` — discover projects under configured roots
