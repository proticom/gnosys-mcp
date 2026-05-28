# gnosys export project

Export a single registered Gnosys project to a portable `.json.gz` bundle (round-trips with `gnosys import project`).

## Usage

```bash
gnosys export project --to ./project.gnosys.json.gz
gnosys export project my-project --to ./project.gnosys.json.gz
gnosys export project my-project --to ./bundle.gnosys.json.gz --include-archived --no-audit --json
```

When `projectId` is omitted, the command auto-detects from the current working directory's registry entry.

## Options

| Option | Description |
|--------|-------------|
| `--to <file>` | Output bundle path (required) |
| `--include-archived` | Include archived and superseded memories (default: active only) |
| `--no-audit` | Skip audit log in the bundle |
| `--json` | Output result as JSON |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Resolves `projectId` from argument or `getProjectByDirectory(process.cwd())`.
3. Calls `exportProject(centralDb, { projectId, outputPath, includeArchived, includeAudit })`.
4. Prints human summary or JSON.
5. Closes central DB in `finally`.

## Human output

```text
Exported project my-project
  Memories:      142
  Archived:      3 excluded — re-run with --include-archived for a full backup
  Relationships: 28
  Audit entries: 512
  Bundle:        /path/to/project.gnosys.json.gz
  Size:          45.2 KB compressed (12.3% of 367.1 KB)
```

## JSON output

Full `exportProject` result object when `--json` is set.

## Errors

Central DB unavailable:

```text
Central DB unavailable.
```

No project ID and cwd not registered:

```text
No project ID given and current directory is not a registered project.
Usage: gnosys export project <projectId> --to <file>
```

Validation failures after DB open use `process.exitCode = 1`.

## Validation

```bash
cd gnosys-public
npm run cli -- export project --help
npx vitest run src/test/export-command-handler.test.ts
node scripts/audit-commands.mjs --write
```

## Related commands

- [`gnosys export`](export.md) — parent command overview.
- [`gnosys export vault`](export-vault.md) — Obsidian markdown vault export.
- `gnosys import project` — restore a project bundle.
