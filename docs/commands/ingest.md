# gnosys ingest

Ingest a local file (PDF, DOCX, TXT, MD, etc.) into Gnosys memory. Extracts text, splits into chunks, and creates atomic memories.

## Usage

```bash
gnosys ingest ./notes.md
gnosys ingest ./whitepaper.pdf --mode llm --store project
gnosys ingest ./notes.txt --mode structured --dry-run
gnosys ingest ignored --list-attachments --store project
gnosys ingest notes.md --directory /path/to/project
```

## Options

| Option | Description |
|--------|-------------|
| `--mode <mode>` | Ingestion mode: `llm` (default) or `structured` |
| `-s, --store <store>` | Target store: `project`, `personal`, or `global` |
| `-a, --author <author>` | Author (default `human`) |
| `--authority <authority>` | Authority level (default `imported`) |
| `--dry-run` | Preview without writing memories |
| `--list-attachments` | List stored attachments instead of ingesting |
| `-d, --directory <dir>` | Base directory for resolving the file path |

## Behavior

### File ingestion (default)

- The `<fileOrGlob>` argument is resolved as a **single local path** relative to `--directory` or the current working directory. Despite the argument name, **glob expansion is not performed** in the current CLI implementation.
- Exits with `File not found: <path>` when the resolved path does not exist.
- Requires a writable store; exits with `No writable store found...` otherwise.
- Runs `ingestFile` with progress output, then prints file type, attachment info, duration, created memories (with paths), and chunk errors.

### List attachments (`--list-attachments`)

- Ignores the file argument for ingestion purposes.
- Lists attachments in the writable store: name, size, UUID, hash prefix, linked memory IDs, created date.
- Prints `No attachments found.` when empty.

## Output example

```text
Ingesting: whitepaper.pdf

File type: pdf
Attachment: whitepaper.pdf (a1b2c3d4...)
Duration: 12.3s
Memories created: 5

Memories:
  memo-001: Introduction [page 1]
    Path: ...
```

## Platform notes

### macOS / Linux

- Use relative or absolute paths; `--directory` sets the base for relative paths.
- Quote paths with spaces.

### Windows

- Backslashes in paths are supported via `path.resolve`.
- Quote paths in PowerShell when they contain spaces.

## Validation

```bash
cd gnosys-public
npm run cli -- ingest --help
```

## Related commands

- `gnosys add` — add a single note or file via a simpler entry point.
- `gnosys ingest` (MCP) — separate MCP tool surface; this doc covers the CLI command only.
