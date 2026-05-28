# gnosys dream run

Force a Dream Mode consolidation cycle now. Same behavior and options as bare `gnosys dream`.

## Usage

```bash
gnosys dream run
gnosys dream run --max-runtime 30
gnosys dream run --json
gnosys dream run --force
gnosys dream run --no-critique --no-summaries
```

## Options

| Option | Description |
|--------|-------------|
| `--max-runtime <minutes>` | Max runtime in minutes (default: 30) |
| `--no-critique` | Skip self-critique phase |
| `--no-summaries` | Skip summary generation |
| `--no-relationships` | Skip relationship discovery |
| `--force` | Run even if this machine is not the designated dream node |
| `--json` | Output raw JSON report instead of formatted text |

## Behavior

1. Resolves configured stores via `GnosysResolver`.
2. Loads config from the primary store path.
3. Verifies `gnosys.db` is migrated (v2.0).
4. Checks designated-machine policy against the central DB.
5. Runs `GnosysDreamEngine.dream()` with phase progress on stderr.
6. Prints `formatDreamReport(report)` to stdout, or JSON when `--json` is set.

Progress lines appear on stderr:

```text
Starting Dream Mode cycle...
  [phase-name] detail...
```

## Prerequisites

- At least one Gnosys store (run `gnosys init` first).
- Migrated `gnosys.db` (run `gnosys migrate` if needed).
- Dream Mode provider/model configured (see `gnosys setup dream`).

## Designated machine

When the central DB records a designated dream machine, manual runs on other machines are blocked unless `--force` is passed:

```text
Dream is designated to machine <id>, but this is <local-id>.
Pass --force to run anyway, or run 'gnosys setup dream' to redesignate.
```

## Errors

No stores:

```text
No Gnosys stores found. Run 'gnosys init' first.
```

Unmigrated DB:

```text
Dream Mode requires gnosys.db (v2.0). Run 'gnosys migrate' first.
```

Designated-machine mismatch (without `--force`): exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- dream run --help
npx vitest run src/test/dream-run-command-handler.test.ts
```

## Related commands

- `gnosys dream` — bare parent command (same cycle behavior).
- `gnosys dream log` — view recent dream runs from the audit log.
- `gnosys setup dream` — configure designation, provider, schedule.
