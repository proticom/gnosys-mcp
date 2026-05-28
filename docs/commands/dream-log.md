# gnosys dream log

Show recent Dream Mode runs from the central audit log.

## Usage

```bash
gnosys dream log
gnosys dream log --last 10
gnosys dream log --since 2026-05-01
gnosys dream log --failures-only
gnosys dream log --json
```

## Options

| Option | Description |
|--------|-------------|
| `--last <N>` | Number of most recent runs to show (default: 20) |
| `--since <YYYY-MM-DD>` | Only runs completed on or after this date |
| `--failures-only` | Only runs with errors or unreachable provider |
| `--json` | Output raw audit rows as JSON |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Fetches recent dream runs with `getRecentDreamRuns(limit, { failuresOnly, sinceIso })`.
3. Prints formatted output or JSON.

## Parent `--json` hoisting

Commander v13 can hoist `--json` to the parent `dream` command when both define it. The CLI passes `parentJson: !!this.parent?.opts().json` so `gnosys dream --json log` also emits JSON.

## Formatted output

Each run shows completion time, duration, status, counters, and provider/model when present.

Status classification:

- **provider unreachable** — dream provider could not be reached
- **N error(s)** — run completed with errors
- **did work** — summaries, decays, or relationships were produced
- **no LLM work** — run completed without LLM-side changes

Example:

```text
3 dream run(s):

  2026-05-28T05:00:00Z (45.2s) did work
    decays=2 summaries=1 reviews=0 relations=3
    provider=ollama/llama3.2
```

## JSON output

```json
{
  "count": 1,
  "runs": [ ... ]
}
```

JSON is emitted even when there are zero runs.

## Empty output

When no runs match (non-JSON mode):

```text
No dream runs recorded.
```

## Errors

Central DB unavailable:

```text
Central DB not available.
```

Exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- dream log --help
npx vitest run src/test/dream-log-command-handler.test.ts
```

## Related commands

- `gnosys dream` / `gnosys dream run` — trigger a dream cycle.
- `gnosys audit` — broader operation audit trail.
