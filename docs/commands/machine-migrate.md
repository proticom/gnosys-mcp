# gnosys machine migrate

Move machine-local config (`machineId`, remote path) out of the synced central DB into this host's `machine.json`, optionally set the `dev` root, and scan for projects.

## Usage

```bash
gnosys machine migrate
gnosys machine migrate --root /Users/you/projects
gnosys machine migrate --root /Users/you/projects --no-scan
```

## Options

| Option | Description |
|--------|-------------|
| `--root <dir>` | Set this machine's `dev` root (default: derived from the project registry) |
| `--no-scan` | Skip the project scan after writing `machine.json` |

## Behavior

1. Opens the central DB via `GnosysDB.openLocal()`.
2. Calls `migrateMachine(db, { root: opts.root, scan: opts.scan })`.
3. Writes `machine.json` at `getMachineConfigPath()`.
4. Adopts or regenerates `machineId` and may adopt `remote_path` from synced DB meta (removed from shared DB when adopted).
5. Configures roots (including optional `--root` for `dev`).
6. Scans projects under roots unless `--no-scan`.
7. Closes the DB after migration.

## Success output

```text
✓ machine.json written: /Users/you/.gnosys/machine.json
  machineId: abc123... (adopted from synced meta)
  remote: adopted remote_path from synced meta (removed from shared DB)
  roots: {"dev":"/Users/you/projects"}
  scanned 3 project(s):
    my-app  [registered]  /Users/you/projects/my-app
```

When scan is skipped:

```text
  (scan skipped — set a root in machine.json, then run 'gnosys scan')
```

## Errors

Central DB unavailable:

```text
Central DB not available (better-sqlite3 missing).
```

Exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- machine migrate --help
npx vitest run src/test/machine-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys machine`](machine.md) — parent command overview
- [`gnosys machine show`](machine-show.md) — display current `machine.json`
- `gnosys scan` — discover projects under configured roots
