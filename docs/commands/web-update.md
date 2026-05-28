# gnosys web update

Re-ingest a URL or refresh a local knowledge file, then rebuild the search index.

## Usage

```bash
gnosys web update https://example.com/page
gnosys web update blog/example-page.md
gnosys web update https://example.com/page --category blog --no-llm --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `urlOrPath` | HTTP(S) URL to re-ingest, or path relative to the knowledge directory for local refresh |

## Prerequisites

Run `gnosys web init` first so `gnosys.json` contains a `web` configuration.

## Options

| Option | Description |
|--------|-------------|
| `--no-llm` | Force structured mode (skip LLM enrichment) |
| `--category <name>` | Override category inference for URL ingest |
| `--json` | Output result as JSON |

## URL branch

1. Re-ingests via `ingestUrl` with `source: "urls"`, config output dir, optional category override, LLM from config unless `--no-llm`.
2. Rebuilds index to `<knowledgeRoot>/gnosys-index.json`.

## Local path branch

1. Resolves path against `knowledgeRoot`.
2. Rejects absolute paths and `../` traversal outside the knowledge directory.
3. Verifies file exists, then rebuilds index.

## Human output

URL:

```text
Updated: https://example.com/page
  Added: 1, Updated: 0
Index rebuilt: 42 documents
```

Local:

```text
Refreshed: blog/example-page.md
Index rebuilt: 42 documents
```

## JSON output

URL success includes ingest result fields plus `documentCount`. Local success:

```json
{
  "ok": true,
  "refreshed": "blog/example-page.md",
  "documentCount": 42
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- web update --help
npx vitest run src/test/web-update-command-handler.test.ts
```

## Related commands

- `gnosys web add` — ingest a single URL without full update flow.
- `gnosys web build-index` — rebuild index only.
