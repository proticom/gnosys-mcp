# gnosys web

Parent command for the Gnosys web knowledge base — crawl websites or local content, generate searchable markdown knowledge files, and build a search index.

## Usage

```bash
gnosys web
gnosys web init
gnosys web ingest
gnosys web build
gnosys web status
```

Bare `gnosys web` (no subcommand) prints Commander help for the available subcommands. The parent command has no runtime `.action(...)` — all behavior lives in the leaf subcommands below.

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `init` | Interactive setup for the web knowledge base |
| `ingest` | Crawl the configured source and generate knowledge markdown files |
| `build-index` | Generate search index JSON from the knowledge directory |
| `build` | Run ingest + build-index in one shot |
| `add <url>` | Ingest a single URL into the knowledge base |
| `remove <filepath>` | Remove a knowledge file and rebuild the index |
| `update <urlOrPath>` | Re-ingest a URL or refresh a knowledge file |
| `status` | Show the current state of the web knowledge base |

See the leaf command docs for options, output, and error handling:

- [`gnosys web init`](web-init.md)
- [`gnosys web ingest`](web-ingest.md)
- [`gnosys web build-index`](web-build-index.md)
- [`gnosys web build`](web-build.md)
- [`gnosys web add`](web-add.md)
- [`gnosys web remove`](web-remove.md)
- [`gnosys web update`](web-update.md)
- [`gnosys web status`](web-status.md)

## Validation

```bash
cd gnosys-public
npm run cli -- web --help
npm run cli -- web init --help
```
