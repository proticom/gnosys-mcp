# gnosys web remove

Remove a knowledge file and rebuild the search index.

## Usage

```bash
gnosys web remove blog/example-page.md
gnosys web remove services/foo.md --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `filepath` | Path relative to the knowledge directory (absolute paths and `../` traversal are rejected) |

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output result as JSON |

## Behavior

1. Loads config from the active web store path.
2. Resolves knowledge directory: `web.outputDir` or `./knowledge`.
3. Resolves full path with `path.resolve(knowledgeRoot, filepath)`.
4. Rejects absolute `filepath` input and any resolved path outside the knowledge directory.
5. Exits with `File not found: <path>` if the contained file does not exist.
6. Deletes the file and rebuilds index to `<knowledgeRoot>/gnosys-index.json`.

## Human output

```text
Removed: blog/example-page.md
Index rebuilt: 41 documents
```

## JSON output

```json
{
  "ok": true,
  "removed": "blog/example-page.md",
  "documentCount": 41
}
```

On error with `--json`:

```json
{
  "ok": false,
  "error": "File not found: /path/to/file"
}
```

## Validation

```bash
cd gnosys-public
npm run cli -- web remove --help
npx vitest run src/test/web-remove-command-handler.test.ts
```

## Related commands

- `gnosys web add` — ingest a single URL.
- `gnosys web build-index` — rebuild index without deleting files.
