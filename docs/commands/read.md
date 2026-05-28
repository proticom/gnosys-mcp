# gnosys read

Read a specific memory by ID or path.

## Usage

```bash
gnosys read deci-001
gnosys read project:decisions/auth.md
gnosys read deci-001 --json
```

## Memory path formats

- **Short ID** — e.g. `deci-001`
- **Layer prefix** — e.g. `project:decisions/auth.md`, `user:preferences/coding-style.md`
- Paths resolve against the central SQLite brain first, then fall back to configured store files on disk.

## Lookup order

1. **Central DB** — Opens `~/.gnosys/gnosys.db` and calls `getMemory(memoryPath)`. On hit, formats the row as synthetic YAML frontmatter plus body, prefixed with `[Source: gnosys.db]`.
2. **Resolver / file fallback** — If the central DB has no match, uses `resolver.readMemory(memoryPath)` and reads the memory file from disk. Human output includes `[Source: <label>]` before the raw file contents.

The central DB connection is closed after the DB lookup attempt (whether or not a row was found).

## Options

| Option | Description |
|--------|-------------|
| `--json` | Output a JSON object instead of human-readable text |

## Human output

Central DB hits include generated frontmatter fields: `id`, `title`, `category`, `tags`, `relevance`, `author`, `authority`, `confidence`, `status`, `tier`, `created`, `modified`, and when present `source_file` (with optional page), and `source_path`.

File fallback prints the source label line, then the raw markdown file unchanged.

## JSON output

With `--json`, output is a single JSON object:

- **DB hit:** `{ path, source: "gnosys.db", content, memory }` where `content` includes the `[Source: gnosys.db]` prefix and synthetic frontmatter.
- **File hit:** `{ path, source, content }` where `source` is the resolver label and `content` is the raw file text.

## Not found

If neither the central DB nor the resolver finds the memory:

```text
Memory not found: <memoryPath>
```

The process exits with code 1.

## Platform notes

- Central DB lookup requires a readable `~/.gnosys/gnosys.db`; if unavailable, lookup falls through to resolver/file paths.
- Layer-prefixed paths follow the same resolver rules as other read/search commands.

## Validation

```bash
cd gnosys-public
npm run cli -- read --help
```

## Related commands

- `gnosys discover` — find memories by keyword before reading one.
- `gnosys search` — full-text search across memories.
