# gnosys web status

Show the current state of the web knowledge base: directory path, markdown file counts by category, and search index metadata.

## Usage

```bash
gnosys web status
gnosys web status --json
```

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output status as JSON |

## Behavior

1. Loads `gnosys.json` and resolves the knowledge directory from `web.outputDir` (default `./knowledge`).
2. If the directory is missing, reports that state and suggests `gnosys web init`.
3. Otherwise recursively scans for `.md` files and counts them by category subdirectory.
4. Reads `gnosys-index.json` when present for document count, file size, and `generated` timestamp.
5. If index JSON is invalid, reports size only.

## Missing directory

Human:

```text
Knowledge directory not found: /path/to/knowledge
Run 'gnosys web init' to get started.
```

JSON:

```json
{
  "ok": true,
  "exists": false,
  "message": "Knowledge directory not found"
}
```

## Human output

```text
Web Knowledge Base Status:
  Directory: /path/to/knowledge
  Total files: 12
  By category:
    blog: 8
    docs: 4
  Index: 12 docs, 45.2KB
  Last built: 2026-05-26T12:00:00.000Z
```

When the index has not been built:

```text
  Index: not built (run 'gnosys web build-index')
```

## JSON output

```json
{
  "ok": true,
  "knowledgeDir": "/path/to/knowledge",
  "totalFiles": 12,
  "categoryCounts": {
    "blog": 8,
    "docs": 4
  },
  "index": {
    "exists": true,
    "documentCount": 12,
    "size": 46284,
    "generated": "2026-05-26T12:00:00.000Z"
  }
}
```

## Errors

On failure, prints JSON `{ "ok": false, "error": "..." }` with `--json`, or `Web status failed: ...` on stderr otherwise, then exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- web status --help
npx vitest run src/test/web-status-command-handler.test.ts
```

## Related commands

- `gnosys web init` — create knowledge directory and config.
- `gnosys web build-index` — build or rebuild the search index.
