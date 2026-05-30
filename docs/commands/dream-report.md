# gnosys dream report

Generate a self-contained HTML dashboard from the local Dream Mode run log.

## Usage

```bash
gnosys dream report
gnosys dream report --output dream-dashboard.html
gnosys dream report --last 100
```

## Behavior

1. Reads `~/.gnosys/dream-runs.jsonl`.
2. Summarizes run count, completed runs, LLM calls made/skipped, estimated cost, and useful-output score.
3. Writes a standalone HTML file that can be opened locally for QA.

The dashboard is generated from the same written log that Dream uses for subsequent decision-making context (`~/.gnosys/dream-state.json` holds the fast watermark and analyzed fingerprints).

## Options

| Option | Description |
|--------|-------------|
| `--output <file>` | Output HTML file (default: `dream-dashboard.html`) |
| `--last <N>` | Only include the N most recent logged runs |

## Output

```text
Wrote /path/to/dream-dashboard.html
```

## Related commands

- [`gnosys dream`](dream.md) — parent command overview
- [`gnosys dream log`](dream-log.md) — inspect raw dream run audit rows
- [`gnosys dream run`](dream-run.md) — execute a dream cycle

## Validation

```bash
cd gnosys-public
npm run cli -- dream report --help
npx vitest run src/test/dream-report-command-handler.test.ts
node scripts/audit-commands.mjs --write
```
