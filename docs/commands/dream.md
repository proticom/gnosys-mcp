# gnosys dream

Dream Mode — night-time memory consolidation. Manual commands run one cycle immediately; scheduled runs are launched by a single machine-level launchd agent, not by MCP connections.

## Scheduled runs

`gnosys setup dream` installs `~/Library/LaunchAgents/com.gnosys.dream.plist` on macOS, which runs `gnosys dream run --scheduled`. Scheduled runs apply four cheap gates before any LLM work — designated machine, night window (`dream.schedule`), real system idle time (`dream.systemIdleMinutes`), and dreamworthiness (`dream.minNewMemoriesToDream` + `dream.minHoursBetweenRuns`) — and write a skipped-run record explaining any skip.

## Cost controls

`dream.maxLLMCallsPerRun` is a hard ceiling. Relationship/summary/critique work skips memory batches already analyzed (fingerprints in `~/.gnosys/dream-state.json`). Every run logs LLM calls made vs skipped, estimated tokens, and estimated cost to `~/.gnosys/dream-runs.jsonl`; view it with `gnosys dream report`.

## Usage

```bash
gnosys dream
gnosys dream --max-runtime 30 --json
gnosys dream --force
gnosys dream run
gnosys dream log
```

## Options (bare `gnosys dream` and `gnosys dream run`)

| Option | Description |
|--------|-------------|
| `--max-runtime <minutes>` | Max runtime in minutes (default: 30) |
| `--no-critique` | Skip self-critique phase |
| `--no-summaries` | Skip summary generation |
| `--no-relationships` | Skip relationship discovery |
| `--force` | Run even if this machine is not the designated dream node |
| `--scheduled` | Apply the launchd scheduler gates (designated machine, night window, system idle, dreamworthiness) |
| `--json` | Output raw JSON report instead of formatted text |

## Behavior

Bare **`gnosys dream`** runs one Dream Mode cycle using the active store (same executor as `gnosys dream run`).

1. Resolves configured stores via `GnosysResolver`.
2. Loads config from the primary store path.
3. Opens the store DB and verifies `gnosys.db` is migrated (v2.0).
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
- LLM provider available for the dream task route.

## Designated machine

When the central DB records a designated dream machine, manual runs on other machines are blocked unless `--force` is passed:

```text
Dream is designated to machine <id>, but this is <local-id>.
Pass --force to run anyway, or run 'gnosys setup dream' to redesignate.
```

Use `--force` for testing on non-designated nodes. Use `gnosys setup dream` to change designation.

## Related subcommands

| Command | Purpose |
|---------|---------|
| `gnosys dream run` | Explicit alias for running a cycle now (same options as bare `gnosys dream`) |
| `gnosys dream log` | Show recent dream runs from the central audit log |
| `gnosys dream report` | Generate `dream-dashboard.html` from `~/.gnosys/dream-runs.jsonl` |

### `gnosys dream log` (summary)

```bash
gnosys dream log
gnosys dream log --last 10
gnosys dream log --since 2026-05-01
gnosys dream log --failures-only
gnosys dream log --json
```

Reads recent runs from the central DB audit log. Options: `--last`, `--since`, `--failures-only`, `--json`.

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
npm run cli -- dream --help
node scripts/audit-commands.mjs --write
```

## Related commands

- `gnosys setup dream` — configure designation, provider, schedule.
- `gnosys check --task dream` — test dream LLM connectivity.
- `gnosys doctor` — broader system health check.
