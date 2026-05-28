# gnosys add

Add a new memory from raw text or an existing file path.

## Usage

```bash
gnosys add "Decision: use SQLite as source of truth"
gnosys add ./whitepaper.pdf --author human --authority imported --store project
gnosys add ./meeting-notes.txt --store personal
gnosys add "Quick note" -a human --authority declared
```

## Options

| Option | Description |
|--------|-------------|
| `-a, --author <author>` | Author: `human`, `ai`, or `human+ai` (default `human`) |
| `--authority <authority>` | Authority: `declared`, `observed`, `imported`, or `inferred` (default `declared`) |
| `-s, --store <store>` | Target store: `project`, `personal`, or `global` |

## Behavior

### Raw text input

When `<input>` is not an existing file path:

- Requires a writable store and an available LLM provider.
- Loads the tag registry and structures the text via `GnosysIngestion`.
- Inserts the memory into the central DB with generated ID, category, tags, and confidence.
- Prints memory metadata and any proposed new tags not yet in the registry.

### File path input

When `<input>` exists on disk:

- Routes through multimodal ingestion (`ingestFile`, mode `llm`).
- Prints file type, memory count, duration, memory IDs/titles, and chunk errors if any.
- Does not require the raw-text LLM structuring path (uses file ingestion pipeline).

### Common

- Exits with `No writable store found...` when no writable store matches `--store` (or default resolution).
- Exits with LLM unavailable error for raw text when no provider is configured.

## Output example (raw text)

```text
Structuring memory via LLM...

Memory added to [project]: Decision: use SQLite as source of truth
ID: deci-001
Category: decisions
Confidence: 0.85
```

## Platform notes

### macOS

- File paths may be relative or absolute; `existsSync` determines file vs text routing.
- PDF and other supported formats use the multimodal pipeline.

### Linux

- Quote inputs with spaces: `gnosys add "my note here"`.
- Ensure `GNOSYS_PERSONAL` or project `.gnosys` exists for writable store.

### Windows

- Use quoted paths for files: `gnosys add "C:\docs\notes.pdf"`.
- Backslashes in paths are resolved by Node.

## Validation

```bash
cd gnosys-public
npm run cli -- add --help
```

## Related commands

- `gnosys add-structured` — add a memory with explicit structured fields.
- `gnosys ingest` — batch or URL-based ingestion workflows.
