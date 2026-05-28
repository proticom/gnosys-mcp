# gnosys web build-index

Generate search index JSON from the knowledge directory.

## Usage

```bash
gnosys web build-index
gnosys web build-index --input ./knowledge --output ./public/gnosys-index.json
gnosys web build-index --no-stop-words --json
```

## Options

| Option | Description |
|--------|-------------|
| `--input <dir>` | Override knowledge directory |
| `--output <path>` | Override generated index file path |
| `--no-stop-words` | Disable stop-word filtering |
| `--json` | Output index stats as JSON |

## Behavior

1. Loads config from the active web store path.
2. Resolves knowledge directory: `--input` → `web.outputDir` → `./knowledge`.
3. Resolves output path: `--output` → `<knowledgeDir>/gnosys-index.json`.
4. Builds index via `buildIndex` with `stopWords: opts.stopWords`.
5. Writes index via `writeIndex`.

## Human output

```text
Search index built:
  Documents: 42
  Tokens:    1200
  Output:    ./knowledge/gnosys-index.json
```

## JSON output

```json
{
  "ok": true,
  "documentCount": 42,
  "tokenCount": 1200,
  "outputPath": "./knowledge/gnosys-index.json"
}
```

On error with `--json`:

```json
{
  "ok": false,
  "error": "message"
}
```

Errors exit with code 1 (`Build index failed: ...` in human mode).

## Validation

```bash
cd gnosys-public
npm run cli -- web build-index --help
npx vitest run src/test/web-build-index-command-handler.test.ts
```

## Related commands

- `gnosys web ingest` — crawl source and generate knowledge markdown files.
- `gnosys web build` — run ingest + build-index in one shot.
