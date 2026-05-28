# gnosys check

Test LLM connectivity for each configured task route.

## Usage

```bash
gnosys check
gnosys check --task structuring
gnosys check --task synthesis
gnosys check --task chat
gnosys check --task vision
gnosys check --task transcription
gnosys check --task dream
```

## Options

| Option | Description |
|--------|-------------|
| `-t, --task <name>` | Test only one task instead of all six |

## Supported task names

| Task | Purpose |
|------|---------|
| `structuring` | Adding memories, tagging |
| `synthesis` | Q&A answers (`gnosys ask`) |
| `chat` | Interactive chat (`gnosys chat`; uses synthesis model) |
| `vision` | Images, PDFs |
| `transcription` | Audio files |
| `dream` | Overnight consolidation |

## Config resolution

1. Loads project config from `.gnosys/` in the current working directory when it differs from defaults.
2. Otherwise falls back to global config in `~/.gnosys/`.
3. Prints which config path was used in the header.

## Output states

Each task line shows provider/model, then one of:

- **✓ connected** — `testConnection()` succeeded; latency in ms is shown
- **✗ failed** — provider unavailable (missing API key) or connection error
- **⚠ disabled** — dream task when `dream.enabled` is false (skipped, not counted as failure)

## Summary line

When all checked tasks pass:

```text
✓ All 5/5 tasks connected.
```

When some fail:

```text
3/6 connected, 2 failed, 1 skipped.

Fix: Run 'gnosys setup' to configure providers and API keys.
```

## Errors

Unknown `--task` name:

```text
Unknown task: foo. Pick one of: structuring, synthesis, chat, vision, transcription, dream
```

Exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- check --help
npx vitest run src/test/check-command-handler.test.ts
```

## Related commands

- `gnosys doctor` — broader system health check (stores, embeddings, archive).
- `gnosys setup` — configure providers and API keys.
- `gnosys config show` — inspect current task routing.
