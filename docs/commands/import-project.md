# gnosys import project

Restore a portable `.json.gz` project bundle created by `gnosys export project` into the central DB.

## Usage

```bash
gnosys import project ./my-project.gnosys.json.gz
gnosys import project ./bundle.gnosys.json.gz --strategy replace
gnosys import project ./bundle.gnosys.json.gz --working-directory /path/to/project --json
```

## Options

| Option | Description |
|--------|-------------|
| `--strategy <strategy>` | Conflict handling: `merge` (default), `replace`, or `new-id` |
| `--working-directory <dir>` | Override the bundle's `working_directory` (e.g. when restoring on a different machine) |
| `--json` | Output the result as JSON |

## Behavior

1. Validates `--strategy` before opening the central DB.
2. Opens the central DB via `GnosysDB.openCentral()`.
3. Resolves `bundlePath` with `path.resolve()`.
4. Calls `importProject(centralDb, { bundlePath, strategy, workingDirectoryOverride })`.
5. Prints human summary or JSON.
6. Closes central DB in `finally`.

## Human output

```text
Imported project my-project (my-project)
  Strategy:        merge
  Memories:        42 inserted, 3 skipped, 0 replaced
  Relationships:   12
  Audit entries:   88
```

## JSON output

Full `importProject` result object when `--json` is set.

## Errors

Invalid strategy (validated before DB open):

```text
Invalid strategy: foo. Use one of: merge, replace, new-id
```

Central DB unavailable:

```text
Central DB unavailable.
```

Import failures (malformed bundle, unsupported version, etc.):

```text
Import failed: <message>
```

Failure paths use `process.exitCode = 1` and close the DB in `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- import project --help
npx vitest run src/test/import-project-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys import`](import.md) — parent command (bulk CSV/JSON/JSONL import).
- [`gnosys export project`](export-project.md) — create a portable project bundle.
- [`gnosys export vault`](export-vault.md) — Obsidian markdown vault export.
