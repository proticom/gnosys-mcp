# gnosys export vault

Export the current Gnosys project store to an Obsidian-compatible markdown vault.

## Usage

```bash
gnosys export vault --to ./vault
gnosys export --to ./vault
gnosys export vault --to ./vault --all --overwrite --json
```

Legacy `gnosys export --to <dir>` is rewritten to `gnosys export vault --to <dir>` before parsing.

## Options

| Option | Description |
|--------|-------------|
| `--to <dir>` | Target directory for export (required) |
| `--all` | Export active + archived memories |
| `--overwrite` | Overwrite existing files in the target |
| `--no-summaries` | Skip category summaries |
| `--no-reviews` | Skip review suggestions |
| `--no-graph` | Skip relationship graph export |
| `--json` | Output raw JSON report instead of formatted text |

## Behavior

1. Resolves configured stores via `GnosysResolver`.
2. Opens the primary store DB and verifies `gnosys.db` is migrated (v2.0).
3. Runs `GnosysExporter.export()` with option mapping.
4. Prints progress on stderr during export.
5. Prints `formatExportReport(report)` or JSON to stdout.

Progress example:

```text
Exporting to: /path/to/vault
  [10/42] memories/architecture/example.md
```

## Prerequisites

- At least one Gnosys store (run `gnosys init` first).
- Migrated `gnosys.db` (run `gnosys migrate` if needed).

## Errors

No stores:

```text
No Gnosys stores found. Run 'gnosys init' first.
```

Unmigrated DB:

```text
Export requires gnosys.db (v2.0). Run 'gnosys migrate' first.
```

Exits with code 1 on validation failures after DB open uses `process.exitCode`.

## Validation

```bash
cd gnosys-public
npm run cli -- export vault --help
npx vitest run src/test/export-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys export`](export.md) — parent command overview (vault + project).
- `gnosys export project` — portable `.json.gz` project bundle.
- `gnosys import project` — restore a project bundle.
