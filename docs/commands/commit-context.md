# gnosys commit-context

Pre-compaction sweep: extract atomic memories from a conversation or context string, check novelty against existing memories, and commit novel ones to the central DB.

## Usage

```bash
gnosys commit-context "Decision: use SQLite as source of truth"
gnosys commit-context "Meeting notes with durable decisions..." --dry-run
gnosys commit-context "Architecture notes..." --store project
```

## Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be committed without writing |
| `-s, --store <store>` | Writable store for config/tag registry resolution (`project`, `personal`, `global`) |

`--store` selects the writable store used for config and tag registry resolution in this command. Committed memories are inserted with the current project context (`scope: project`); it does not change central DB scope to personal/global in the current implementation.

## Behavior

1. **Store resolution** — requires a writable store; exits if none found.
2. **LLM extraction** — uses structuring provider to extract JSON array of candidates (summary, type, search_terms).
3. **Novelty check** — builds search index from active stores; skips candidates that overlap existing memories.
4. **Commit** — for novel candidates, structures via `GnosysIngestion` and inserts into central DB (unless `--dry-run`).
5. **Dry run** — prints `WOULD ADD` lines without DB writes; summary uses `DRY RUN` mode label.
6. **Duplicates** — prints `SKIP` with overlapping memory title.
7. **Summary** — `COMMITTED` or `DRY RUN` line with candidate/add/skip counts.

## Output example

```text
Extracting knowledge candidates from context...
Found 3 candidates. Checking novelty...

  ➕ ADDED: "Use SQLite as source of truth"
    ID: deci-012

  ⏭ SKIP: "Prefer TypeScript"
    Overlaps with: TypeScript as implementation language

COMMITTED: 3 candidates, 1 added, 1 duplicates skipped.
```

## Error cases

- No writable store
- No LLM provider available
- LLM output not valid JSON
- No extractable knowledge (empty candidate array)

## Platform notes

### macOS / Linux / Windows

- Pass context as a quoted string in the shell.
- Requires central DB and LLM provider configured.

## Validation

```bash
cd gnosys-public
npm run cli -- commit-context --help
```

## Related commands

- `gnosys add` — add a single memory directly.
- `gnosys search` — discover existing memories manually.
