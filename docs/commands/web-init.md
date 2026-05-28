# gnosys web init

Interactive setup for the web knowledge base.

## Usage

```bash
gnosys web init
gnosys web init --source directory --output ./knowledge --non-interactive
gnosys web init --no-config --json
```

## Options

| Option | Description |
|--------|-------------|
| `--source <type>` | Source type: `sitemap`, `directory`, or `urls` (default `sitemap`) |
| `--output <dir>` | Output directory for knowledge files (default `./knowledge`) |
| `--no-config` | Skip `gnosys.json` modification |
| `--non-interactive` | Skip prompts and use defaults |
| `--json` | Output machine-readable JSON |

## Behavior

1. Resolves store path via project stores (falls back to `.gnosys` in cwd).
2. **Interactive mode** (TTY, not `--non-interactive`, not `--json`): prompts for sitemap URL, LLM enrichment, CI/CD env var name, and output directory.
3. Detects agent LLM provider from config and maps to env var names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.).
4. Creates the output directory with `mkdirSync(outputDir, { recursive: true })`.
5. When config updates are enabled (`opts.config`, default unless `--no-config`), writes `web` section to `gnosys.json` if absent: `source`, `sitemapUrl`, `outputDir`, `exclude`, `categories`, `llmEnrich`, `prune`.
6. Prints human success output with next steps, or JSON success/error shape.

## JSON success output

```json
{
  "ok": true,
  "outputDir": "./knowledge",
  "source": "sitemap",
  "sitemapUrl": null,
  "llmEnrich": true,
  "envVarName": "ANTHROPIC_API_KEY"
}
```

## JSON error output

```json
{
  "ok": false,
  "error": "message"
}
```

## Human success output

```text
✓ Created ./knowledge/
✓ Updated gnosys.json with web config
✓ LLM enrichment: enabled
✓ CI/CD env var: ANTHROPIC_API_KEY

Next steps:
  ...
```

Errors exit with code 1 (`Web init failed: ...` in human mode).

## Validation

```bash
cd gnosys-public
npm run cli -- web init --help
npx vitest run src/test/web-init-command-handler.test.ts
```

## Related commands

- `gnosys web ingest` — crawl configured source and generate knowledge files.
- `gnosys web build` — build the search index.
