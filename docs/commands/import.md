# gnosys import

Bulk-import CSV, JSON, or JSONL data into Gnosys memories. Also serves as the parent command for project bundle import.

## Usage (bulk import)

```bash
gnosys import data.csv --format csv --mapping '{"name":"title","body":"content"}'
gnosys import records.json --format json --mapping '{"title":"title","text":"content"}' --dry-run
gnosys import records.jsonl --format jsonl --mapping '{"title":"title","body":"content"}' --mode structured --store project
```

## Usage (project bundle)

```bash
gnosys import project bundle.json.gz
```

See the `import project` leaf command docs for bundle restore options (`--strategy`, `--working-directory`, etc.).

## Bulk import options

| Option | Description |
|--------|-------------|
| `--format <format>` | Required: `csv`, `json`, or `jsonl` |
| `--mapping <json>` | Required field mapping JSON |
| `--mode <mode>` | `llm` or `structured` (default `structured`) |
| `--limit <n>` | Max records to import |
| `--offset <n>` | Skip first N records |
| `--skip-existing` | Skip records whose titles already exist |
| `--batch-commit` / `--no-batch-commit` | Single vs per-record commits (default batch) |
| `--concurrency <n>` | Parallel LLM calls (default 5) |
| `--dry-run` | Preview without writing |
| `--store <store>` | Target store (default `project`) |

## Behavior

- Without `fileOrUrl`, prints usage for bulk and project paths and exits.
- Bulk import requires `--format` and `--mapping`; otherwise exits with a clear error pointing to `import project` for bundles.
- Invalid mapping JSON exits with example message.
- Resolves writable store, loads tag registry, runs `performImport` with progress bar on stderr.
- After successful import (non-dry-run), reindexes search when records were imported.
- Prints summary via `formatImportSummary` (prefixed `DRY RUN —` or `✓`).

## Mapping targets

Valid mapping targets: `title`, `category`, `content`, `tags`, `relevance`.

## Validation

```bash
cd gnosys-public
npm run cli -- import --help
```

## Related commands

- `gnosys import project` — restore a portable project bundle.
- `gnosys bootstrap` — batch-import documents from a directory.
