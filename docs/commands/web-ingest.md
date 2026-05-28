# gnosys web ingest

Crawl the configured source and generate knowledge markdown files.

## Usage

```bash
gnosys web ingest
gnosys web ingest --source https://example.com/sitemap.xml --verbose
gnosys web ingest --prune --no-llm --dry-run --json
```

## Prerequisites

Run `gnosys web init` first so `gnosys.json` contains a `web` configuration.

## Options

| Option | Description |
|--------|-------------|
| `--source <url>` | Override sitemap URL or content directory for this run |
| `--prune` | Remove orphaned knowledge files |
| `--no-llm` | Force structured mode (skip LLM enrichment) |
| `--concurrency <n>` | Parallel processing limit (default `3`) |
| `--dry-run` | Show what would change without writing files |
| `--verbose` | Print per-page details |
| `--json` | Output results as JSON |

## Behavior

1. Loads config from the active web store path.
2. Exits with guidance to run `gnosys web init` when `web` config is missing.
3. Passes resolved source, output directory, categories, exclude rules, pruning, LLM, concurrency, crawl delay, dry-run, and verbose options into `ingestSite`.
4. `--source` overrides both sitemap URL and content directory when set.
5. `--no-llm` forces `llmEnrich: false` regardless of config.

## Human output

```text
Ingestion complete (1234ms):
  Added:     5
  Updated:   2
  Unchanged: 10
  Removed:   1
  Errors:    1
    https://example.com/bad: timeout
```

## JSON output

Emits the full `ingestSite` result object. On error with `--json`:

```json
{
  "ok": false,
  "error": "No web configuration found in gnosys.json. Run 'gnosys web init' first."
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- web ingest --help
npx vitest run src/test/web-ingest-command-handler.test.ts
```

## Related commands

- `gnosys web init` — initial web knowledge base setup.
- `gnosys web build-index` — generate search index JSON from knowledge files.
