# gnosys web add

Ingest a single URL into the knowledge base.

## Usage

```bash
gnosys web add https://example.com/page
gnosys web add https://example.com/page --category blog --no-llm
gnosys web add https://example.com/page --no-reindex --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `url` | URL to ingest |

## Prerequisites

Run `gnosys web init` first so `gnosys.json` contains a `web` configuration.

## Options

| Option | Description |
|--------|-------------|
| `--category <name>` | Override category inference (merged as `"/*": category`) |
| `--no-llm` | Force structured mode (skip LLM enrichment) |
| `--no-reindex` | Skip index rebuild after ingest |
| `--json` | Output ingest result as JSON |

## Behavior

1. Loads config and requires `web` settings.
2. Merges category override when `--category` is set.
3. Calls `ingestUrl` with `source: "urls"`, output dir from config, LLM from config unless `--no-llm`, `concurrency: 1`, `crawlDelayMs: 0`.
4. Rebuilds index when reindex is enabled (default) and content was added or updated.
5. Writes index to `<outputDir>/gnosys-index.json`.

## Human output

```text
Added: blog/example-page.md
```

Or `Updated: ...`, `Unchanged (content identical)`, or `Error: ...`.

## JSON output

Full `ingestUrl` result object. On error with `--json`:

```json
{
  "ok": false,
  "error": "message"
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- web add --help
npx vitest run src/test/web-add-command-handler.test.ts
```

## Related commands

- `gnosys web ingest` — bulk crawl from configured source.
- `gnosys web remove` — remove a knowledge file.
