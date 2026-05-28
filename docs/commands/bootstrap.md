# gnosys bootstrap

Batch-import existing documents from a source directory into the memory store.

## Usage

```bash
gnosys bootstrap ./docs
gnosys bootstrap ./notes --pattern "**/*.md" "**/*.txt" --dry-run
gnosys bootstrap ./archive --skip-existing --preserve-frontmatter --store project
gnosys bootstrap ./imports --category imported --author human --authority imported --confidence 0.7
```

## Options

| Option | Description |
|--------|-------------|
| `-p, --pattern <patterns...>` | File glob patterns (default `**/*.md`) |
| `--skip-existing` | Skip files whose titles already exist |
| `-c, --category <category>` | Default category (default `imported`) |
| `-a, --author <author>` | Default author (default `human`) |
| `--authority <authority>` | Default authority (default `imported`) |
| `--confidence <n>` | Default confidence 0–1 (default `0.7`) |
| `--preserve-frontmatter` | Keep existing YAML frontmatter when present |
| `--dry-run` | Preview without writing |
| `-s, --store <store>` | Target writable store |

## Behavior

- Resolves a writable store; exits with `No writable store found.` when none available.
- Calls `discoverFiles` to preview matches; prints `Found N files in <sourceDir>`.
- If zero files match, prints `Nothing to import.` and returns without calling `bootstrap`.
- Otherwise runs `bootstrap(writeTarget.store, ...)` with mapped options.
- Prints summary: `Bootstrap DRY RUN` or `Bootstrap COMPLETE` with scanned/imported/skipped/failed counts.
- Lists imported, skipped, and failed file paths in separate sections.

## Output example

```text
Found 12 files in ./docs

Bootstrap COMPLETE:
  Scanned: 12
  Imported: 10
  Skipped: 2
  Failed: 0
```

## Platform notes

### macOS / Linux

- Source directory can be relative or absolute.
- Glob patterns follow the bootstrap library conventions.

### Windows

- Quote paths and patterns in PowerShell when they contain spaces.

## Validation

```bash
cd gnosys-public
npm run cli -- bootstrap --help
```

## Related commands

- `gnosys ingest` — ingest a single file via multimodal pipeline.
- `gnosys import` — bulk CSV/JSON import paths.
